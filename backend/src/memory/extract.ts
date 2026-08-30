/**
 * Memory Extraction — async incremental memory extraction.
 *
 * After each agent turn completes, analyzes the new conversation (user message + assistant response)
 * and extracts memory-worthy information. Runs in background, does NOT block the API response.
 */

import { Memory } from "./memory";
import { LLMClient } from "../agent/llm";

const EXTRACT_PROMPT = `你是一个记忆提取助手。分析以下对话轮次，提取值得长期保存的信息。

规则：
1. 只提取**新信息** — 不要提取常识性内容或显而易见的对话
2. 输出格式为 JSON 数组，每个元素包含:
   - type: "strategy" | "decision" | "observation" | "result"
   - content: 中文描述，简洁完整
   - tags: 字符串数组，标签语义化（如 ["trading-style", "short-term"]）
3. 如果没有任何值得保存的信息，返回空数组 []
4. 不要重复保存已存在的内容

值得保存的场景：
- 用户明确要求记住的（"帮我记住/记下来/保存"）
- 交易偏好、习惯（短线/长线、止损/止盈）
- 策略定义（"用XXX作为买入信号"）
- 重要的操作结果（"赚了/亏了"）
- 用户做的重要决策或改变主意

不值得保存：
- 简单查询（"股价多少"）
- 问候语
- 系统通知

=== 对话内容 ===

用户消息: {{USER_MESSAGE}}

AI回复: {{ASSISTANT_RESPONSE}}

=== 输出 ===

只输出 JSON 数组，不要其他文字。`;

interface ExtractionResult {
  type: "strategy" | "decision" | "observation" | "result";
  content: string;
  tags: string[];
}

/**
 * Extract memory from a single conversation turn.
 * Called after agent.run() completes — runs asynchronously, does not await.
 */
export async function extractMemoryFromMessages(
  memory: Memory,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  try {
    const prompt = EXTRACT_PROMPT
      .replace("{{USER_MESSAGE}}", userMessage.slice(0, 500))
      .replace("{{ASSISTANT_RESPONSE}}", assistantResponse.slice(0, 2000));

    const llm = new LLMClient();
    const result = await llm.chat(
      [{ role: "user", content: prompt }],
      [],
      "deepseek-chat",
    );

    const content = result.content?.trim();
    if (!content) {
      console.log("[MemoryExtract] No content from extraction LLM");
      return;
    }

    // Parse JSON from response (handle potential markdown code fences)
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const items: ExtractionResult[] = JSON.parse(jsonStr);
    if (!Array.isArray(items) || items.length === 0) {
      console.log("[MemoryExtract] No items to extract");
      return;
    }

    for (const item of items) {
      if (!item.type || !item.content) continue;
      const id = memory.add({
        type: item.type,
        content: item.content,
        tags: item.tags || [],
      });
      const preview = item.content.slice(0, 60);
      console.log(`[MemoryExtract] Saved [${item.type}] ${preview} (id: ${id})`);
    }
  } catch (err) {
    console.error("[MemoryExtract] Error:", err);
  }
}
