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
import { login, logout, validateSession, getUsersList } from "../../backend/dist/auth";

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
    res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
    if (req.method==="OPTIONS") { res.writeHead(204); res.end(); return; }
    try {
      // === Auth routes ===
      if (pn==="/api/login"&&req.method==="POST") {
        const body=JSON.parse(await readBody(req));
        const session = login(body.username, body.password);
        if (!session) { res.writeHead(401,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:"Invalid credentials"})); return; }
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({token:session.token,user:{id:session.userId,username:session.username,displayName:session.displayName,role:session.role}})); return;
      }
      if (pn==="/api/logout"&&req.method==="POST") {
        const body=JSON.parse(await readBody(req));
        logout(body.token||"");
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({status:"ok"})); return;
      }
      if (pn==="/api/me"&&req.method==="GET") {
        const token = (req.headers["authorization"]||"").replace("Bearer ","") || url.searchParams.get("token")||"";
        const session = validateSession(token);
        if (!session) { res.writeHead(401,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:"Unauthorized"})); return; }
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({user:{id:session.userId,username:session.username,displayName:session.displayName,role:session.role}})); return;
      }
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
