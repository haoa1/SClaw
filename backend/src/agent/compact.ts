/**
 * Context Compactor — auto-compresses chat history when it grows too large.
 *
 * Ported from Garuda's Layer 2/3 compact strategy:
 *   Layer 3 (Semantic Compact): summarize old messages via LLM, keep recent ones intact
 *   Layer 2 (Micro-Compact): content-aware truncation of long tool results
 *
 * Integrated into chat flow: loads history → checks size → auto-compacts → loads into agent.
 */

import { LLMClient, LLMMessage } from "./llm";

// ============================================================================
// Thresholds
// ============================================================================

/** If history has more messages than this, trigger compact */
const COMPACT_THRESHOLD = 20;

/** Keep this many most-recent messages intact after compact */
const COMPACT_KEEP_RECENT = 10;

/** Max chars for the LLM summarizer input */
const SUMMARY_INPUT_MAX_CHARS = 20_000;

/** Timeout for LLM summarization (seconds) */
const COMPACT_TIMEOUT = 15;

/** Max chars for a single tool result before micro-compact kicks in */
const MICRO_COMPACT_TOOL_CHARS = 5_000;

/** Max lines before micro-compact kicks in */
const MICRO_COMPACT_TOOL_LINES = 150;

// ============================================================================
// Summary Prompts
// ============================================================================

const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要生成器。你的任务是把一段对话历史压缩成简洁的结构化摘要。

要求：
- 用中文输出
- 保留所有关键信息（用户意图、选股策略、股票代码、分析结论等）
- 不要遗漏重要的上下文
- 格式：用 <analysis> 和 <summary> 标签包裹

<analysis>
分析这段对话发生了什么：
- 用户的核心需求是什么
- 讨论了哪些股票/策略/指标
- 执行了哪些操作（筛选、分析、对比等）
- 有什么重要的结果或结论
</analysis>
<summary>
1. **用户需求** — 用户想做什么
2. **讨论内容** — 涉及的股票、策略、参数
3. **操作与结果** — 执行了哪些操作，得到了什么结果
4. **关键信息** — 有用的股票代码、估值数据、筛选条件等
5. **当前状态** — 已完成什么，还有什么待办
</summary>`;

// ============================================================================
// Public API
// ============================================================================

export interface ChatMessage {
  role: string;
  content: string;
  reasoning_content?: string;
}

/**
 * Check if history needs compaction.
 */
export function shouldCompact(messages: ChatMessage[]): boolean {
  return messages.length > COMPACT_THRESHOLD;
}

/**
 * Auto-compact context: summarize old messages, keep recent ones.
 *
 * If an LLM client is provided, uses it for semantic summarization.
 * Falls back to a text-based summary if LLM is unavailable or fails.
 *
 * Returns the compacted message array (new array, doesn't mutate input).
 */
export async function compactContext(
  messages: ChatMessage[],
  llmClient?: LLMClient,
): Promise<ChatMessage[]> {
  if (!shouldCompact(messages)) return messages;

  const splitIdx = Math.max(0, messages.length - COMPACT_KEEP_RECENT);
  const oldMessages = messages.slice(0, splitIdx);
  const recentMessages = messages.slice(splitIdx);

  // Try LLM summarization first, with fallback
  let summary: string;
  if (llmClient) {
    try {
      summary = await summarizeWithLLM(oldMessages, llmClient);
    } catch {
      summary = fallbackSummary(oldMessages);
    }
  } else {
    summary = fallbackSummary(oldMessages);
  }

  // Build compacted history: summary as user message + recent messages
  const compacted: ChatMessage[] = [
    {
      role: "assistant",
      content: `## Compacted Conversation Summary\n\n${summary}\n\n---\n*Previous conversation compressed. Recent messages preserved below.*`,
    },
    {
      role: "user",
      content:
        "收到，请继续。以上是之前的对话摘要，下面是最近的对话记录。",
    },
    ...recentMessages,
  ];

  return compacted;
}

/**
 * Micro-Compact: compress long tool results in the message list.
 * Runs before each API call to shrink oversized content.
 */
export function microCompactMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  let freed = 0;

  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const content = msg.content;
    if (!content || content.length < 500) continue;

    const originalLen = content.length;
    const lines = content.split("\n");

    if (lines.length > MICRO_COMPACT_TOOL_LINES) {
      // Head + tail truncation (matching Garuda's micro-compact)
      const head = lines.slice(0, 60);
      const tail = lines.slice(-30);
      const compressed = lines.length - 90;
      msg.content =
        head.join("\n") +
        `\n\n[... ${compressed} lines compressed — use a more targeted query to see full output]\n\n` +
        tail.join("\n");
    } else if (content.length > MICRO_COMPACT_TOOL_CHARS) {
      msg.content =
        content.slice(0, MICRO_COMPACT_TOOL_CHARS) +
        `\n\n[... truncated by Micro-Compact, original length: ${content.length} chars]`;
    }

    freed += originalLen - msg.content.length;
  }

  if (freed > 0) {
    console.log(
      `    [MICRO-COMPACT] Freed ~${Math.round(freed / 4)} tokens by compressing tool results`,
    );
  }

  return messages;
}

// ============================================================================
// Internals
// ============================================================================

/**
 * Use LLM to generate a structured summary of old messages.
 * Matches Garuda's _summarize_with_llm() + _summarize_with_timeout().
 */
async function summarizeWithLLM(
  messages: ChatMessage[],
  llmClient: LLMClient,
): Promise<string> {
  const formatted = formatForSummary(messages);

  const summaryRequest: LLMMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `需要摘要的对话历史：\n\n${formatted}`,
    },
  ];

  // Timeout-safe LLM call (matching Garuda's threading-based timeout)
  const result = await Promise.race([
    llmClient.chat(summaryRequest, []),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Summary timeout")),
        COMPACT_TIMEOUT * 1000,
      ),
    ),
  ]);

  const summary = (result as any).content || "";
  console.log(
    `    [COMPACT] Summary generated (${summary.length} chars)`,
  );
  return summary;
}

/**
 * Format messages for the summarization prompt, truncated to limit.
 */
function formatForSummary(
  messages: ChatMessage[],
  maxChars: number = SUMMARY_INPUT_MAX_CHARS,
): string {
  const parts: string[] = [];
  let total = 0;

  for (const msg of messages) {
    const role = msg.role || "?";
    const content = (msg.content || "").slice(0, 1000);
    const line = `[${role}]: ${content}\n`;

    if (total + line.length > maxChars) {
      parts.push(
        `... [截断 — 共 ${messages.length} 条消息，显示 ${parts.length}/${messages.length}]`,
      );
      break;
    }
    parts.push(line);
    total += line.length;
  }

  return parts.join("");
}

/**
 * Fallback text summary when LLM summarization fails or times out.
 * Matches Garuda's _fallback_summary().
 */
function fallbackSummary(messages: ChatMessage[]): string {
  const userCount = messages.filter((m) => m.role === "user").length;
  const toolCalls = messages.filter(
    (m) => m.role === "assistant" && m.content.includes("[Tool:"),
  ).length;

  return (
    `**History compressed — ${messages.length} messages summarised:**\n` +
    `- User messages: ${userCount}\n` +
    `- Assistant tool calls: ${toolCalls}\n` +
    `- Stock screening operations, strategy discussions, and analyses were conducted during this session.\n\n` +
    `*(Full detail available in logs)*\n`
  );
}
