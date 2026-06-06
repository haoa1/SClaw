/**
 * Unified Risk Tool — risk(portfolio|stock)
 *
 * Replaces: assess_portfolio_risk, assess_stock_risk
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { portfolioRiskTool, stockRiskTool } from "./risk-assessment";

// ===== Handler: dispatch by sub_cmd =====

const riskHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  if (!subCmd) return "❌ Error: sub_cmd is required. Options: portfolio, stock";

  switch (subCmd) {
    case "portfolio":
      return await portfolioRiskTool.fn(args);

    case "stock":
      return await stockRiskTool.fn(args);

    default:
      return `❌ Unknown sub_cmd: "${subCmd}". Options: portfolio, stock`;
  }
};

// ===== Params =====

const riskParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: `Sub-command: portfolio / stock

portfolio(codes_json, weights_json?, total_value?) — Assess portfolio risk
  codes_json: JSON array of stock codes, e.g. ["600000","600519","000333"]
  weights_json: Optional JSON object of weights by code (must sum to 1)
  total_value: Optional total portfolio value for position sizing
stock(code) — Assess individual stock risk (valuation, volatility, liquidity, market cap)
`,
  },
  // portfolio
  { name: "codes_json", type: "string", description: "JSON array of stock codes — for sub_cmd=portfolio", required: false },
  { name: "weights_json", type: "string", description: "Optional JSON object of weights by code (must sum to 1) — for sub_cmd=portfolio", required: false },
  { name: "total_value", type: "number", description: "Total portfolio value for position sizing — for sub_cmd=portfolio", required: false },
  // stock
  { name: "code", type: "string", description: "Stock code — for sub_cmd=stock", required: false },
];

// ===== Export =====

export const riskTool = new Tool(
  "risk",
  `Unified risk assessment tool. Use sub_cmd to choose operation.

portfolio(codes_json, weights_json?, total_value?) → Assess portfolio: concentration, sector, VaR
stock(code) → Assess individual stock risk factors

Examples:
  risk(sub_cmd="portfolio", codes_json='["600519","000333","600036"]')
  risk(sub_cmd="portfolio", codes_json='["600519","000333"]', total_value=1000000)
  risk(sub_cmd="stock", code="600519")
`,
  riskParams,
  riskHandler,
);

export function registerRiskTool(registry: ToolRegistry): void {
  registry.register(riskTool);
}
