#!/bin/bash
# ============================================
# 股海操盘手 - 一键部署 & 更新脚本
# 在本地终端执行: bash deploy.sh
# 支持重复执行更新代码
# ============================================
set -e

REPO="/root/stock-screener"
API_KEY="${DEEPSEEK_API_KEY:-}"

echo "========================================"
echo "  股海操盘手 - 部署/更新脚本"
echo "========================================"

# 如果没传 API Key，提示输入
if [ -z "$API_KEY" ]; then
  echo ""
  echo "请输入你的 DeepSeek API Key:"
  read -s API_KEY
  echo ""
fi

# ---- 1. 环境检查 ----
echo ""
echo "[1/5] 检查环境..."

if [ "$(id -u)" != "0" ]; then
  # 可能不是 root，尝试 sudo
  SUDO="sudo"
else
  SUDO=""
fi

if ! command -v node &> /dev/null; then
  echo "  → 安装 Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
echo "  Node.js $(node --version) ✓"
echo "  npm $(npm --version) ✓"

# ---- 2. 目录结构 ----
echo ""
echo "[2/5] 创建目录结构..."
mkdir -p "$REPO"/ai-agent/src/{agents,memory,tools}
mkdir -p "$REPO"/ai-agent/data
mkdir -p "$REPO"/frontend/dist
mkdir -p "$REPO"/plugins/example-plugin

# ---- 3. 写入源码 ----
echo ""
echo "[3/5] 写入源码..."

# ---------- package.json ----------
cat > "$REPO"/ai-agent/package.json << 'PKG'
{
  "name": "sclaw",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "tsx src/web-server.ts",
    "update": "bash /root/stock-screener/deploy.sh"
  },
  "dependencies": {
    "openai": "^4.70.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0"
  }
}
PKG

# ---------- tsconfig.json ----------
cat > "$REPO"/ai-agent/tsconfig.json << 'TSC'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"]
}
TSC

# ---------- LLM Client ----------
cat > "$REPO"/ai-agent/src/agents/llm.ts << 'LLM'
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
LLM

# ---------- Agent ----------
cat > "$REPO"/ai-agent/src/agents/agent.ts << 'AGENT'
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
AGENT

# ---------- Memory ----------
cat > "$REPO"/ai-agent/src/memory/memory.ts << 'MEM'
import * as fs from "fs";
import * as path from "path";
export class Memory {
  private entries: any[] = [];
  private filePath: string;
  constructor(memoryDir: string) {
    this.filePath = path.join(memoryDir, "memory.json");
    try { if (fs.existsSync(this.filePath)) this.entries = JSON.parse(fs.readFileSync(this.filePath, "utf-8")); } catch { this.entries = []; }
  }
  add(entry: any): string {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.entries.push({ id, timestamp: new Date().toISOString(), ...entry });
    if (this.entries.length > 100) this.entries = this.entries.slice(-100);
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8"); } catch {}
    return id;
  }
  search(query: string, limit = 5): any[] {
    const q = query.toLowerCase();
    return this.entries.map((e: any) => {
      let score = 0; const text = `${e.content} ${(e.tags||[]).join(" ")} ${e.type||""}`.toLowerCase();
      if (text.includes(q)) score += 10;
      for (const w of q.split(/\s+/)) { if (text.includes(w)) score += 3; }
      return { entry: e, score };
    }).filter((s: any) => s.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, limit).map((s: any) => s.entry);
  }
  recent(limit = 10): any[] { return this.entries.slice(-limit).reverse(); }
}
MEM

cat > "$REPO"/ai-agent/src/memory/compact.ts << 'CMP'
export class CompactEngine {
  private maxMessages: number;
  constructor(maxMessages = 30) { this.maxMessages = maxMessages; }
  shouldCompact(messageCount: number): boolean { return messageCount > this.maxMessages; }
}
CMP

# ---------- Tool Registry ----------
cat > "$REPO"/ai-agent/src/tools/registry.ts << 'REG'
export class ToolRegistry {
  private tools: Map<string, (args: any) => Promise<any>> = new Map();
  private defs: any[] = [];
  register(name: string, handler: (args: any) => Promise<any>, def: any): void {
    this.tools.set(name, handler); this.defs.push(def);
  }
  async execute(name: string, args: any): Promise<any> {
    const h = this.tools.get(name); if (!h) throw new Error(`Unknown tool: ${name}`);
    return h(args);
  }
  getToolDefs(): any[] { return this.defs.map(d => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } })); }
}
REG

# ---------- File Tools ----------
cat > "$REPO"/ai-agent/src/tools/file-tools.ts << 'FIL'
import { ToolRegistry } from "./registry";
import * as fs from "fs"; import * as path from "path"; import { execSync } from "child_process";
export function registerFileTools(registry: ToolRegistry): void {
  registry.register("read_file", async (a: any) => { try { return fs.readFileSync(a.file_path, "utf-8"); } catch (e: any) { return `Error: ${e.message}`; } },
    { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } });
  registry.register("write_file", async (a: any) => { try { fs.mkdirSync(path.dirname(a.file_path), { recursive: true }); fs.writeFileSync(a.file_path, a.content, "utf-8"); return "OK"; } catch (e: any) { return `Error: ${e.message}`; } },
    { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } });
  registry.register("bash", async (a: any) => { try { return execSync(a.command, { timeout: 30000, encoding: "utf-8" }); } catch (e: any) { return `Error: ${e.message}`; } },
    { name: "bash", description: "Run bash command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } });
  registry.register("glob", async (a: any) => { try { return execSync(`find ${a.path||'.'} -name "${a.pattern}" -not -path "*/node_modules/*" 2>/dev/null | head -50`, { encoding: "utf-8" }); } catch { return ""; } },
    { name: "glob", description: "Find files", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } });
  registry.register("grep", async (a: any) => { try { return execSync(`grep -r "${a.pattern}" ${a.path||'.'} --include="*.ts" --include="*.js" 2>/dev/null | head -100`, { encoding: "utf-8" }); } catch { return ""; } },
    { name: "grep", description: "Search files", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } });
}
FIL

# ---------- Frontend Actions ----------
cat > "$REPO"/ai-agent/src/tools/frontend-actions.ts << 'FEA'
export const frontendActions: Array<{ type: string; payload: any }> = [];
export function clearActions(): void { frontendActions.length = 0; }
export function registerFrontendTools(registry: any): void {
  registry.register("run_screen", async (args: any) => {
    frontendActions.push({ type: "run_screen", payload: args });
    return JSON.stringify({ status: "ok", action: "run_screen" });
  }, { name: "run_screen", description: "Run stock screen", parameters: { type: "object", properties: { strategies: { type: "string" } } } });
}
FEA

# ---------- Stock Info ----------
cat > "$REPO"/ai-agent/src/tools/stock-info.ts << 'STK'
import { ToolRegistry } from "./registry";
const STOCKS_CACHE: any[] = [];
const SAMPLE_STOCKS = [
  { code:"600000", name:"浦发银行", market:"SH", price:8.50, change_pct:1.2, volume:5000000, turnover:0.8, pe:5.2, pb:0.45, market_cap:250e9 },
  { code:"600519", name:"贵州茅台", market:"SH", price:1850, change_pct:-0.5, volume:200000, turnover:0.3, pe:30.5, pb:10.2, market_cap:2300e9 },
  { code:"000001", name:"平安银行", market:"SZ", price:12.30, change_pct:2.1, volume:8000000, turnover:1.5, pe:6.8, pb:0.72, market_cap:240e9 },
  { code:"300750", name:"宁德时代", market:"SZ", price:220, change_pct:3.5, volume:3000000, turnover:2.1, pe:25, pb:5.8, market_cap:500e9 },
  { code:"688256", name:"寒武纪", market:"SH", price:150, change_pct:20, volume:15000000, turnover:8.5, pe:-1, pb:15, market_cap:600e9 },
  { code:"000333", name:"美的集团", market:"SZ", price:65, change_pct:0.8, volume:2000000, turnover:0.6, pe:12, pb:2.5, market_cap:450e9 },
  { code:"600036", name:"招商银行", market:"SH", price:35, change_pct:1.5, volume:4000000, turnover:0.9, pe:6, pb:0.85, market_cap:880e9 },
  { code:"601318", name:"中国平安", market:"SH", price:45, change_pct:-0.3, volume:6000000, turnover:1.2, pe:8.5, pb:1.1, market_cap:820e9 },
  { code:"688521", name:"芯原股份", market:"SH", price:78, change_pct:20, volume:8000000, turnover:6.5, pe:-1, pb:8.0, market_cap:380e9 },
  { code:"300769", name:"德方纳米", market:"SZ", price:85, change_pct:12.92, volume:5000000, turnover:5.0, pe:35, pb:4.2, market_cap:150e9 },
];
export async function getStocks(): Promise<any[]> {
  if (STOCKS_CACHE.length > 0) return STOCKS_CACHE;
  STOCKS_CACHE.push(...SAMPLE_STOCKS);
  return STOCKS_CACHE;
}
export function registerStockTools(registry: ToolRegistry): void {
  registry.register("search_stocks", async (a: any) => { const q = (a.query||"").toLowerCase(); return (await getStocks()).filter((s:any) => s.code.includes(q)||s.name.includes(q)); },
    { name:"search_stocks", description:"Search stocks", parameters:{ type:"object", properties:{ query:{type:"string"}, limit:{type:"number"} }, required:["query"] } });
  registry.register("get_stock_detail", async (a: any) => { return (await getStocks()).find((s:any) => s.code===a.code)||{error:"Not found"}; },
    { name:"get_stock_detail", description:"Get stock detail", parameters:{ type:"object", properties:{ code:{type:"string"} }, required:["code"] } });
  registry.register("get_kline", async (a: any) => { return {code:a.code, days:a.days||30, data:"mock kline"}; },
    { name:"get_kline", description:"Get K-line", parameters:{ type:"object", properties:{ code:{type:"string"}, market:{type:"string"}, days:{type:"number"} }, required:["code"] } });
  registry.register("market_overview", async () => { return {total:5200, up:2800, down:1900, flat:500, description:"今日市场涨多跌少"}; },
    { name:"market_overview", description:"Market overview", parameters:{ type:"object", properties:{} } });
}
STK

# ---------- Strategy Validator ----------
cat > "$REPO"/ai-agent/src/tools/strategy-validator.ts << 'SV'
import { ToolRegistry } from "./registry";
export function registerStrategyTools(registry: ToolRegistry): void {
  registry.register("list_strategies", async (a: any) => [
    { id:"pe-value", name:"低市盈率选股", category:"long-term", description:"筛选市盈率低的股票", params:[{key:"max_pe",label:"最大市盈率",type:"number",default:15}] },
    { id:"pb-value", name:"破净选股", category:"long-term", description:"筛选市净率低于1的股票", params:[{key:"max_pb",label:"最大市净率",type:"number",default:1}] },
    { id:"volume-surge", name:"放量上涨", category:"short-term", description:"放量上涨的股票", params:[{key:"min_volume_ratio",label:"最小量比",type:"number",default:1.5}] },
    { id:"limit-up", name:"涨停监测", category:"short-term", description:"检测涨停股票", params:[{key:"min_pct",label:"最小涨幅",type:"number",default:9.5}] },
    { id:"high-turnover", name:"换手活跃", category:"short-term", description:"换手率活跃的股票", params:[{key:"min_turnover",label:"最小换手率",type:"number",default:3}] },
  ], { name:"list_strategies", description:"List strategies", parameters:{ type:"object", properties:{ category:{type:"string"} } } });
  registry.register("run_multi_strategy", async () => ({results:[], stats:{totalStocks:5200,matchedStocks:0}}),
    { name:"run_multi_strategy", description:"Run multi strategy", parameters:{ type:"object", properties:{ strategies_json:{type:"string"}, combine_mode:{type:"string"}, limit:{type:"number"} }, required:["strategies_json"] } });
}
SV

# ---------- Strategy Optimize ----------
cat > "$REPO"/ai-agent/src/tools/strategy-optimize.ts << 'SO'
import { ToolRegistry } from "./registry";
export function registerOptimizeTools(registry: ToolRegistry): void {
  registry.register("optimize_strategy", async (a: any) => ({strategy_id:a.strategy_id, best_params:{}, results:[]}),
    { name:"optimize_strategy", description:"Optimize strategy", parameters:{ type:"object", properties:{ strategy_id:{type:"string"}, param:{type:"string"}, min:{type:"number"}, max:{type:"number"}, steps:{type:"number"} }, required:["strategy_id","param"] } });
}
SO

# ---------- Risk Assessment ----------
cat > "$REPO"/ai-agent/src/tools/risk-assessment.ts << 'RA'
import { ToolRegistry } from "./registry";
export function registerRiskTools(registry: ToolRegistry): void {
  registry.register("assess_portfolio_risk", async () => ({risk_level:"medium", concentration:0.3, var_95:-0.05, suggestions:["分散投资降低风险"]}),
    { name:"assess_portfolio_risk", description:"Portfolio risk", parameters:{ type:"object", properties:{ codes_json:{type:"string"}, weights_json:{type:"string"}, total_value:{type:"number"} }, required:["codes_json"] } });
  registry.register("assess_stock_risk", async (a: any) => ({code:a.code, risk_level:"low", volatility:0.25, suggestion:"正常"}),
    { name:"assess_stock_risk", description:"Stock risk", parameters:{ type:"object", properties:{ code:{type:"string"} }, required:["code"] } });
}
RA

# ---------- Strategy Generator ----------
cat > "$REPO"/ai-agent/src/tools/strategy-generator.ts << 'SG'
import { ToolRegistry } from "./registry";
export function registerStrategyGeneratorTools(registry: ToolRegistry): void {
  registry.register("generate_strategy", async (a: any) => ({status:"ok", plugin_id:a.plugin_id||"custom", message:"Strategy generated"}),
    { name:"generate_strategy", description:"Generate strategy", parameters:{ type:"object", properties:{ plugin_id:{type:"string"}, plugin_name:{type:"string"}, description:{type:"string"}, strategies_json:{type:"string"} }, required:["plugin_id","strategies_json"] } });
  registry.register("reload_plugins", async () => ({status:"ok", message:"Plugins reloaded"}),
    { name:"reload_plugins", description:"Reload plugins", parameters:{ type:"object", properties:{} } });
}
SG

# ---------- Plugin Example ----------
cat > "$REPO"/plugins/example-plugin/index.ts << 'PLG'
const strategies = [
  { id:"pe-value", name:"低市盈率选股", description:"筛选市盈率低于指定值的股票", category:"long-term",
    params:[{key:"max_pe",label:"最大市盈率",type:"number",default:15}],
    execute:(data:any[], params:any) => data.filter((s:any)=>s.pe>0&&s.pe<=(params.max_pe||15)).map((s:any)=>({code:s.code,name:s.name,score:80,signals:["低市盈率"],metrics:{pe:s.pe}})) },
  { id:"pb-value", name:"破净选股", description:"筛选市净率小于1的股票", category:"long-term",
    params:[{key:"max_pb",label:"最大市净率",type:"number",default:1}],
    execute:(data:any[], params:any) => data.filter((s:any)=>s.pb>0&&s.pb<=(params.max_pb||1)).map((s:any)=>({code:s.code,name:s.name,score:85,signals:["破净"],metrics:{pb:s.pb}})) },
  { id:"volume-surge", name:"放量上涨", description:"筛选放量上涨的股票", category:"short-term",
    params:[{key:"min_volume_ratio",label:"最小量比",type:"number",default:1.5}],
    execute:(data:any[], params:any) => data.filter((s:any)=>s.change_pct>0&&s.turnover>(params.min_volume_ratio||1.5)).map((s:any)=>({code:s.code,name:s.name,score:75,signals:["放量上涨"],metrics:{turnover:s.turnover,change_pct:s.change_pct}})) },
  { id:"limit-up", name:"涨停监测", description:"检测涨停/接近涨停的股票", category:"short-term",
    params:[{key:"min_pct",label:"最小涨幅",type:"number",default:9.5}],
    execute:(data:any[], params:any) => data.filter((s:any)=>s.change_pct>=(params.min_pct||9.5)).map((s:any)=>({code:s.code,name:s.name,score:95,signals:["涨停"],metrics:{change_pct:s.change_pct}})) },
  { id:"high-turnover", name:"换手活跃", description:"筛选换手率活跃的股票", category:"short-term",
    params:[{key:"min_turnover",label:"最小换手率",type:"number",default:3}],
    execute:(data:any[], params:any) => data.filter((s:any)=>s.turnover>=(params.min_turnover||3)).map((s:any)=>({code:s.code,name:s.name,score:70,signals:["换手活跃"],metrics:{turnover:s.turnover}})) },
];
export default { id:"example-plugin", name:"示例插件", version:"1.0.0", description:"内置策略插件", strategies };
PLG

# ---------- Frontend HTML ----------
cat > "$REPO"/frontend/dist/index.html << 'HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>股海操盘手 — AI Agent</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0d1117; color:#c9d1d9; height:100vh; display:flex; flex-direction:column; }
  header { padding:12px 20px; background:#161b22; border-bottom:1px solid #30363d; display:flex; align-items:center; gap:10px; flex-shrink:0; }
  header h1 { font-size:18px; font-weight:600; color:#58a6ff; }
  header .badge { font-size:11px; color:#8b949e; background:#21262d; padding:2px 8px; border-radius:10px; }
  #chat { flex:1; overflow-y:auto; padding:16px 20px; display:flex; flex-direction:column; gap:12px; }
  .msg { max-width:85%; padding:10px 14px; border-radius:8px; line-height:1.6; font-size:14px; white-space:pre-wrap; word-break:break-word; }
  .msg.user { background:#1f6feb; color:#fff; align-self:flex-end; }
  .msg.assistant { background:#21262d; color:#c9d1d9; align-self:flex-start; border:1px solid #30363d; }
  .msg.system { background:transparent; color:#8b949e; align-self:center; font-size:12px; font-style:italic; }
  .msg.assistant.loading { opacity:0.7; }
  .msg.assistant.loading::after { content:"▊"; animation:blink 0.8s infinite; }
  @keyframes blink { 50% { opacity:0; } }
  .msg.assistant pre { background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:10px; margin:6px 0; overflow-x:auto; font-size:13px; }
  .msg.assistant code { background:#161b22; padding:1px 4px; border-radius:3px; font-size:13px; }
  #input-bar { padding:12px 20px; background:#161b22; border-top:1px solid #30363d; display:flex; gap:8px; flex-shrink:0; }
  #input-bar textarea { flex:1; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:10px 12px; font-size:14px; font-family:inherit; resize:none; outline:none; min-height:44px; max-height:120px; }
  #input-bar textarea:focus { border-color:#58a6ff; }
  #input-bar button { background:#238636; color:#fff; border:none; border-radius:6px; padding:0 20px; font-size:14px; font-weight:600; cursor:pointer; white-space:nowrap; transition:background 0.2s; }
  #input-bar button:hover { background:#2ea043; }
  #input-bar button:disabled { background:#21262d; color:#484f58; cursor:not-allowed; }
  ::-webkit-scrollbar { width:8px; }
  ::-webkit-scrollbar-track { background:#161b22; }
  ::-webkit-scrollbar-thumb { background:#30363d; border-radius:4px; }
</style>
</head>
<body>
<header>
  <h1>🧠 股海操盘手</h1>
  <span class="badge">AI Agent</span>
</header>
<div id="chat">
  <div class="msg system">连接成功，输入指令开始分析</div>
</div>
<div id="input-bar">
  <textarea id="input" rows="1" placeholder="输入指令...（Enter发送，Shift+Enter换行）"></textarea>
  <button id="send-btn">发送</button>
</div>
<script>
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  let isStreaming = false;

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);

  function addMsg(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = content;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || isStreaming) return;
    input.value = ''; input.style.height = 'auto';
    sendBtn.disabled = true; isStreaming = true;
    addMsg('user', text);
    const assistantEl = addMsg('assistant loading', '');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        assistantEl.textContent = 'Error: ' + await res.text();
        assistantEl.className = 'msg assistant';
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'token') {
                assistantEl.textContent += parsed.content;
              } else if (parsed.type === 'error') {
                assistantEl.textContent = 'Error: ' + parsed.content;
                assistantEl.className = 'msg assistant';
              }
            } catch {}
          }
        }
        chat.scrollTop = chat.scrollHeight;
      }
    } catch (e) {
      assistantEl.textContent = 'Error: ' + e.message;
    }
    assistantEl.className = 'msg assistant';
    isStreaming = false;
    sendBtn.disabled = false;
    input.focus();
  }

  input.addEventListener('input', function() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
</script>
</body>
</html>
HTML

# ---------- web-server.ts ----------
cat > "$REPO"/ai-agent/src/web-server.ts << 'WS'
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { ToolRegistry } from "./tools/registry";
import { registerFileTools } from "./tools/file-tools";
import { registerStockTools, getStocks } from "./tools/stock-info";
import { registerStrategyTools } from "./tools/strategy-validator";
import { registerOptimizeTools } from "./tools/strategy-optimize";
import { registerRiskTools } from "./tools/risk-assessment";
import { registerFrontendTools } from "./tools/frontend-actions";
import { registerStrategyGeneratorTools } from "./tools/strategy-generator";
import { clearActions, frontendActions } from "./tools/frontend-actions";
import { Memory } from "./memory/memory";
import { CompactEngine } from "./memory/compact";
import { Agent } from "./agents/agent";

const PORT = parseInt(process.env["AI_AGENT_PORT"] || "5910", 10);
const DATA_DIR = process.env["AI_AGENT_DATA_DIR"] || path.join(process.cwd(), "data");
const FRONTEND_DIR = path.resolve(__dirname, "..", "..", "frontend", "dist");
const CACHE_MAX_AGE = 86400;
const MESSAGES_FILE = path.join(DATA_DIR, "chat-messages.json");

const dataDir = DATA_DIR;
fs.mkdirSync(dataDir, { recursive: true });
const registry = new ToolRegistry();
registerFileTools(registry);
registerStockTools(registry);
registerStrategyTools(registry);
registerOptimizeTools(registry);
registerRiskTools(registry);
registerFrontendTools(registry);
registerStrategyGeneratorTools(registry);
const memory = new Memory(dataDir);
const compact = new CompactEngine(30);
const agent = new Agent(registry, memory, {
  verbose: process.argv.includes("--verbose"),
  systemPrompt: `你是一个股海操盘手，帮助用户管理股票筛选策略并分析市场数据。

你有以下工具可用：

文件工具：read_file, write_file, bash, glob, grep

行情工具：
- search_stocks(query, limit) — 按代码或名称搜索股票
- get_stock_detail(code) — 获取单只股票的详细行情
- get_kline(code, market, days) — 获取K线数据
- market_overview() — 全市场概览

策略工具：
- list_strategies(category) — 列出所有可用策略
- run_multi_strategy(strategies_json, combine_mode, limit) — 多策略联合筛选

参数优化工具：
- optimize_strategy(strategy_id, param, min, max, steps, ...) — 网格搜索最优参数

风险工具：
- assess_portfolio_risk(codes_json, weights_json, total_value) — 投资组合风险评估
- assess_stock_risk(code) — 单只股票风险评估

策略生成工具：
- generate_strategy(plugin_id, plugin_name, description, strategies_json) — AI生成新策略
- reload_plugins() — 重新加载所有插件

界面操作工具：
- run_screen(strategies?) — 【唯一选股工具】执行选股并推送到前端

⚠️ 重要规则：
1. 执行选股时只能用 run_screen 工具
2. run_screen 会同时返回数据给你分析并推送到前端界面
3. 步骤：list_strategies查策略 → run_screen执行`,
});

// ===== Plugin Loader =====
function findPluginsDir(): string | null {
  for (const dir of [path.resolve(process.cwd(), "..", "plugins"), path.resolve(process.cwd(), "plugins")]) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {}
  }
  return null;
}
let loadedPlugins: any[] | null = null;
function loadAllPlugins(): any[] {
  if (loadedPlugins) return loadedPlugins;
  const pluginsDir = findPluginsDir();
  if (!pluginsDir) { loadedPlugins = []; return []; }
  const plugins: any[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(pluginsDir, entry.name, "index.ts");
    const indexJsPath = path.join(pluginsDir, entry.name, "index.js");
    let entryPath = fs.existsSync(indexPath) ? indexPath : (fs.existsSync(indexJsPath) ? indexJsPath : null);
    if (!entryPath) continue;
    try {
      delete require.cache[entryPath];
      const mod = require(entryPath);
      const plugin = mod.default || mod;
      if (plugin && plugin.id && plugin.name && Array.isArray(plugin.strategies)) plugins.push(plugin);
    } catch {}
  }
  loadedPlugins = plugins;
  return plugins;
}
loadAllPlugins();

// ===== Static File Serving =====
const MIME: Record<string,string> = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"application/javascript; charset=utf-8", ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon" };
function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  let fp = path.normalize(path.join(FRONTEND_DIR, urlPath));
  if (!fp.startsWith(FRONTEND_DIR)) return false;
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp).toLowerCase();
    const isAsset = ext !== ".html";
    res.writeHead(200, { "Content-Type": MIME[ext]||"application/octet-stream", "Cache-Control": isAsset ? `public, max-age=${CACHE_MAX_AGE}` : "no-cache" });
    res.end(fs.readFileSync(fp));
    return true;
  }
  const indexPath = path.join(FRONTEND_DIR, "index.html");
  if (fs.existsSync(indexPath)) { res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); res.end(fs.readFileSync(indexPath)); return true; }
  return false;
}

// ===== REST Handlers =====
async function handleHealth(): Promise<string> { return JSON.stringify({status:"ok", pluginCount:loadAllPlugins().length}); }
async function handlePlugins(): Promise<string> { return JSON.stringify({plugins:loadAllPlugins()}); }
async function handleScreen(body: any): Promise<string> {
  const strategies: Array<{pluginId:string;strategyId:string;params:any}> = body.strategies;
  if (!Array.isArray(strategies)||strategies.length===0) return JSON.stringify({error:"strategies array required"});
  const stocks = await getStocks();
  const plugins = loadAllPlugins();
  const allResults: Array<{name:string;results:any[]}> = [];
  for (const item of strategies) {
    const p = plugins.find((p:any)=>p.id===item.pluginId);
    const s = p?.strategies?.find((s:any)=>s.id===item.strategyId);
    if (s) try { allResults.push({name:s.name, results:s.execute(stocks, item.params||{})}); } catch { allResults.push({name:s.name, results:[]}); }
  }
  const agg = new Map<string,any>();
  for (const {results} of allResults) {
    for (const r of results) {
      if (!agg.has(r.code)) agg.set(r.code, {name:r.name,score:0,signals:[],metrics:r.metrics||{},count:0});
      const e = agg.get(r.code)!; e.score += r.score; e.signals.push(...r.signals); Object.assign(e.metrics, r.metrics||{}); e.count++;
    }
  }
  const results = Array.from(agg.entries()).map(([code,v])=>({code,name:v.name,score:Math.round(v.score/v.count),signals:[...new Set(v.signals)],metrics:v.metrics})).sort((a,b)=>b.score-a.score);
  return JSON.stringify({results:results.slice(0,200), stats:{totalStocks:stocks.length, matchedStocks:results.length, executionTime:Date.now()-body._start||0}});
}
function readBody(req: http.IncomingMessage): Promise<string> { return new Promise((resolve,reject)=>{const c:Buffer[]=[];let s=0;req.on("data",(ch:Buffer)=>{c.push(ch);s+=ch.length});req.on("end",()=>resolve(Buffer.concat(c,s).toString("utf-8")));req.on("error",reject);}); }
function loadMessages(): any[] { try { if (fs.existsSync(MESSAGES_FILE)) return JSON.parse(fs.readFileSync(MESSAGES_FILE,"utf-8")); } catch{} return [{role:"assistant",content:"连接成功，输入指令开始分析"}]; }
function saveMessages(msgs: any[]): void { try { fs.mkdirSync(path.dirname(MESSAGES_FILE),{recursive:true}); fs.writeFileSync(MESSAGES_FILE,JSON.stringify(msgs,null,2),"utf-8"); } catch{} }

// ===== HTTP Server =====
function startServer(port: number, maxRetries = 3): void {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url||"/", `http://${req.headers.host}`);
    const pn = url.pathname;
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Content-Type");
    if (req.method==="OPTIONS") { res.writeHead(204); res.end(); return; }
    try {
      if (pn==="/api/health"&&req.method==="GET") { res.writeHead(200,{"Content-Type":"application/json"}); res.end(await handleHealth()); return; }
      if (pn==="/api/plugins"&&req.method==="GET") { res.writeHead(200,{"Content-Type":"application/json"}); res.end(await handlePlugins()); return; }
      if (pn==="/api/screen"&&req.method==="POST") { const body=JSON.parse(await readBody(req)); body._start=Date.now(); res.writeHead(200,{"Content-Type":"application/json"}); res.end(await handleScreen(body)); return; }
      if (pn==="/api/messages"&&req.method==="GET") { res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({messages:loadMessages()})); return; }
      if (pn==="/api/messages"&&req.method==="POST") { const p=JSON.parse(await readBody(req)); if(Array.isArray(p.messages)){saveMessages(p.messages);res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({status:"ok"}));}else{res.writeHead(400);res.end(JSON.stringify({error:"messages array required"}));} return; }
      if (pn==="/api/chat"&&req.method==="POST") {
        const p=JSON.parse(await readBody(req)); const msg=p.message;
        if (!msg||typeof msg!=="string") { res.writeHead(400); res.end(JSON.stringify({error:"message required"})); return; }
        res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"});
        clearActions();
        try { await agent.run(msg, (t:string)=>res.write(`data: ${JSON.stringify({type:"token",content:t})}\n\n`)); } catch(e:any){res.write(`data: ${JSON.stringify({type:"error",content:String(e)})}\n\n`);}
        for (const a of frontendActions) res.write(`data: ${JSON.stringify({type:"action",action:a.type,payload:a.payload})}\n\n`);
        res.write("data: [DONE]\n\n"); res.end(); return;
      }
      if (req.method==="GET") { if (serveStatic(res, pn==="/"?"/index.html":pn)) return; }
      res.writeHead(404); res.end("Not Found");
    } catch(e:any){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
  });
  srv.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code==="EADDRINUSE"&&maxRetries>0) { console.log(`Port ${port} in use, trying ${port+1}...`); startServer(port+1, maxRetries-1); }
    else { console.error("Server error:", err.message); process.exit(1); }
  });
  srv.listen(port, "0.0.0.0", () => {
    console.log(`\n🧠 股海操盘手 — Unified Server`);
    console.log(`   http://localhost:${port}`);
    console.log(`   AI Chat: SSE streaming`);
    console.log(`   REST: /api/health, /api/plugins, /api/screen, /api/chat, /api/messages`);
  });
}
startServer(PORT);
WS

echo "  所有源码文件已写入 ✓"

# ---- 4. 安装依赖 ----
echo ""
echo "[4/5] 安装 npm 依赖..."
cd "$REPO"/ai-agent
npm install 2>&1 | tail -3
echo "  依赖安装完成 ✓"

# ---- 5. 启动服务 ----
echo ""
echo "[5/5] 启动服务..."
cd "$REPO"/ai-agent

# 停止旧进程
pm2 delete stock-screener 2>/dev/null || true
kill $(lsof -ti :5910 2>/dev/null) 2>/dev/null || true
sleep 1

export DEEPSEEK_API_KEY="$API_KEY"
export OPENAI_BASE_URL="https://api.deepseek.com/"
export OPENAI_API_KEY="$API_KEY"
export LLM_MODEL="deepseek-chat"
export AI_AGENT_PORT=5910

if command -v pm2 &> /dev/null; then
  pm2 start npx --name sclaw -- tsx src/web-server.ts
  pm2 save
  echo "  pm2 启动完成 ✓"
  echo "  管理命令: pm2 logs, pm2 restart sclaw, pm2 stop sclaw"
else
  npm install -g pm2
  pm2 start npx --name sclaw -- tsx src/web-server.ts
  pm2 save
fi

sleep 3
# 健康检查
HEALTH=$(curl -s http://localhost:5910/api/health 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q "ok"; then
  echo ""
  echo "========================================"
  echo "  ✅ 部署成功!"
  echo "  地址: http://YOUR_SERVER_IP:5910"
  echo "========================================"
else
  echo ""
  echo "  ⚠️  服务启动中，检查日志: pm2 logs sclaw"
fi

# 复制本脚本到服务器，方便后续更新
cp "$0" "$REPO/deploy.sh"
chmod +x "$REPO/deploy.sh"

echo ""
echo "  📝 以后更新只需在服务器上执行:"
echo "     cd /root/stock-screener && bash deploy.sh"
echo ""
