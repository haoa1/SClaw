/**
 * Risk assessment tools — portfolio risk analysis based on market data.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { getStocks } from "./stock-info";
import { StockData } from "../types";

// ===== Sector mapping (simplified) =====
// Maps stock code prefixes to sectors for concentration analysis

const SECTOR_MAP: Record<string, string> = {
  "600000": "银行",
  "600015": "银行", "601": "银行", "600016": "银行",
  "000001": "银行", "002142": "银行",
  "600030": "券商", "601688": "券商", "601211": "券商",
  "600519": "白酒", "000858": "白酒", "002304": "白酒", "600809": "白酒",
  "600036": "银行", "600585": "建材",
  "601318": "保险", "601628": "保险", "601601": "保险",
  "600887": "食品", "600882": "食品",
  "000333": "家电", "000651": "家电",
  "600104": "汽车", "000625": "汽车",
  "600276": "医药", "300760": "医药", "000538": "医药", "300015": "医药",
  "600900": "电力", "600011": "电力", "600023": "电力",
  "601857": "石油", "600028": "石油",
  "600050": "通信", "000063": "通信",
  "002415": "科技", "000725": "科技", "600703": "科技",
  "300750": "新能源", "002594": "新能源", "600438": "新能源",
  "688": "科技",
  "300": "创业板",
  "000": "主板",
  "002": "中小板",
  "600": "主板",
  "603": "主板",
};

function guessSector(code: string, name: string): string {
  // Try prefix match
  for (const [prefix, sector] of Object.entries(SECTOR_MAP)) {
    if (code.startsWith(prefix)) return sector;
  }
  // Try name match
  const nameSectors: Record<string, string> = {
    "银行": "银行", "保险": "保险", "证券": "券商", "医药": "医药",
    "科技": "科技", "新能源": "新能源", "白酒": "白酒", "食品": "食品",
    "电力": "电力", "地产": "地产", "建筑": "建筑", "汽车": "汽车",
  };
  for (const [kw, sector] of Object.entries(nameSectors)) {
    if (name.includes(kw)) return sector;
  }
  return "其他";
}

function getMarketCapCategory(cap: number | undefined): string {
  if (!cap || cap <= 0) return "未知";
  if (cap >= 1000e8) return "大盘 (>1000亿)";
  if (cap >= 100e8) return "中盘 (100-1000亿)";
  return "小盘 (<100亿)";
}

// ===== Tool: assess_portfolio_risk =====

const portfolioRiskParams: ToolParamDef[] = [
  { name: "codes_json", type: "string", description: "JSON array of stock codes, e.g. [\"600000\",\"600519\",\"000333\"]" },
  { name: "weights_json", type: "string", description: "Optional JSON object of weights by code, e.g. {\"600000\":0.3,\"600519\":0.5}. If omitted, equal weight.", required: false },
  { name: "total_value", type: "number", description: "Total portfolio value in yuan (for position sizing)", required: false },
];

const portfolioRiskFn = async (args: Record<string, unknown>): Promise<string> => {
  const codesJson = args.codes_json as string;
  const weightsJson = args.weights_json as string | undefined;
  const totalValue = args.total_value as number | undefined;

  if (!codesJson) return "Error: codes_json is required";

  let codes: string[];
  try { codes = JSON.parse(codesJson); }
  catch { return "Error: codes_json 格式无效"; }
  if (!Array.isArray(codes) || codes.length === 0) return "Error: codes_json 必须是包含股票代码的数组";
  if (codes.length > 50) return "Error: 最多支持50只股票";

  // Parse weights
  let weights: Record<string, number> | null = null;
  if (weightsJson) {
    try { weights = JSON.parse(weightsJson); }
    catch { return "Error: weights_json 格式无效"; }
    const wSum = Object.values(weights!).reduce((a, b) => a + b, 0);
    if (Math.abs(wSum - 1) > 0.01) return `Error: 权重之和应为1，当前为${wSum.toFixed(2)}`;
  } else {
    weights = null;
  }

  // Get stock data
  let stocks: StockData[];
  try { stocks = await getStocks(); }
  catch (e: unknown) { return `获取行情失败: ${e}`; }

  // Find stocks in portfolio
  const portfolio: Array<StockData & { weight: number }> = [];
  for (const code of codes) {
    const stock = stocks.find((s) => s.code === code);
    if (!stock) { return `未找到股票: ${code}`; }
    const weight = weights ? (weights[code] ?? 0) : (1 / codes.length);
    portfolio.push({ ...stock, weight });
  }

  // Normalize weights
  const totalWeight = portfolio.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return "Error: 权重之和必须大于0";
  for (const p of portfolio) p.weight = p.weight / totalWeight;

  // ===== Risk Calculations =====

  // 1. Concentration risk (Herfindahl-Hirschman Index)
  const hhi = portfolio.reduce((s, p) => s + p.weight * p.weight * 10000, 0); // 0-10000 scale
  const hhiLevel = hhi > 2500 ? "高" : hhi > 1500 ? "中" : "低";

  // 2. Sector concentration
  const sectorAlloc = new Map<string, number>();
  for (const p of portfolio) {
    const sector = guessSector(p.code, p.name);
    sectorAlloc.set(sector, (sectorAlloc.get(sector) ?? 0) + p.weight);
  }
  const topSector = [...sectorAlloc.entries()].sort((a, b) => b[1] - a[1]);
  const maxSectorWeight = topSector[0]?.[1] ?? 0;
  const sectorRisk = maxSectorWeight > 0.5 ? "高" : maxSectorWeight > 0.3 ? "中" : "低";

  // 3. Market cap diversification
  const capAlloc = new Map<string, number>();
  for (const p of portfolio) {
    const cat = getMarketCapCategory(p.marketCap);
    capAlloc.set(cat, (capAlloc.get(cat) ?? 0) + p.weight);
  }

  // 4. Individual position risk (max single position)
  const maxPos = portfolio.reduce((max, p) => p.weight > max.weight ? p : max, portfolio[0]);
  const maxPosRisk = maxPos.weight > 0.3 ? "高" : maxPos.weight > 0.15 ? "中" : "低";

  // 5. Value-at-Risk approximation (simplified)
  // Using average daily change as volatility proxy
  const avgAbsChange = portfolio.reduce(
    (s, p) => s + Math.abs(p.changePercent) * p.weight,
    0
  );
  const var95 = avgAbsChange * 1.65; // Simplified 95% VaR
  const positionValue = totalValue
    ? portfolio.map((p) => ({
        ...p,
        posValue: totalValue * p.weight,
        varAmount: totalValue * p.weight * (Math.abs(p.changePercent) * 1.65) / 100,
      }))
    : null;

  // 6. Overall risk score (0-100)
  let riskScore = 0;
  riskScore += hhi > 2500 ? 25 : hhi > 1500 ? 15 : 5;           // Concentration
  riskScore += maxSectorWeight > 0.5 ? 20 : maxSectorWeight > 0.3 ? 12 : 5; // Sector
  riskScore += maxPos.weight > 0.3 ? 15 : maxPos.weight > 0.15 ? 10 : 3;   // Single position
  riskScore += var95 > 5 ? 25 : var95 > 3 ? 15 : 8;              // Volatility
  riskScore = Math.min(100, riskScore);

  const riskLevel = riskScore > 70 ? "高风险" : riskScore > 40 ? "中等风险" : "低风险";

  // ===== Build output =====

  const lines: (string | null)[] = [
    `📊 投资组合风险评估`,
    `   组合: ${portfolio.length} 只股票`,
    totalValue ? `   总市值: ${(totalValue / 1e4).toFixed(0)}万元` : null,
    ``,
    `🛡️ 整体风险: ${riskLevel} (评分: ${riskScore}/100)`,
    ``,
    `📈 持仓明细:`,
    `  ${"代码".padEnd(8)} ${"名称".padEnd(10)} ${"权重".padEnd(6)} ${"价格".padEnd(8)} ${"涨跌幅".padEnd(8)} ${"PE".padEnd(6)} ${"市值".padEnd(12)} ${positionValue ? "持仓金额".padEnd(12) + "VaR(95%)".padEnd(10) : ""}`,
    `  ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(6)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(12)} ${positionValue ? "─".repeat(12) + "─".repeat(10) : ""}`,
  ];

  for (const p of portfolio) {
    const val = positionValue?.find((v) => v.code === p.code);
    lines.push(
      `  ${p.code.padEnd(8)} ${p.name.padEnd(10)} ${(p.weight * 100).toFixed(1).padEnd(5)}% ${p.price.toFixed(2).padEnd(8)} ${(p.changePercent >= 0 ? "+" : "") + p.changePercent.toFixed(2).padEnd(7)}% ${(p.pe ?? -1).toFixed(1).padEnd(6)} ${formatMarketCapShort(p.marketCap).padEnd(12)}` +
      (val ? ` ${(val.posValue / 1e4).toFixed(1).padEnd(11)}万 ${val.varAmount.toFixed(1).padEnd(9)}万` : "")
    );
  }

  // Risk breakdown
  lines.push(``);
  lines.push(`🔍 风险分解:`);
  lines.push(`  集中度风险 (HHI=${hhi.toFixed(0)}): ${hhiLevel}${hhiLevel === "高" ? " — 建议分散到至少5只不同股票" : ""}`);
  lines.push(`  行业集中度 (最大行业=${(maxSectorWeight * 100).toFixed(0)}%): ${sectorRisk}${sectorRisk === "高" ? " — 单个行业占比超过50%" : ""}`);
  lines.push(`  单票风险 (最大仓位=${(maxPos.weight * 100).toFixed(1)}%): ${maxPosRisk}${maxPosRisk === "高" ? " — 单只股票超过30%" : ""}`);
  lines.push(`  波动风险 (日均|涨跌幅|=${avgAbsChange.toFixed(2)}%, VaR95=${var95.toFixed(2)}%): ${riskScore > 60 ? "高" : riskScore > 30 ? "中" : "低"}`);

  // Sector allocation
  lines.push(``);
  lines.push(`🏭 行业分布:`);
  for (const [sector, alloc] of topSector) {
    const barLen = Math.round(alloc * 20);
    const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
    lines.push(`  ${sector.padEnd(10)} ${(alloc * 100).toFixed(1).padStart(5)}% ${bar}`);
  }

  // Market cap distribution
  lines.push(``);
  lines.push(`📏 市值分布:`);
  for (const [cat, alloc] of capAlloc.entries()) {
    lines.push(`  ${cat.padEnd(18)} ${(alloc * 100).toFixed(1)}%`);
  }

  // Recommendations
  const recs: string[] = [];
  if (hhiLevel === "高") recs.push("• 组合过于集中，建议增加持仓数量至8-15只不同股票");
  if (sectorRisk === "高") recs.push(`• "${topSector[0][0]}"行业占比过高(${(maxSectorWeight * 100).toFixed(0)}%)，建议控制在30%以内`);
  if (maxPosRisk === "高") recs.push(`• "${maxPos.name}"(${maxPos.code})仓位${(maxPos.weight * 100).toFixed(1)}%过高，建议控制在15%以内`);
  if (var95 > 5) recs.push("• 组合波动较大，可考虑加入低波动资产(如银行/公用事业股)对冲");
  if (recs.length === 0) recs.push("• 组合风险控制良好，当前状态较合理");

  lines.push(``);
  lines.push(`💡 建议:`);
  for (const r of recs) lines.push(`  ${r}`);

  return lines.filter((l) => l !== null).join("\n");
};

export const portfolioRiskTool = new Tool(
  "assess_portfolio_risk",
  "Assess portfolio risk: concentration, sector allocation, position sizing, VaR approximation",
  portfolioRiskParams,
  portfolioRiskFn
);

// ===== Tool: assess_stock_risk =====

const stockRiskParams: ToolParamDef[] = [
  { name: "code", type: "string", description: "Stock code" },
];

const stockRiskFn = async (args: Record<string, unknown>): Promise<string> => {
  const code = (args.code as string || "").trim();
  if (!code) return "Error: code is required";

  let stocks: StockData[];
  try { stocks = await getStocks(); }
  catch (e: unknown) { return `获取行情失败: ${e}`; }

  const stock = stocks.find((s) => s.code === code);
  if (!stock) return `未找到股票: ${code}`;

  const sector = guessSector(stock.code, stock.name);
  const capCat = getMarketCapCategory(stock.marketCap);

  // Risk factors
  const peRisk = stock.pe !== undefined && stock.pe > 0
    ? (stock.pe > 100 ? 20 : stock.pe > 50 ? 15 : stock.pe > 30 ? 10 : 5)
    : 15;
  const pbRisk = stock.pb !== undefined && stock.pb > 0
    ? (stock.pb > 10 ? 15 : stock.pb > 5 ? 10 : stock.pb > 2 ? 5 : 3)
    : 10;
  const turnoverRisk = stock.turnoverRate !== undefined
    ? (stock.turnoverRate > 10 ? 15 : stock.turnoverRate > 5 ? 10 : 5)
    : 8;
  const volRisk = Math.abs(stock.changePercent) > 5 ? 20
    : Math.abs(stock.changePercent) > 3 ? 12 : 5;
  const capRisk = stock.marketCap !== undefined
    ? (stock.marketCap < 30e8 ? 20 : stock.marketCap < 100e8 ? 12 : stock.marketCap < 500e8 ? 6 : 3)
    : 10;
  const negativePERisk = stock.pe !== undefined && stock.pe < 0 ? 10 : 0;

  const totalRisk = Math.min(100, peRisk + pbRisk + turnoverRisk + volRisk + capRisk + negativePERisk);
  const riskLevel = totalRisk > 60 ? "高风险" : totalRisk > 35 ? "中等风险" : "低风险";

  const lines: string[] = [
    `🔍 个股风险评估: ${stock.code} ${stock.name}`,
    `   行业: ${sector} | 市值: ${formatMarketCapShort(stock.marketCap)} | 当前价: ${stock.price.toFixed(2)}`,
    ``,
    `🛡️ 整体评估: ${riskLevel} (风险评分: ${totalRisk}/100)`,
    ``,
    `📋 风险因素分解:`,
    `  ├─ 估值风险 (PE=${stock.pe ?? "-"}, PB=${stock.pb ?? "-"}): ${peRisk + pbRisk}/35分`,
    `  │  ${stock.pe !== undefined && stock.pe > 50 ? "⚠ PE偏高" : stock.pe !== undefined && stock.pe > 0 ? "✓ PE合理" : "— PE为负或无数据"}`,
    `  ${negativePERisk > 0 ? "├─ 亏损风险 (PE为负): 10/10分\n  │  ⚠ 公司处于亏损状态\n" : "│"}`,
    `  ├─ 波动风险 (日涨跌=${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%): ${volRisk}/20分`,
    `  │  ${Math.abs(stock.changePercent) > 5 ? "⚠ 日内波动剧烈" : Math.abs(stock.changePercent) > 3 ? "⚡ 波动较大" : "✓ 波动适中"}`,
    `  ├─ 流动性风险 (换手率=${stock.turnoverRate?.toFixed(2) ?? "-"}%): ${turnoverRisk}/15分`,
    `  │  ${stock.turnoverRate !== undefined ? (stock.turnoverRate > 10 ? "⚠ 换手率过高，筹码不稳定" : stock.turnoverRate < 0.3 ? "⚠ 流动性不足" : "✓ 流动性正常") : "— 无换手率数据"}`,
    `  └─ 市值风险 (${capCat}): ${capRisk}/20分`,
    `     ${stock.marketCap !== undefined && stock.marketCap < 50e8 ? "⚠ 小盘股波动大" : stock.marketCap !== undefined && stock.marketCap > 500e8 ? "✓ 大盘股较稳健" : "—"}`,
    ``,
    `💡 结论:`,
    ...generateStockAdvice(stock, totalRisk, riskLevel, sector),
  ];

  return lines.join("\n");
};

function generateStockAdvice(stock: StockData, riskScore: number, riskLevel: string, sector: string): string[] {
  const recs: string[] = [];
  if (riskLevel === "高风险") {
    recs.push("• 该股票风险较高，建议控制仓位在总组合5%以内");
    if (stock.pe !== undefined && stock.pe > 80) recs.push("• PE极高，注意估值回归风险");
    if (Math.abs(stock.changePercent) > 5) recs.push("• 日内波动大，不适合稳健型投资者");
  } else if (riskLevel === "中等风险") {
    recs.push("• 中等风险水平，建议仓位控制在10-15%");
    if (stock.pe !== undefined && stock.pe > 40) recs.push("• PE偏高，关注盈利增长能否支撑估值");
  } else {
    recs.push("• 低风险水平，可作为组合底仓");
  }
  return recs;
}

export const stockRiskTool = new Tool(
  "assess_stock_risk",
  "Assess individual stock risk: valuation, volatility, liquidity, market cap risk factors",
  stockRiskParams,
  stockRiskFn
);

// ===== Register =====

export function registerRiskTools(registry: ToolRegistry): void {
  registry.register(portfolioRiskTool);
  registry.register(stockRiskTool);
}

// ===== Helpers =====

function formatMarketCapShort(cap: number | undefined): string {
  if (!cap) return "-";
  if (cap >= 1e12) return `${(cap / 1e12).toFixed(2)}万亿`;
  if (cap >= 1e8) return `${(cap / 1e8).toFixed(1)}亿`;
  return `${(cap / 1e4).toFixed(0)}万`;
}
