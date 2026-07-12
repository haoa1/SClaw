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
  allowedToolNames?: string[];  // if set, only these tools are exposed to the LLM
}

export class Agent {
  private messages: LLMMessage[] = [];
  private llm: LLMClient;
  private tools: ToolRegistry;
  private memory: Memory;
  private config: Required<Omit<AgentConfig, 'allowedToolNames'>> & { allowedToolNames?: string[] };
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** Loaded skills: name → markdown content */
  private loadedSkills = new Map<string, string>();
  /** Abort flag: set to true to stop the agent on next loop check */
  public aborted = false;

  /** Allowed tool names (undefined = all tools allowed) */
  private allowedToolNames?: Set<string>;

  /** Filter tools based on allowedToolNames whitelist */
  private getFilteredTools(): Record<string, unknown>[] {
    const allTools = this.tools.toOpenAITools();
    if (!this.allowedToolNames) return allTools;
    return allTools.filter((t: any) => this.allowedToolNames!.has(t?.function?.name));
  }

  /** Signal the agent to stop. Next loop iteration will exit early. */
  public abort(): void {
    this.aborted = true;
  }
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
    this.allowedToolNames = config.allowedToolNames
      ? new Set(config.allowedToolNames)
      : undefined;
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
      allowedToolNames: config.allowedToolNames ?? undefined,
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

      // Check abort flag
      if (this.aborted) {
        console.log("  [AGENT] Aborted after turn " + turnCount);
        this.aborted = false;
        return {
          response: "",
          toolCalls: totalToolCalls,
          inputTokens: this.totalInputTokens,
          outputTokens: this.totalOutputTokens,
        };
      }

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

      // Safety: validate message array integrity before LLM call
      this.validateMessages();

      // Debug: dump full prompt before LLM call
      this.dumpPrompt(turnCount);

      // Get LLM response (streaming or not)
      const llmResponse = onToken
        ? await this.llm.chatStream(
            this.messages,
            this.getFilteredTools(),
            onToken,
            this.config.model,
            onReasoning,
            onToolCall,
          )
        : await this.llm.chat(
            this.messages,
            this.getFilteredTools(),
            this.config.model
          );

      this.totalInputTokens += llmResponse.usage.input_tokens;
      this.totalOutputTokens += llmResponse.usage.output_tokens;

      // Add assistant message — with tool_calls if present
      if (llmResponse.tool_calls && llmResponse.tool_calls.length > 0) {
        // Save full assistant message including tool_calls (OpenAI format)
        // DeepSeek: content MUST be null (not empty string "") when tool_calls present
        // DeepSeek thinking mode: content MUST be null when tool_calls is present.
        // Some APIs return both content + tool_calls, but re-sending non-null content
        // with tool_calls can cause "must be followed by tool messages" errors.
        const assistantMsg: LLMMessage = {
          role: "assistant",
          content: null,
          tool_calls: llmResponse.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
        // DeepSeek thinking mode: ALWAYS set reasoning_content for tool_calls messages.
        // The API requires reasoning_content to be passed back when in thinking mode,
        // even if the response for this specific turn didn't include it.
        (assistantMsg as any).reasoning_content = llmResponse.reasoning_content || "";
        this.messages.push(assistantMsg);
      } else {
        // Plain text response — no tool calls
        if (llmResponse.content) {
          const assistantMsg: LLMMessage = {
            role: "assistant",
            content: llmResponse.content,
          };
          // DeepSeek thinking mode: also preserve reasoning_content for plain text
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
    // compact: manually trigger context compression
    if (tc.name === "compact") {
      const reason = (tc.arguments.reason as string) || "";
      const beforeCount = this.messages.length;
      const beforeTokens = estimateTotalTokens(this.messages);

      this.messages = await compactContext(this.messages, this.llm);
      // Re-inject system message after compact
      this.rebuildSystemMessage();

      const afterCount = this.messages.length;
      const afterTokens = estimateTotalTokens(this.messages);
      const savedTokens = beforeTokens - afterTokens;

      let result = `✅ Compact completed: ${beforeCount} → ${afterCount} messages, saved ~${savedTokens} tokens.`;
      if (reason) result += `\nReason: ${reason}`;
      return result;
    }

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

          // Add assistant message with tool_calls (content MUST be null per DeepSeek spec)
          const subAssistantMsg: LLMMessage = {
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          };
          // DeepSeek thinking mode: must pass back reasoning_content
          (subAssistantMsg as any).reasoning_content = response.reasoning_content || "";
          subMessages.push(subAssistantMsg);

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
    // Attach current time as <attachment> tag so AI always knows when user spoke
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const tz = 'CST (UTC+8)';
    const attached = `${content.trim()}\n\n<attachment type="system">\n当前时间: ${timeStr} ${tz}\n</attachment>`;
    this.messages.push({ role: "user", content: attached });
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

  /**
   * Validate message array integrity before sending to LLM.
   * Fixes broken tool_calls cycles that would cause 400 errors:
   * "An assistant message with 'tool_calls' must be followed by tool messages"
   */
  private validateMessages(): void {
    // Remove any orphaned tool messages (tool messages whose tool_call_id
    // doesn't match any assistant tool_calls message before them)
    const valid: LLMMessage[] = [];
    const openToolCallIds = new Set<string>(); // tool_call_ids waiting for tool responses
    const toolCallIdToParentIdx = new Map<string, number>(); // tool_call_id -> index in valid

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];

      if (msg.role === "tool" && msg.tool_call_id) {
        if (openToolCallIds.has(msg.tool_call_id)) {
          // Valid: this tool message has a matching assistant tool_calls parent
          openToolCallIds.delete(msg.tool_call_id);
          valid.push(msg);
        } else {
          // Orphaned tool message - no matching tool_calls found. Drop it.
          console.log(`  [AGENT] Dropped orphaned tool message (tool_call_id=${msg.tool_call_id})`);
        }
        continue;
      }

      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        // Track all tool_call_ids from this assistant message
        for (const tc of msg.tool_calls) {
          openToolCallIds.add(tc.id);
          toolCallIdToParentIdx.set(tc.id, valid.length);
        }
        valid.push(msg);
        continue;
      }

      // Regular message (system, user, assistant with no tool_calls, or tool with no id)
      valid.push(msg);
    }

    // Check for dangling tool_calls with no tool responses ANYWHERE in the array.
    // On error in a previous run, some tool_calls may be left unresolved,
    // and a subsequent run adds user messages that "mask" the dangling block
    // from a simple end-of-array scan. We must remove ALL assistant messages
    // (and their orphaned tool responses) that have unresolved tool_call_ids.
    if (openToolCallIds.size > 0) {
      // Collect all assistant message indices that have unresolved tool_calls
      const indicesToRemove = new Set<number>();
      for (let i = valid.length - 1; i >= 0; i--) {
        const msg = valid[i];
        if (msg.role === "assistant" && msg.tool_calls) {
          const unresolved = msg.tool_calls.filter(tc => openToolCallIds.has(tc.id));
          if (unresolved.length > 0) {
            indicesToRemove.add(i);
            for (const tc of unresolved) {
              openToolCallIds.delete(tc.id);
            }
          }
        }
        // Also remove orphaned tool messages whose parent was removed
        if (msg.role === "tool" && msg.tool_call_id && !openToolCallIds.has(msg.tool_call_id)) {
          // This tool message belongs to a tool_call_id that's already been resolved.
          // But if its parent assistant was removed, we need to check:
          // toolCallIdToParentIdx tells us which assistant message this tool belongs to
        }
      }

      if (indicesToRemove.size > 0) {
        console.log(`  [AGENT] Removing ${indicesToRemove.size} assistant message(s) with unresolved tool_calls`);
        // Also find and remove tool messages that belong to removed assistants
        const removedToolCallIds = new Set<string>();
        for (const idx of indicesToRemove) {
          const msg = valid[idx];
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              removedToolCallIds.add(tc.id);
            }
          }
        }
        // Scan for tool messages that belong to these removed tool_call_ids
        for (let i = valid.length - 1; i >= 0; i--) {
          const msg = valid[i];
          if (msg.role === "tool" && msg.tool_call_id && removedToolCallIds.has(msg.tool_call_id)) {
            indicesToRemove.add(i);
          }
        }
        // Remove in reverse order to preserve indices
        const sorted = Array.from(indicesToRemove).sort((a, b) => b - a);
        for (const idx of sorted) {
          valid.splice(idx, 1);
        }
      }
    }

    this.messages = valid;
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
