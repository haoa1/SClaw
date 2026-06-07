import { LLMClient, LLMMessage, ToolCall } from "./llm";
import { ToolRegistry } from "../tools/registry";
import { Memory } from "../memory/memory";
import { compactContext, estimateTotalTokens } from "./compact";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface AgentConfig {
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  verbose?: boolean;
  soulPath?: string;
  debug?: boolean;       // dump prompt to file before each LLM call
  debugDir?: string;     // where to dump debug files
}

export class Agent {
  private messages: LLMMessage[] = [];
  private llm: LLMClient;
  private tools: ToolRegistry;
  private memory: Memory;
  private config: Required<AgentConfig>;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** Loaded skills: name → markdown content */
  private loadedSkills = new Map<string, string>();
  /** Callback to notify frontend of prompt dumps (debug mode) */
  private onDebugPrompt?: (dump: {filePath: string; messageCount: number; totalTokens: number}) => void;

  constructor(
    tools: ToolRegistry,
    memory: Memory,
    config: AgentConfig = {}
  ) {
    this.tools = tools;
    this.memory = memory;
    this.llm = new LLMClient();
    this.config = {
      systemPrompt:
        config.systemPrompt ??
        `You are a helpful AI assistant with access to tools.
You help the user manage their stock screening strategies.
You can read files, write files, run commands, search for files, and search within files.
Use tools when you need to perform actions. Be concise and helpful.`,
      model: config.model ?? process.env["LLM_MODEL"] ?? "",
      maxTurns: config.maxTurns ?? 1000,
      verbose: config.verbose ?? false,
      soulPath: config.soulPath ?? path.join(os.homedir(), '.sclaw', 'workspace', 'SOUL.md'),
      debug: config.debug ?? false,
      debugDir: config.debugDir ?? path.join(os.homedir(), '.sclaw', 'debug'),
    };
    // Inject system prompt as first message so the LLM actually receives it
    this.messages.push({ role: "system", content: this.config.systemPrompt });
    // Load SOUL.md personality on top of system prompt
    this.rebuildSystemMessage();
  }

  async run(userInput: string, onToken?: (token: string) => void, onReasoning?: (token: string) => void, onToolCall?: (tc: {id: string; name: string; arguments: string}) => void, onTurnStart?: (turn: number) => void, onToolResult?: (name: string, content: string) => void, onDebugPrompt?: (dump: {filePath: string; messageCount: number; totalTokens: number}) => void): Promise<{
    response: string;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }> {
    this.addUserMessage(userInput);
    this.onDebugPrompt = onDebugPrompt;
    let turnCount = 0;
    let totalToolCalls = 0;

    // Safety: max messages before forced compact to prevent unbounded growth
    const MAX_MESSAGES_BEFORE_COMPACT = 1000;

    while (turnCount < this.config.maxTurns) {
      turnCount++;

      // Auto-compact when context is too large instead of aborting
      if (this.messages.length > MAX_MESSAGES_BEFORE_COMPACT) {
        console.log(`  [AGENT] Messages exceeded ${MAX_MESSAGES_BEFORE_COMPACT} (${this.messages.length}), triggering compact...`);
        const totalTokens = estimateTotalTokens(this.messages);
        if (totalTokens > 100_000 || this.messages.length > MAX_MESSAGES_BEFORE_COMPACT) {
          this.messages = await compactContext(this.messages, this.llm);
          console.log(`  [AGENT] Compact completed: ${this.messages.length} messages remaining`);
          // Re-inject system message after compact (compact doesn't preserve it)
          this.rebuildSystemMessage();
        }
      }

      if (onTurnStart) onTurnStart(turnCount);

      // Debug: dump full prompt before LLM call
      this.dumpPrompt(turnCount);

      // Get LLM response (streaming or not)
      const llmResponse = onToken
        ? await this.llm.chatStream(
            this.messages,
            this.tools.toOpenAITools(),
            onToken,
            this.config.model,
            onReasoning,
            onToolCall,
          )
        : await this.llm.chat(
            this.messages,
            this.tools.toOpenAITools(),
            this.config.model
          );

      this.totalInputTokens += llmResponse.usage.input_tokens;
      this.totalOutputTokens += llmResponse.usage.output_tokens;

      // Add assistant message — with tool_calls if present
      if (llmResponse.tool_calls && llmResponse.tool_calls.length > 0) {
        // Save full assistant message including tool_calls (OpenAI format)
        // DeepSeek: content MUST be null (not empty string "") when tool_calls present
        const assistantMsg: LLMMessage = {
          role: "assistant",
          content: llmResponse.content ?? null,
          tool_calls: llmResponse.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
        // DeepSeek thinking mode: must save and pass back reasoning_content
        if (llmResponse.reasoning_content) {
          (assistantMsg as any).reasoning_content = llmResponse.reasoning_content;
        }
        this.messages.push(assistantMsg);
      } else {
        // Plain text response — no tool calls
        if (llmResponse.content) {
          const assistantMsg: LLMMessage = {
            role: "assistant",
            content: llmResponse.content,
          };
          // DeepSeek thinking mode: must save and pass back reasoning_content
          if (llmResponse.reasoning_content) {
            (assistantMsg as any).reasoning_content = llmResponse.reasoning_content;
          }
          this.addAssistantMessage(assistantMsg);
        }
      }

      // Process tool calls (if any)
      if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
        // No more tool calls — final response
        return {
          response: llmResponse.content || "",
          toolCalls: totalToolCalls,
          inputTokens: this.totalInputTokens,
          outputTokens: this.totalOutputTokens,
        };
      }

      // Reload SOUL.md + skills after each turn (user may have edited it)
      this.rebuildSystemMessage();

      // Execute each tool call, push results with proper role: "tool"
      for (const tc of llmResponse.tool_calls) {
        totalToolCalls++;
        const result = await this.executeTool(tc);
        // Emit tool result to frontend via callback
        if (onToolResult) {
          onToolResult(tc.name, result);
        }
        this.messages.push({
          role: "tool" as const,
          content: this.formatToolResult(tc.name, result),
          tool_call_id: tc.id,
        });
      }
    }

    return {
      response: "Reached maximum turns without final response.",
      toolCalls: totalToolCalls,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
    };
  }

  /** Reload SOUL.md + loaded skills - replaces system message[0] with freshest personality, instructions, and skills.
   *  Called at startup, after each agent loop turn, and on load/unload skill. */
  private rebuildSystemMessage(): void {
    try {
      const soulContent = fs.readFileSync(this.config.soulPath, 'utf-8').trim();
      let content = soulContent
        ? `${soulContent}\n\n---\n\n${this.config.systemPrompt}`
        : this.config.systemPrompt;

      // Append loaded skills
      if (this.loadedSkills.size > 0) {
        const skillsSection = Array.from(this.loadedSkills.entries())
          .map(([name, body]) => `<skill name="${name}">\n${body}\n</skill>`)
          .join('\n\n');
        content += `\n\n## Loaded Skills\n\n${skillsSection}`;
      }

      if (this.messages.length > 0 && this.messages[0].role === 'system') {
        this.messages[0].content = content;
      }
      if (this.config.verbose) console.log(`  [SOUL] Rebuilt (${this.loadedSkills.size} skills loaded)`);
    } catch {
      // SOUL.md not found or unreadable - fall through gracefully
      if (this.config.verbose) console.log('  [SOUL] No SOUL.md at ' + this.config.soulPath + ', using systemPrompt only');
    }
  }

  /** If debug mode, dump full prompt + tools to a timestamped JSON file. */
  private dumpPrompt(turn: number): void {
    if (!this.config.debug) return;
    try {
      const dir = this.config.debugDir;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `prompt-turn${turn}-${ts}.json`);
      const dump: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        turn,
        model: this.config.model,
        messageCount: this.messages.length,
        totalTokens: estimateTotalTokens(this.messages),
        tools: this.tools.toOpenAITools(),
        messages: this.messages,
      };
      fs.writeFileSync(filePath, JSON.stringify(dump, null, 2), 'utf-8');
      console.log(`  [DEBUG] Prompt dumped to ${filePath} (${this.messages.length} msgs, ${dump.totalTokens} tokens)`);
      // Notify frontend via callback
      if (this.onDebugPrompt) {
        this.onDebugPrompt({ filePath, messageCount: this.messages.length, totalTokens: dump.totalTokens as number });
      }
      // Keep at most 100 debug dumps — delete oldest beyond that
      try {
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => a.mtime - b.mtime);
        if (files.length > 100) {
          const toDelete = files.slice(0, files.length - 100);
          for (const f of toDelete) {
            fs.unlinkSync(path.join(dir, f.name));
          }
          console.log(`  [DEBUG] Cleaned ${toDelete.length} old dumps, ${files.length - toDelete.length} remaining`);
        }
      } catch (cleanupErr) {
        // Best-effort cleanup, don't fail if cleanup has issues
      }
    } catch (e) {
      console.error(`  [DEBUG] Failed to dump prompt: ${e}`);
    }
  }

  /** Load a skill: reads SKILL.md from disk and injects it into the system prompt. */
  loadSkill(name: string, content: string): string {
    if (!name || !content) return "Skill name and content are required.";
    this.loadedSkills.set(name, content);
    this.rebuildSystemMessage();
    return `Skill '${name}' loaded. Its instructions are now part of the system prompt.`;
  }

  /** Unload a skill: removes it from the system prompt. */
  unloadSkill(name: string): string {
    if (!this.loadedSkills.has(name)) {
      return `Skill '${name}' is not loaded.`;
    }
    this.loadedSkills.delete(name);
    this.rebuildSystemMessage();
    return `Skill '${name}' unloaded.`;
  }

  /** Get list of currently loaded skill names. */
  getLoadedSkills(): string[] {
    return Array.from(this.loadedSkills.keys());
  }

  /** Enable/disable debug mode (dump prompt before each LLM call). */
  setDebug(debug: boolean): void {
    this.config.debug = debug;
    if (debug) console.log(`  [DEBUG] Debug mode enabled, dumps to ${this.config.debugDir}`);
  }

  private async executeTool(tc: ToolCall): Promise<string> {
    // memory_recall: launches a sub-agent with file-reading tools to search memory
    if (tc.name === "memory_recall") {
      const query = (tc.arguments.query as string) || "";
      const limit = (tc.arguments.limit as number) || 5;
      const maxTurns = (tc.arguments.max_turns as number) || 8;
      const detailLevel = (tc.arguments.detail_level as string) || "balanced";
      if (!query) return "Please provide a query to search memory.";

      // Build sub-agent system prompt with memory architecture
      const subAgentSystemPrompt = `You are a memory search specialist. Your ONLY task is to search through memory files and find information relevant to the user's query.

## MEMORY STRUCTURE

Memory is stored in \`data/<username>/memory.json\` as a JSON array of entries. Each entry has:
- type: "strategy" | "decision" | "observation" | "error" | "result"
- timestamp: ISO date string
- content: text content
- tags: string array

## SEARCH STRATEGY
1. First read the memory file: use \`read_file\` on data/<username>/memory.json (or find it first with \`bash ls -la data/\`)
2. Use \`grep\` to search for keywords in memory files
3. Analyze the results and pick the most relevant ones
4. Summarize findings in a clear format

## AVAILABLE TOOLS
- read_file: Read files (memory files, text files)
- glob: Find files matching patterns
- grep: Search for keywords in files

## OUTPUT FORMAT
When you find relevant information, format it as:

### Top Results
1. **[type]** timestamp — brief title
   Content: excerpt...
   Tags: [tag1, tag2]

Then add a brief summary at the end.

Query: "${query}"
Limit results to ${limit} most relevant. Use ${detailLevel} detail level.`;

      // Only give read-only tools to sub-agent (no bash, no write_file)
      const subAgentTools = this.tools.getAll().filter(t =>
        ["read_file", "glob", "grep"].includes(t.name)
      );
      const subAgentOpenAITools = subAgentTools.map(t => t.toOpenAIFormat());

      // Create sub-agent messages
      const subMessages: LLMMessage[] = [
        { role: "system", content: subAgentSystemPrompt },
        { role: "user", content: `Search my memory for: "${query}"` },
      ];

      // Run sub-agent loop
      try {
        let finalContent = "";
        for (let turn = 0; turn < maxTurns; turn++) {
          const response = await this.llm.chat(subMessages, subAgentOpenAITools, "deepseek-v4-flash");
          const toolCalls = response.tool_calls;

          if (!toolCalls || toolCalls.length === 0) {
            finalContent = response.content || "";
            break;
          }

          // Add assistant message with tool_calls
          subMessages.push({
            role: "assistant",
            content: response.content ?? null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          });

          // Execute tool calls
          for (const tc of toolCalls) {
            const tool = subAgentTools.find(t => t.name === tc.name);
            if (!tool) {
              subMessages.push({ role: "tool", content: `Unknown tool: ${tc.name}`, tool_call_id: tc.id });
              continue;
            }
            try {
              const result = tool.fn(tc.arguments);
              const value = result instanceof Promise ? await result : result;
              subMessages.push({ role: "tool", content: String(value).slice(0, 8000), tool_call_id: tc.id });
            } catch (e) {
              subMessages.push({ role: "tool", content: `Error: ${e}`, tool_call_id: tc.id });
            }
          }
        }

        if (finalContent) {
          return `## Memory Search Results\n\n${finalContent}\n\n---\n*Search completed in ${subMessages.length - 2} messages.*`;
        }

        // If no final content from sub-agent, extract last assistant message
        const assistantMsgs = subMessages.filter(m => m.role === "assistant" && m.content);
        if (assistantMsgs.length > 0) {
          const last = assistantMsgs[assistantMsgs.length - 1];
          return `## Memory Search Results\n\n${last.content}\n\n---\n*Search completed in ${subMessages.length - 2} messages.*`;
        }
      } catch (e) {
        // Sub-agent failed — fall through to keyword fallback
      }

      // Fallback: simple keyword search
      const results = this.memory.search(query, limit);
      if (results.length === 0) return "No memories found matching your query.";
      return results
        .map((r, i) => {
          const tags = r.tags.length ? ` [${r.tags.join(", ")}]` : "";
          return `[${i + 1}] ${r.type} | ${r.timestamp}${tags}\n    ${r.content}`;
        })
        .join("\n\n");
    }

    const tool = this.tools.get(tc.name);
    if (!tool) {
      return `Error: Unknown tool '${tc.name}'`;
    }
    try {
      const result = tool.fn(tc.arguments);
      // Handle both sync and async functions
      const value = result instanceof Promise ? await result : result;
      return String(value);
    } catch (e: unknown) {
      return `Error executing ${tc.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private formatToolResult(name: string, result: string): string {
    const maxLen = 5000;
    const truncated = result.length > maxLen ? result.slice(0, maxLen) + "\n... [truncated]" : result;
    return `[Tool: ${name}]\n${truncated}`;
  }

  private addUserMessage(content: string): void {
    this.messages.push({ role: "user", content });
    this.memory.add({
      type: "observation",
      content: `User: ${content.slice(0, 200)}`,
      tags: ["user-query"],
    });
  }

  private addAssistantMessage(msg: LLMMessage | string): void {
    if (typeof msg === "string") {
      this.messages.push({ role: "assistant", content: msg });
    } else {
      this.messages.push(msg);
    }
  }

  getMemory(): Memory {
    return this.memory;
  }

  getStats(): { inputTokens: number; outputTokens: number } {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
    };
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Load past conversation history into the agent's context.
   * Only user and assistant messages are injected (no system messages).
   */
  loadHistory(history: Array<{role: string; content: string; segments?: Array<{type: string; data: string}>; reasoning_content?: string}>): void {
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        // Handle segments format: reconstruct text content from segments
        let content = msg.content;
        if (!content && msg.segments) {
          content = msg.segments
            .filter((s) => s.type !== "tool_call")
            .map((s) => s.data)
            .join("\n");
        }
        const m: LLMMessage = {
          role: msg.role as "user" | "assistant",
          content: content || "",
        };
        // DeepSeek thinking mode: preserve reasoning_content
        if (msg.reasoning_content && msg.role === "assistant") {
          (m as any).reasoning_content = msg.reasoning_content;
        }
        this.messages.push(m);
      }
    }
  }

  reset(): void {
    this.messages = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    // Re-inject system message so the agent can be reused
    this.messages.push({ role: "system", content: this.config.systemPrompt });
    this.rebuildSystemMessage();
  }
}
