import { LLMClient, LLMMessage } from "./llm";
import { ToolRegistry } from "../tools/registry";
import { Memory } from "../memory/memory";
export class Agent {
  private llm: LLMClient;
  private registry: ToolRegistry;
  private memory: Memory;
  private options: { verbose?: boolean; systemPrompt?: string; };
  constructor(registry: ToolRegistry, memory: Memory, options?: { verbose?: boolean; systemPrompt?: string }) {
    this.llm = new LLMClient();
    this.registry = registry;
    this.memory = memory;
    this.options = options || {};
  }
  async run(input: string, onToken?: (token: string) => void): Promise<string> {
    const messages: LLMMessage[] = [];
    if (this.options.systemPrompt) messages.push({ role: "system", content: this.options.systemPrompt });
    messages.push({ role: "user", content: input });
    let fullResponse = "";
    try {
      const response = await this.llm.chatStream(messages, this.registry.getToolDefs(), (token: string) => { fullResponse += token; if (onToken) onToken(token); });
      if (response.tool_calls && response.tool_calls.length > 0) {
        messages.push({ role: "assistant", content: fullResponse || null });
        for (const tc of response.tool_calls) {
          try {
            const result = await this.registry.execute(tc.name, tc.arguments);
            messages.push({ role: "user", content: `Tool ${tc.name} result: ${JSON.stringify(result)}` });
          } catch (e: any) { messages.push({ role: "user", content: `Tool ${tc.name} error: ${e.message}` }); }
        }
        const followUp = await this.llm.chatStream(messages, this.registry.getToolDefs(), (token: string) => { fullResponse += token; if (onToken) onToken(token); });
        if (followUp.content) fullResponse += followUp.content;
      } else if (response.content) { fullResponse = response.content; }
    } catch (e: any) { fullResponse = `Error: ${e.message}`; if (onToken) onToken(fullResponse); }
    return fullResponse;
  }
}
