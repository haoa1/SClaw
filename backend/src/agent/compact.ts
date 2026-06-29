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

/**
 * Token estimation factors.
 * For Chinese-heavy text (stock screener), ~1.5 chars per token.
 * For English text, ~4 chars per token.
 * Conservative default: 2 chars per token (works for mixed CJK/EN).
 */
const CHARS_PER_TOKEN = 2;
const CHINESE_CHARS_PER_TOKEN = 1.5;
const ASCII_CHARS_PER_TOKEN = 4;

/** If total estimated tokens exceed this, trigger compact (100k = ~10w tokens) */
const COMPACT_TOKEN_THRESHOLD = 100_000;

/** Keep this many tokens worth of most-recent messages intact after compact */
const COMPACT_KEEP_RECENT_TOKENS = 20_000;

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

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summary generator. Your task is to compress a conversation history into a concise structured summary.

Requirements:
- Preserve all key information (user intent, stock screening strategies, stock codes, analysis conclusions, etc.)
- Do not omit important context
- Format: wrap with <analysis> and <summary> tags

<analysis>
Analyze what happened in this conversation:
- What was the user's core need
- Which stocks/strategies/indicators were discussed
- What operations were performed (screening, analysis, comparison, etc.)
- What important results or conclusions were reached
</analysis>
<summary>
1. **Primary Request and Intent** — What the user wanted to do
2. **Key Technical Concepts** — Stocks, strategies, parameters involved
3. **Operations and Results** — What operations were executed and what results were obtained
4. **Key Information** — Stock codes, valuation data, screening conditions, etc.
5. **Current State** — What's been completed, what's pending
</summary>`;

// ============================================================================
// Public API — all functions accept LLMMessage[] (canonical type from llm.ts)
// ============================================================================

// Re-export LLMMessage for external consumers
export type { LLMMessage } from "./llm";

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for a string.
 * Uses heuristic: count CJK chars (Chinese, Japanese, Korean) vs ASCII chars.
 * - CJK chars: ~1.5 chars per token
 * - ASCII chars: ~4 chars per token
 * - Fallback: 2 chars per token
 *
 * This is a rough estimate (not as accurate as tiktoken), but good enough
 * for triggering compaction decisions.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjkChars = 0;
  let asciiChars = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
        (code >= 0x3040 && code <= 0x30FF) ||   // Hiragana + Katakana
        (code >= 0xAC00 && code <= 0xD7AF)) {   // Hangul
      cjkChars++;
    } else if (code < 0x80) {
      asciiChars++;
    }
  }

  const cjkTokens = cjkChars / CHINESE_CHARS_PER_TOKEN;
  const asciiTokens = asciiChars / ASCII_CHARS_PER_TOKEN;
  const otherChars = text.length - cjkChars - asciiChars;
  const otherTokens = otherChars / CHARS_PER_TOKEN;

  return Math.ceil(cjkTokens + asciiTokens + otherTokens);
}

/**
 * Estimate total tokens across a list of messages.
 */
export function estimateTotalTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || "");
    if (msg.reasoning_content) {
      total += estimateTokens(msg.reasoning_content);
    }
  }
  return total;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if history needs compaction — based on estimated token count.
 */
export function shouldCompact(messages: LLMMessage[]): boolean {
  const totalTokens = estimateTotalTokens(messages);
  return totalTokens > COMPACT_TOKEN_THRESHOLD;
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
  messages: LLMMessage[],
  llmClient?: LLMClient,
): Promise<LLMMessage[]> {
  if (!shouldCompact(messages)) return messages;

  // Find split point by token count: accumulate from newest until we have
  // enough recent tokens to keep
  let recentTokens = 0;
  let splitIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    recentTokens += estimateTokens(messages[i].content || "");
    if (recentTokens >= COMPACT_KEEP_RECENT_TOKENS) {
      splitIdx = i;
      break;
    }
  }

  // ADJUST splitIdx to NOT break tool_calls cycles.
  // If recentMessages starts with a "tool" role message (which is a response
  // to a tool_call from oldMessages), we must extend splitIdx backward to
  // include the matching assistant tool_calls message.
  for (let i = splitIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && msg.tool_call_id) {
      // This tool message belongs to an assistant tool_calls message.
      // Scan backward from i-1 to find the matching tool_calls message.
      let foundParent = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          const hasMatchingId = prev.tool_calls.some(tc => tc.id === msg.tool_call_id);
          if (hasMatchingId) {
            foundParent = true;
            break;
          }
        }
      }
      if (!foundParent) {
        // This tool message's parent is in oldMessages.
        // Adjust split to include this tool message in oldMessages.
        // Move splitIdx forward to include up to i (the tool message).
        splitIdx = i + 1;
      }
    }
    if (msg.role !== "tool") break; // Only adjust for contiguous tool messages
  }

  // Similarly, if oldMessages ends with an assistant tool_calls message
  // that doesn't have matching tool responses in oldMessages, extend splitIdx
  // to include those tool responses.
  if (splitIdx > 0 && splitIdx < messages.length) {
    const lastOld = messages[splitIdx - 1];
    if (lastOld.role === "assistant" && lastOld.tool_calls) {
      // This assistant has tool_calls. Check if all tool responses are in oldMessages.
      const toolCallIds = new Set(lastOld.tool_calls.map(tc => tc.id));
      let toolResponseIdx = splitIdx;
      while (toolResponseIdx < messages.length && messages[toolResponseIdx].role === "tool") {
        const toolMsg = messages[toolResponseIdx];
        if (toolMsg.tool_call_id && toolCallIds.has(toolMsg.tool_call_id)) {
          toolCallIds.delete(toolMsg.tool_call_id);
        }
        toolResponseIdx++;
      }
      if (toolCallIds.size > 0) {
        // Not all tool responses are in oldMessages. Move splitIdx forward.
        splitIdx = toolResponseIdx;
      }
    }
  }

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
  const compacted: LLMMessage[] = [
    {
      role: "assistant",
      content: `## Compacted Conversation Summary\n\n${summary}\n\n---\n*Previous conversation compressed. Recent messages preserved below.*`,
    },
    {
      role: "user",
      content: "Got it, continue. Above is the conversation summary, below are the most recent messages.",
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
  messages: LLMMessage[],
): LLMMessage[] {
  let freed = 0;

  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const content = msg.content || "";
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

    freed += originalLen - (msg.content || "").length;
  }

  if (freed > 0) {
    const freedTokens = estimateTokens('X'.repeat(freed));
    console.log(
      `    [MICRO-COMPACT] Freed ~${freedTokens} tokens (${freed} chars) by compressing tool results`,
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
  messages: LLMMessage[],
  llmClient: LLMClient,
): Promise<string> {
  const formatted = formatForSummary(messages);

  const summaryRequest: LLMMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Conversation history to summarize:\n\n${formatted}`,
    },
  ];

  // Timeout-safe LLM call using AbortController (no dangling HTTP requests)
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), COMPACT_TIMEOUT * 1000);

  try {
    const result = await llmClient.chat(summaryRequest, [], undefined, abortController.signal);
    const summary = result.content || "";
    console.log(`    [COMPACT] Summary generated (${summary.length} chars)`);
    return summary;
  } catch (e: unknown) {
    if ((e as any)?.name === "AbortError") {
      console.log(`    [COMPACT] Summary timed out after ${COMPACT_TIMEOUT}s`);
    } else {
      console.log(`    [COMPACT] Summary failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw e; // Let caller handle fallback
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Format messages for the summarization prompt, truncated to limit.
 */
function formatForSummary(
  messages: LLMMessage[],
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
        `... [truncated — ${messages.length} total messages, showing ${parts.length}/${messages.length}]`,
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
function fallbackSummary(messages: LLMMessage[]): string {
  const userCount = messages.filter((m) => m.role === "user").length;
  const toolCalls = messages.filter(
    (m) => m.role === "assistant" && (m.content || "").includes("[Tool:"),
  ).length;

  return (
    `**History compressed — ${messages.length} messages summarised:**\n` +
    `- User messages: ${userCount}\n` +
    `- Assistant tool calls: ${toolCalls}\n` +
    `- Stock screening operations, strategy discussions, and analyses were conducted during this session.\n\n` +
    `*(Full detail available in logs)*\n`
  );
}
