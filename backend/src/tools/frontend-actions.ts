/**
 * Frontend Action Tools — allows AI to control the SClaw UI.
 * 
 * Per-user action queue: each user's AI actions are stored separately,
 * preventing cross-user contamination when multiple users chat simultaneously.
 *
 * Tools:
 *   run_screen(strategies) — execute screening AND push results to frontend
 *     Automatically switches to results tab and highlights on completion.
 */

import { ToolRegistry, Tool } from "./registry";
import { getCurrentUserId } from "../request-context";

// ===== Per-user action queue =====
// Map<userId, Array<action>> — each user gets their own isolated queue.
const _userActions = new Map<string, Array<{ type: string; payload: any }>>();

export function clearUserActions(userId: string): void {
  _userActions.set(userId, []);
}

export function pushUserAction(userId: string, type: string, payload: any): void {
  let actions = _userActions.get(userId);
  if (!actions) {
    actions = [];
    _userActions.set(userId, actions);
  }
  actions.push({ type, payload });
}

/** Drain and return all pending actions for a user. Resets the queue. */
export function drainUserActions(userId: string): Array<{ type: string; payload: any }> {
  const actions = _userActions.get(userId) || [];
  _userActions.delete(userId);
  return actions;
}

/** Legacy global aliases — keep for backward compat, but deprecated. */
export const frontendActions: Array<{ type: string; payload: any }> = [];
export function clearActions(): void { frontendActions.length = 0; }

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
        const userId = getCurrentUserId();
        if (userId) pushUserAction(userId, "run_screen", { strategies: normalized });
        return `Screen triggered (using frontend's current strategy selection), results will display on the interface.`;
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

        // Push to per-user frontend action queue
        const userId = getCurrentUserId();
        if (userId) {
          pushUserAction(userId, "run_screen", {
            strategies: normalized,
            results,
            stats,
          });
        }

        const totalStocks = stats.totalStocks || 0;
        const matchedStocks = stats.matchedStocks || 0;
        const strategyLabels = normalized.map((s: any) => s.strategyId).join(", ");
        const top = results.slice(0, 20);
        
        const lines = [
          `Screen executed! Results pushed to frontend.`,
          `Ran ${normalized.length} strategies: ${strategyLabels}`,
          `Scanned ${totalStocks} stocks, matched ${matchedStocks}`,
          ``,
          `Top 20 results:`,
          `  Rank  Code      Name        Score  Signals`,
          `  ----  --------  ----------  -----  ------------------------------`,
          ...top.map((r: any, i: number) =>
            `  ${(i+1).toString().padEnd(4)} ${(r.code||"").padEnd(8)} ${(r.name||"").padEnd(10)} ${(r.score||0).toString().padEnd(4)} ${(r.signals||[]).join("; ").slice(0, 30)}`
          ),
        ];
        if (results.length > 20) lines.push(`  ... ${results.length - 20} more not shown`);
        lines.push(``);
        lines.push(`Results are displayed in the frontend "Results" tab — switch to your browser to see the detailed table.`);
        
        return lines.join("\n");
      } catch (e: unknown) {
        return `Pushed ${normalized.length} strategies to frontend. Calculation detail: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  ));
}
