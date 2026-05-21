/**
 * Chat routes — SSE streaming chat with AI agent.
 *
 * POST /api/chat   — send message, returns SSE stream
 * GET  /api/messages  — load saved messages
 * POST /api/messages  — save messages
 */

import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { validateSession } from "../auth";
import { PerUserAgentManager } from "../agent/manager";
import { LLMClient } from "../agent/llm";
import { shouldCompact, compactContext, microCompactMessages } from "../agent/compact";
import { clearUserActions, drainUserActions } from "../tools/frontend-actions";
import { runWithUserId } from "../request-context";

const CHAT_DATA_DIR = path.resolve(process.cwd(), "data", "chat");

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function getMessagesPath(userId: string): string {
  ensureDir(CHAT_DATA_DIR);
  return path.join(CHAT_DATA_DIR, `${userId}.json`);
}

export function loadMessages(userId: string): Array<{ role: string; content: string; reasoning_content?: string }> {
  try {
    const filePath = getMessagesPath(userId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { /* ignore */ }
  return [];
}

export function saveMessages(userId: string, messages: Array<{ role: string; content: string; reasoning_content?: string }>) {
  try {
    fs.writeFileSync(getMessagesPath(userId), JSON.stringify(messages, null, 2), "utf-8");
  } catch { /* ignore */ }
}

/** Sanitize history: remove corrupted messages that would cause API errors */
function sanitizeHistory(history: Array<any>): Array<any> {
  return history.filter((msg, i) => {
    // Must have role
    if (!msg || !msg.role) return false;
    // Assistant messages with null/empty content AND no tool_calls are invalid
    if (msg.role === "assistant" && (!msg.content || msg.content === "") && !msg.tool_calls) {
      console.log(`    [SANITIZE] Removing corrupted assistant msg #${i}: empty content, no tool_calls`);
      return false;
    }
    // Tool messages must have content
    if (msg.role === "tool" && (!msg.content || msg.content === "")) {
      console.log(`    [SANITIZE] Removing corrupted tool msg #${i}: empty content`);
      return false;
    }
    return true;
  });
}

/** Normalize segments format to flat {role, content} for backward compat */
function normalizeToFlatFormat(msg: any): { role: string; content: string; reasoning_content?: string } {
  // Already flat format
  if (msg.content !== undefined && !msg.segments) {
    return { role: msg.role, content: msg.content, reasoning_content: msg.reasoning_content };
  }
  // Extract text from segments
  if (msg.segments) {
    const texts = msg.segments
      .filter((s: any) => s.type !== "tool_call")
      .map((s: any) => s.data)
      .join("\n");
    return { role: msg.role, content: texts, reasoning_content: msg.reasoning_content };
  }
  // Fallback
  return { role: msg.role, content: msg.content || "" };
}

function getUserId(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const session = validateSession(token);
  return session ? session.userId : null;
}

export function createChatRoutes(
  agentManager: PerUserAgentManager,
): Router {
  const router = Router();

  /** POST /api/chat — SSE streaming chat */
  router.post("/api/chat", async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }

    const { message, context } = req.body || {};
    if (!message) {
      res.status(400).json({ error: "Message cannot be empty" });
      return;
    }

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    try {
      const agent = agentManager.getAgent(userId);

      // Load past messages into agent context
      let history = loadMessages(userId);

      // Auto-compact if history is too large
      if (history.length > 0 && shouldCompact(history)) {
        console.log(
          `    [COMPACT] History too large (${history.length} msgs), auto-compacting...`,
        );
        try {
          const compactLLM = new LLMClient();
          history = await compactContext(history, compactLLM);
          saveMessages(userId, history);
          console.log(`    [COMPACT] Compressed to ${history.length} msgs`);
        } catch (e) {
          // Fallback: compact without LLM
          history = await compactContext(history);
          saveMessages(userId, history);
        }
      }

      // Apply micro-compact on tool results before loading into agent
      microCompactMessages(history as any);

      // Sanitize: remove corrupted messages that would cause API errors
      const sanitized = sanitizeHistory(history);
      if (sanitized.length !== history.length) {
        console.log(`    [SANITIZE] Removed ${history.length - sanitized.length} corrupted messages, saving clean history`);
        saveMessages(userId, sanitized);
        history = sanitized;
      }

      if (history.length > 0) {
        agent.loadHistory(history);
      }

      // Clear per-user frontend action queue before run
      clearUserActions(userId);

      // Check for pending notifications — drain and inject as user messages
      const notifications = agentManager.drainNotifications(userId);
      let actualMessage = message;
      if (notifications.length > 0) {
        const notifText = notifications.map(n => {
          const time = new Date(n.timestamp).toLocaleString('zh-CN');
          let text = `📬 [定时任务通知] ${n.label} (${time})\n`;
          text += `状态: ${n.status === 'completed' ? '✅ 成功' : '❌ 失败'}\n`;
          text += `策略: ${n.strategies}\n`;
          text += `命中: ${n.matchedCount} / ${n.totalCount}\n`;
          if (n.topResults?.length > 0) {
            text += `前 ${n.topResults.length} 名:\n`;
            for (const s of n.topResults) {
              text += `  ${s.code} ${s.name} (评分: ${s.score.toFixed(2)})\n`;
            }
          }
          if (n.errorMessage) text += `错误: ${n.errorMessage}\n`;
          return text;
        }).join('\n---\n');

        // Inject as a user message before the real one
        if (history.length > 0) {
          agent.loadHistory(history);
        }
        // Run the notification message first, then the actual user message
        // We'll make the first turn about the notification, then process the user message
        actualMessage = `[系统通知]\n${notifText}\n\n---\n\n用户消息: ${message}`;
      }

      // Run agent with streaming — inside per-user AsyncLocalStorage context
      // This ensures tools (run_screen, schedule, etc.) can read getCurrentUserId()
      const result = await runWithUserId(userId, async () => {
        return await agent.run(
          actualMessage,
          // onToken
          (token: string) => {
            res.write(`data: ${JSON.stringify({ type: "token", content: token })}\n\n`);
          },
          // onReasoning
          (token: string) => {
            res.write(`data: ${JSON.stringify({ type: "reasoning", content: token })}\n\n`);
          },
          // onToolCall
          (tc: { id: string; name: string; arguments: string }) => {
            const safeArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
            try { res.write(`data: ${JSON.stringify({ type: "tool_call", id: String(tc.id || ''), name: String(tc.name || ''), arguments: safeArgs })}\n\n`); } catch(e) {}
          },
          // onTurnStart
          (turn: number) => {
            res.write(`data: ${JSON.stringify({ type: "turn", turn })}\n\n`);
          },
          // onToolResult
          (name: string, content: string) => {
            try { res.write(`data: ${JSON.stringify({ type: "tool_result", name, content })}\n\n`); } catch(e) {}
          },
        );
      });

      // Send frontend actions (run_screen results) for THIS user only
      const userActions = drainUserActions(userId);
      for (const action of userActions) {
        res.write(`data: ${JSON.stringify({ type: "action", action: action.type, payload: action.payload })}\n\n`);
      }

      // Check if max turns reached
      const finalContent = result.response === "Reached maximum turns without final response."
        ? "Conversation has exceeded maximum turn limit (25), please start a new conversation"
        : result.response;

      // Save conversation history (user + assistant messages)
      const chatHistory = loadMessages(userId);
      chatHistory.push({ role: "user", content: message });
      chatHistory.push({ role: "assistant", content: finalContent });
      saveMessages(userId, chatHistory);

      // Send done event
      res.write(`data: ${JSON.stringify({ type: "done", content: finalContent })}\n\n`);
      res.write("data: [DONE]\n\n");
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      res.write(`data: ${JSON.stringify({ type: "error", content: errMsg })}\n\n`);
    } finally {
      res.end();
    }
  });

  /** GET /api/messages — load saved messages */
  router.get("/api/messages", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    const messages = loadMessages(userId);
    res.json({ messages });
  });

  /** POST /api/messages — save messages */
  router.post("/api/messages", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: "messages must be an array" });
      return;
    }
    // Normalize segments → flat format for backward compat
    const flat = messages.map(normalizeToFlatFormat);
    saveMessages(userId, flat);
    res.json({ status: "ok" });
  });

  return router;
}
