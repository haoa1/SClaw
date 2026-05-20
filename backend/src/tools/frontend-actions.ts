/**
 * Frontend Action Tools — allows AI to control the SClaw UI.
 * 
 * Tools:
 *   run_screen(strategies) — execute screening AND push results to frontend
 *     Automatically switches to results tab and highlights on completion.
 *
 * IMPORTANT: run_screen is the SINGLE tool for executing screening.
 * Strategy format: [{"id":"volume-surge","params":{"minChange":5}}]
 * OR simplified: {"id":"volume-surge","params":{}} for single strategy
 *
 * When you need to validate a single strategy, pass just one item in the array,
 * e.g. [{"id":"low-pe","params":{"maxPe":10}}] — run_screen handles it.
 */

import { ToolRegistry, Tool } from "./registry";

// Shared action queue — the SSE writer reads from this after agent.run()
export const frontendActions: Array<{
  type: string;
  payload: any;
}> = [];

export function clearActions(): void {
  frontendActions.length = 0;
}

export function registerFrontendTools(registry: ToolRegistry): void {
  registry.register(new Tool(
    "run_screen",
    `Execute stock screening, display results on the frontend, and auto-switch to results tab.

This is the MAIN and ONLY tool for running any screening. Pass strategies as JSON.

STRATEGY FORMAT:
  [{"id":"volume-surge","params":{"minChange":5,"minVolumeRatio":1.5}},{"id":"high-turnover","params":{}}]

Strategy IDs come from list_strategies (e.g. volume-surge, high-turnover, low-pe, limit-up, day-swing).

SINGLE STRATEGY: pass just one item in the array, e.g. [{"id":"low-pe","params":{"maxPe":10}}]

Returns screening data AND pushes results to the UI. Always use this when user asks to run screening.
Never use list_strategies tools for execution — only for discovering strategy IDs.`,
    [
      { name: "strategies", type: "string", description: 'JSON string of strategies array. Each item: {"id":"strategy-id","params":{}} or simplified {"id":"strategy-id"} (uses defaults). Strategy IDs from list_strategies. Example: [{"id":"volume-surge","params":{"minChange":5}},{"id":"high-turnover"}]', required: false },
    ],
    async (args) => {
      const strategiesStr = String(args.strategies || "");
      let strategiesArray: any[] = [];
      
      if (strategiesStr) {
        try {
          const parsed = JSON.parse(strategiesStr);
          if (Array.isArray(parsed)) {
            strategiesArray = parsed;
          } else if (parsed && parsed.id) {
            strategiesArray = [parsed];
          }
        } catch (e) {
          return `Error: invalid strategies JSON: ${e}`;
        }
      }
      
      // Normalize: add default pluginId
      const normalized = strategiesArray.map((s: any) => ({
        pluginId: s.pluginId || "example-plugin",
        strategyId: s.strategyId || s.id || "",
        params: s.params || {},
      })).filter((s: any) => s.strategyId);
      
      if (normalized.length === 0) {
        // Push without specific strategies (use frontend current selection)
        frontendActions.push({ type: "run_screen", payload: { strategies: normalized } });
        return `✅ 选股已触发（使用前端当前选择的策略），结果将显示在界面上。`;
      }

      // Call the screen API to get data for AI analysis + frontend display
      try {
        const http = require("http");
        
        const screenBody = JSON.stringify({ strategies: normalized });
        
        const result = await new Promise<string>((resolve, reject) => {
          const req = http.request({
            hostname: "localhost",
            port: 3001,
            path: "/api/screen",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }, (res: any) => {
            let data = "";
            res.on("data", (chunk: string) => data += chunk);
            res.on("end", () => resolve(data));
          });
          req.on("error", reject);
          req.write(screenBody);
          req.end();
        });
        
        const screenData = JSON.parse(result);
        const stats = screenData.stats || {};
        const results = screenData.results || [];

        // Push to frontend action queue WITH results data (for popup modal)
        frontendActions.push({
          type: "run_screen",
          payload: { strategies: normalized, results, stats },
        });

        const totalStocks = stats.totalStocks || 0;
        const matchedStocks = stats.matchedStocks || 0;
        const strategyLabels = normalized.map((s: any) => s.strategyId).join(", ");
        const top = results.slice(0, 20);
        
        const lines = [
          `✅ 选股已执行！结果已推送到前端界面。`,
          `运行 ${normalized.length} 个策略: ${strategyLabels}`,
          `扫描 ${totalStocks} 只股票，命中 ${matchedStocks} 只`,
          ``,
          `Top 20 结果：`,
          `  排名  代码      名称        评分  信号`,
          `  ────  ────────  ──────────  ────  ──────────────────────────────`,
          ...top.map((r: any, i: number) =>
            `  ${(i+1).toString().padEnd(4)} ${(r.code||"").padEnd(8)} ${(r.name||"").padEnd(10)} ${(r.score||0).toString().padEnd(4)} ${(r.signals||[]).join("; ").slice(0, 30)}`
          ),
        ];
        if (results.length > 20) lines.push(`  ... 还有 ${results.length - 20} 只未显示`);
        lines.push(``);
        lines.push(`💡 结果已显示在前端「选股结果」Tab 中！切换到浏览器查看详细表格。`);
        
        return lines.join("\n");
      } catch (e: unknown) {
        return `✅ 已推送 ${normalized.length} 个策略到前端。计算详情出错: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  ));
}
