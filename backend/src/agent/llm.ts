import crypto from "crypto";
import OpenAI from "openai";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;  // null for assistant messages with tool_calls (DeepSeek requirement)
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;  // DeepSeek thinking mode
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  reasoning_content?: string | null;  // DeepSeek thinking mode
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ===== Encrypted API key storage =====
// Key read once from env, encrypted with AES-256-GCM, env vars deleted immediately.
// Decrypted on-the-fly when OpenAI client is constructed.
// Master key from LLM_MASTER_KEY env var (also deleted after read).
// If no master key provided, uses a built-in fallback (defense-in-depth, not real security).

function deriveMasterKey(): Buffer {
  // Read master key from env (separate from API key)
  const masterHex = process.env["LLM_MASTER_KEY"];
  delete process.env["LLM_MASTER_KEY"];

  if (masterHex && masterHex.length === 64) {
    // 32 bytes hex-encoded = 256-bit key
    return Buffer.from(masterHex, "hex");
  }

  // Built-in fallback: deterministic from a fixed seed + hostname
  // This prevents casual memory scraping but doesn't protect against a full dump
  const hostname = (() => {
    try { return require("os").hostname(); } catch { return "unknown"; }
  })();
  return crypto.createHash("sha256").update(`garuda-llm-seed-${hostname}`).digest();
}

const MASTER_KEY: Buffer = deriveMasterKey();

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, authTagHex, ciphertext] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    MASTER_KEY,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// Capture + encrypt at module load, delete env vars
const ENCRYPTED_CREDENTIALS: { key: string; baseUrl: string } = (() => {
  const key = process.env["DEEPSEEK_API_KEY"]
    || process.env["OPENAI_API_KEY"]
    || "sk-placeholder";

  const isDeepSeek = key.startsWith("sk-") && key !== "sk-placeholder";
  const baseUrl = isDeepSeek
    ? "https://api.deepseek.com/v1"
    : "https://api.openai.com/v1";

  // ⚡ Nuke env vars immediately — no child process can read them
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_BASE_URL"];

  // Store encrypted (unless placeholder — no need)
  if (key === "sk-placeholder") {
    return { key, baseUrl };
  }
  return { key: encrypt(key), baseUrl };
})();

// ===== LLMClient =====

export class LLMClient {
  private client: OpenAI;

  constructor(apiKey?: string) {
    // If explicit key provided, use it as-is (passed by caller, caller manages lifetime)
    // Otherwise decrypt the cached encrypted key
    const { key, baseUrl } = apiKey
      ? { key: apiKey, baseUrl: apiKey.startsWith("sk-") ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1" }
      : (() => {
          const isEncrypted = ENCRYPTED_CREDENTIALS.key.includes(":");
          return {
            key: isEncrypted ? decrypt(ENCRYPTED_CREDENTIALS.key) : ENCRYPTED_CREDENTIALS.key,
            baseUrl: ENCRYPTED_CREDENTIALS.baseUrl,
          };
        })();

    this.client = new OpenAI({
      apiKey: key,
      baseURL: baseUrl,
    });
    // Store baseUrl for model auto-detection
    (this as any)._baseUrl = baseUrl;
  }

  private getDefaultModel(): string {
    const baseUrl = (this as any)._baseUrl || "";
    if (baseUrl.includes("deepseek")) return "deepseek-v4-flash";
    return "gpt-4o";
  }

  async chat(
    messages: LLMMessage[],
    tools: Record<string, unknown>[],
    model?: string,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelName = model || process.env["LLM_MODEL"] || this.getDefaultModel();

    try {
      const body = {
        model: modelName,
        messages: messages.map((m) => {
          const msg: Record<string, unknown> = {
            role: m.role,
            content: m.content,
          };
          if (m.tool_calls) {
            msg.tool_calls = m.tool_calls;
          }
          if (m.tool_call_id) {
            msg.tool_call_id = m.tool_call_id;
          }
          // DeepSeek thinking mode: MUST pass back reasoning_content when present
          // (even empty string — API requires it for tool_calls messages)
          if (m.role === "assistant" && (m as any).reasoning_content !== undefined) {
            msg.reasoning_content = (m as any).reasoning_content;
          }
          return msg;
        }),
      } as Record<string, unknown>;

      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = "auto";
      }

      const response = await this.client.chat.completions.create(
        JSON.parse(JSON.stringify(body)) as any,
        signal ? { signal } : undefined
      );

      const choice = response.choices[0];
      const message = choice?.message;

      // Capture reasoning_content for DeepSeek thinking mode
      const reasoningContent = (message as any)?.reasoning_content;

      const tool_calls: ToolCall[] | null =
        message?.tool_calls?.map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name || "",
          arguments: JSON.parse(tc.function?.arguments || "{}"),
        })) ?? null;

      return {
        content: message?.content || null,
        tool_calls,
        reasoning_content: reasoningContent || undefined,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? 0,
          output_tokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      throw new Error(`LLM API error: ${errMsg}`);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    tools: Record<string, unknown>[],
    onToken: (token: string) => void,
    model?: string,
    onReasoning?: (token: string) => void,
    onToolCallStream?: (tc: {id: string; name: string; arguments: string}) => void,
  ): Promise<LLMResponse> {
    const modelName = model || process.env["LLM_MODEL"] || this.getDefaultModel();

    const body: Record<string, unknown> = {
      model: modelName,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls;
        }
        if (m.tool_call_id) {
          msg.tool_call_id = m.tool_call_id;
        }
        // DeepSeek thinking mode: MUST pass back reasoning_content when present
        // (even empty string — API requires it for tool_calls messages)
        if (m.role === "assistant" && (m as any).reasoning_content !== undefined) {
          msg.reasoning_content = (m as any).reasoning_content;
        }
        return msg;
      }),
      stream: true,
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    try {
      const stream = await this.client.chat.completions.create(
        JSON.parse(JSON.stringify(body)) as any
      );

      let content = "";
      let reasoningContent = "";
      let toolCallsAccumulator: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];
      let usage = { input_tokens: 0, output_tokens: 0 };

      for await (const chunk of stream as any) {
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;

        // Accumulate reasoning_content (DeepSeek thinking mode)
        if (delta.reasoning_content) {
          const token = String(delta.reasoning_content);
          reasoningContent += token;
          if (onReasoning) onReasoning(token);
        }

        // Accumulate content
        if (delta.content) {
          const token = String(delta.content);
          content += token;
          onToken(token);
        }

        // Accumulate tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            while (toolCallsAccumulator.length <= idx) {
              toolCallsAccumulator.push({ id: "", name: "", arguments: "" });
            }
            if (tc.id) toolCallsAccumulator[idx].id = tc.id;
            if (tc.function?.name) toolCallsAccumulator[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallsAccumulator[idx].arguments += tc.function.arguments;
            // Notify on each tool call delta
            if (onToolCallStream) {
              onToolCallStream({
                id: toolCallsAccumulator[idx].id,
                name: toolCallsAccumulator[idx].name,
                arguments: toolCallsAccumulator[idx].arguments,
              });
            }
          }
        }

        // Accumulate usage
        if (chunk?.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
            output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
          };
        }
      }

      const tool_calls: ToolCall[] | null =
        toolCallsAccumulator.length > 0
          ? toolCallsAccumulator.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: JSON.parse(tc.arguments || "{}"),
            }))
          : null;

      return { content: content || null, tool_calls, reasoning_content: reasoningContent || undefined, usage };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      throw new Error(`LLM API error: ${errMsg}`);
    }
  }
}
