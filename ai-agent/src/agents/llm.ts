import OpenAI from "openai";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string | null;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  usage: { input_tokens: number; output_tokens: number; };
}

export class LLMClient {
  private client: OpenAI;
  constructor(apiKey?: string) {
    const key = apiKey || process.env["DEEPSEEK_API_KEY"] || process.env["OPENAI_API_KEY"] || "";
    this.client = new OpenAI({
      apiKey: key,
      baseURL: process.env["OPENAI_BASE_URL"] || "https://api.deepseek.com",
    });
  }
  async chatStream(messages: LLMMessage[], tools: Record<string, unknown>[], onToken: (token: string) => void, model?: string): Promise<LLMResponse> {
    const modelName = model || process.env["LLM_MODEL"] || "deepseek-chat";
    const body: Record<string, unknown> = { model: modelName, messages: messages.map(m => ({ role: m.role, content: m.content })), stream: true };
    if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }
    try {
      const stream = await this.client.chat.completions.create(body as any);
      let content = "";
      let acc: Array<{ id: string; name: string; arguments: string; }> = [];
      let usage = { input_tokens: 0, output_tokens: 0 };
      for await (const chunk of stream as any) {
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; onToken(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            while (acc.length <= tc.index) acc.push({ id: "", name: "", arguments: "" });
            if (tc.id) acc[tc.index].id = tc.id;
            if (tc.function?.name) acc[tc.index].name = tc.function.name;
            if (tc.function?.arguments) acc[tc.index].arguments += tc.function.arguments;
          }
        }
        if (chunk?.usage) usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
      }
      const tool_calls: ToolCall[] | null = acc.length > 0 ? acc.map(tc => ({ id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments || "{}") })) : null;
      return { content: content || null, tool_calls, usage };
    } catch (e: unknown) { throw new Error(`LLM API error: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async chat(messages: LLMMessage[], tools: Record<string, unknown>[], model?: string): Promise<LLMResponse> {
    const modelName = model || process.env["LLM_MODEL"] || "deepseek-chat";
    const body: Record<string, unknown> = { model: modelName, messages: messages.map(m => ({ role: m.role, content: m.content })) };
    if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }
    try {
      const response = await this.client.chat.completions.create(body as any);
      const choice = response.choices[0];
      const message = choice?.message;
      const tool_calls: ToolCall[] | null = message?.tool_calls?.map(tc => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") })) ?? null;
      return { content: message?.content || null, tool_calls, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 } };
    } catch (e: unknown) { throw new Error(`LLM API error: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
