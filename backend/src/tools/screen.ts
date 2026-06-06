/**
 * Unified Screen Tool — screen(run|list|multi)
 *
 * Replaces: run_screen (frontend-actions), list_strategies, run_multi_strategy (strategy-validator)
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { listStrategiesTool, multiStrategyTool } from "./strategy-validator";
import { getCurrentUserId } from "../request-context";
import { pushUserAction } from "./frontend-actions";

// ===== run_screen logic (from frontend-actions.ts) =====

const runScreenFn = async (args: Record<string, unknown>): Promise<string> => {
  const strategiesStr = String(args.strategies || "");
  let strategiesArray: any[] = [];

  if (strategiesStr) {
    try {
      const parsed = JSON.parse(strategiesStr);
      if (Array.isArray(parsed)) strategiesArray = parsed;
      else if (parsed && parsed.id) strategiesArray = [parsed];
    } catch (e) {
      return `Error: invalid strategies JSON: ${e}`;
    }
  }

  const normalized = strategiesArray.map((s: any) => ({
    pluginId: s.pluginId || "example-plugin",
    strategyId: s.strategyId || s.id || "",
    params: s.params || {},
  })).filter((s: any) => s.strategyId);

  if (normalized.length === 0) {
    const userId = getCurrentUserId();
    if (userId) pushUserAction(userId, "run_screen", { strategies: normalized });
    return "Screen triggered (using frontend's current strategy selection), results will display on the interface.";
  }

  try {
    const http = require("http");
    const screenBody = JSON.stringify({ strategies: normalized });
    const result = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        hostname: "localhost", port: 3001, path: "/api/screen",
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

    const userId = getCurrentUserId();
    if (userId) pushUserAction(userId, "run_screen", { strategies: normalized, results, stats });

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
      `  Rank  Code      Name        Score  Chg%   VolRatio  Signals`,
      `  ----  --------  ----------  -----  -----  --------  ------------------------------`,
      ...top.map((r: any, i: number) => {
        const chgPct = r.changePercent != null ? (r.changePercent > 0 ? "+" : "") + r.changePercent.toFixed(1) : "N/A";
        const volRatio = r.volumeRatio != null ? r.volumeRatio.toFixed(2) : "N/A";
        return `  ${(i + 1).toString().padEnd(4)} ${(r.code || "").padEnd(8)} ${(r.name || "").padEnd(10)} ${(r.score || 0).toString().padEnd(4)} ${chgPct.padEnd(5)} ${volRatio.padEnd(8)} ${(r.signals || []).join("; ").slice(0, 20)}`;
      }),
    ];
    if (results.length > 20) lines.push(`  ... ${results.length - 20} more not shown`);
    lines.push(``);
    lines.push(`Results are displayed in the frontend "Results" tab — switch to your browser to see the detailed table.`);
    return lines.join("\n");
  } catch (e: unknown) {
    return `Pushed ${normalized.length} strategies to frontend. Calculation detail: ${e instanceof Error ? e.message : String(e)}`;
  }
};

// ===== Handler: dispatch by sub_cmd =====

const screenHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  if (!subCmd) return "❌ Error: sub_cmd is required. Options: run, list, multi";

  switch (subCmd) {
    case "run":
      return await runScreenFn(args);

    case "list": {
      const listResult = listStrategiesTool.fn(args);
      return typeof listResult === "string" ? listResult : await listResult;
    }

    case "multi":
      return await multiStrategyTool.fn(args);

    default:
      return `❌ Unknown sub_cmd: "${subCmd}". Options: run, list, multi`;
  }
};

// ===== Params =====

const screenParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: `Sub-command: run / list / multi

run(strategies?) — Execute stock screening, display results on frontend
list(category?) — List available strategies (filter by category)
multi(strategies_json, combine_mode?, limit?) — Run multiple strategies simultaneously
  combine_mode: 'score' (intersection, need ≥40% hits) or 'union' (all matches)
  strategies_json format: [{"id":"low-pe","params":{"maxPe":10}},{"id":"volume-surge"}]
`,
  },
  // run
  { name: "strategies", type: "string", description: 'JSON string of strategies array for sub_cmd=run. Each: {"id":"strategy-id","params":{}}', required: false },
  // list
  { name: "category", type: "string", description: "Filter by category (long-term, mid-term, short-term, day-trade) — for sub_cmd=list", required: false },
  // multi
  { name: "strategies_json", type: "string", description: "JSON array of strategy configs — for sub_cmd=multi", required: false },
  { name: "combine_mode", type: "string", description: "score (intersection) or union (all matches) — for sub_cmd=multi", required: false },
  { name: "limit", type: "number", description: "Max results to show — for sub_cmd=multi", required: false },
];

// ===== Export =====

export const screenTool = new Tool(
  "screen",
  `Unified stock screening tool. Use sub_cmd to choose operation.

run(strategies?) → Execute screening, push results to frontend
list(category?) → List available strategy descriptions and parameters
multi(strategies_json, combine_mode?, limit?) → Run multiple strategies together

run is the MAIN screening tool — use it when user asks to run screening.
list is for DISCOVERY — find strategy IDs before running.
multi is for CROSS-VALIDATION — run several strategies at once.

Examples:
  screen(sub_cmd="list")
  screen(sub_cmd="list", category="short-term")
  screen(sub_cmd="run", strategies='[{"id":"volume-surge","params":{"minChange":5}}]')
  screen(sub_cmd="multi", strategies_json='[{"id":"low-pe","params":{"maxPe":10}},{"id":"volume-surge"}]')
`,
  screenParams,
  screenHandler,
);

export function registerScreenTool(registry: ToolRegistry): void {
  registry.register(screenTool);
}
