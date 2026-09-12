/**
 * 三档风控执行骨架 (Three-Tier Risk Control Execution Skeleton)
 *
 * 在已有 risk(portfolio|stock) 评估工具之上，补齐「执行闸控」：
 *   - 三档风控模型：决定允许开仓/自动下单/需确认的边界
 *   - 空仓条件：判定账户是否为空仓（满足才允许新开仓）
 *   - 触发即出单：档位允许且未触红线 → 自动调 Garuda Trade Bridge 下单
 *
 * ── 三档模型 ──
 *  Tier 1 进攻 (offense) : regime=牛，或 (震荡 且 组合低风险)      → 自动执行，单策略上限 30%，单笔>30%资产触发红线暂停
 *  Tier 2 均衡 (balanced) : regime=震荡 且 组合中风险              → 小单自动，单笔>15%或触及全仓触发红线暂停，单策略上限 15%
 *  Tier 3 防守 (defense) : regime=熊/冰点，或 组合高风险，或 近满仓  → 禁止新开仓（buy 直接拦截），只允许卖出/持币
 *
 * ── 空仓条件 ──
 *  无股票持仓 且 现金 ≥ 总资产 99.9%；或 持仓市值 < 总资产 1%（视为残留碎股）
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { callGaruda } from "./trade";

// ===== Types =====

export type RiskTier = 1 | 2 | 3;

export type Regime = "牛" | "震荡" | "熊" | "冰点";
export type RiskLevel = "高" | "中" | "低";

export interface Position {
  code: string;
  name?: string;
  qty: number;
  currentPrice: number;
  strategy?: string;
}

export interface PortfolioState {
  totalAssets: number; // 总资产（现金+持仓市值）
  cash: number; // 可用现金
  positions: Position[];
}

export interface OrderIntent {
  side: "buy" | "sell";
  code: string;
  name?: string;
  price: number;
  qty: number;
  strategy?: string;
}

export interface RiskDecision {
  tier: RiskTier;
  tierName: string;
  allowed: boolean; // 是否允许下单
  autoExecute: boolean; // 是否自动提交（触发即出单）
  requiresConfirmation: boolean; // 是否需人工确认（红线暂停）
  redLine?: string; // 命中的红线说明
  maxPositionPct: number; // 当前档位单策略允许仓位上限
  reason: string; // 判定理由
}

// ===== 三档常量 =====

// 单策略仓位上限 (%)（按档位）
export const TIER_POSITION_CAP: Record<RiskTier, number> = {
  1: 0.3, // 进攻：30%
  2: 0.15, // 均衡：15%
  3: 0, // 防守：禁止新开仓
};

// 红线常量
export const RED_LINE = {
  FULL_POSITION_PCT: 0.99, // 全仓红线：现金/持仓触及99%总资产仍加仓
  SINGLE_ORDER_PCT_TIER1: 0.15, // Tier1 单笔过大红线（单笔≤15%总资产）
  SINGLE_ORDER_PCT_TIER2: 0.08, // Tier2 单笔过大红线（单笔≤8%总资产）
  EMPTY_POSITION_CASH_PCT: 0.999, // 空仓：现金≥99.9%总资产
  EMPTY_POSITION_RESIDUAL_PCT: 0.01, // 空仓：持仓市值<1%总资产（碎股）
};

export const TIER_NAMES: Record<RiskTier, string> = {
  1: "进攻",
  2: "均衡",
  3: "防守",
};

// ===== 纯函数：三档风控 =====

/**
 * 判定当前风控档位。
 * @param regime 大盘环境（牛/震荡/熊/冰点）
 * @param riskLevel 组合风险等级（由 risk(portfolio) 给出）
 * @param positionPct 当前已投入仓位占比（持仓市值/总资产）
 */
export function computeTier(regime: Regime, riskLevel: RiskLevel, positionPct: number): RiskTier {
  // 冰点 / 高风险 / 近满仓 → 防守
  if (regime === "冰点" || riskLevel === "高" || positionPct >= RED_LINE.FULL_POSITION_PCT) {
    return 3;
  }
  // 熊市 → 防守
  if (regime === "熊") {
    return 3;
  }
  // 震荡 + 中风险 → 均衡
  if (regime === "震荡" && riskLevel === "中") {
    return 2;
  }
  // 其余（牛 或 震荡+低风险）→ 进攻
  return 1;
}

/**
 * 空仓判定。
 * 满足 - 无股票持仓 且 现金 ≥ 99.9% 总资产
 *      - 或 持仓市值 < 1% 总资产（残留碎股）
 */
export function isEmptyPosition(state: PortfolioState): boolean {
  const { totalAssets, cash, positions } = state;
  if (totalAssets <= 0) return false;

  const positionValue = positions.reduce((s, p) => s + p.qty * p.currentPrice, 0);
  const cashPct = cash / totalAssets;
  const positionPct = positionValue / totalAssets;

  // 无股票持仓 且 现金占比达标
  const noPosition = positions.length === 0 || positionValue <= 0;
  if (noPosition && cashPct >= RED_LINE.EMPTY_POSITION_CASH_PCT) return true;
  // 残留碎股
  if (positionPct < RED_LINE.EMPTY_POSITION_RESIDUAL_PCT && cashPct >= RED_LINE.EMPTY_POSITION_CASH_PCT) return true;

  return false;
}

/**
 * 评估一笔订单是否符合三档风控（闸控核心）。
 * 返回 allowed / autoExecute / requiresConfirmation / redLine。
 */
export function assessOrder(
  intent: OrderIntent,
  state: PortfolioState,
  context: { regime: Regime; riskLevel: RiskLevel },
): RiskDecision {
  const positionPct = state.totalAssets > 0
    ? state.positions.reduce((s, p) => s + p.qty * p.currentPrice, 0) / state.totalAssets
    : 0;
  const tier = computeTier(context.regime, context.riskLevel, positionPct);
  const tierName = TIER_NAMES[tier];
  const cap = TIER_POSITION_CAP[tier];

  // 卖出（sell）：任何档位允许（降风险动作），自动执行
  if (intent.side === "sell") {
    return {
      tier,
      tierName,
      allowed: true,
      autoExecute: true,
      requiresConfirmation: false,
      maxPositionPct: cap,
      reason: `档位${tier}(${tierName}) 卖出=降风险动作，自动执行`,
    };
  }

  // 买入（buy）
  const orderValue = intent.price * intent.qty;
  const orderPct = state.totalAssets > 0 ? orderValue / state.totalAssets : 0;

  // Tier 3 防守：禁止新开仓
  if (tier === 3) {
    return {
      tier,
      tierName,
      allowed: false,
      autoExecute: false,
      requiresConfirmation: true,
      redLine: "防守档禁止新开仓（熊/冰点/高风险/近满仓）",
      maxPositionPct: 0,
      reason: `档位${tier}(${tierName}) 禁止买入——「${context.regime}」+ 组合风险「${context.riskLevel}」封开仓`,
    };
  }

  // 空仓条件下才允许新开仓（已持仓加仓需谨慎，这里按"只有空仓才允许新开仓"的骨架规则）
  if (!isEmptyPosition(state) && !hasPosition(state, intent.code)) {
    // 已有持仓但想加仓不同标的：骨架阶段保守，视为需确认（除非极低风险 Tier1）
    if (tier === 1) {
      // Tier1 允许在非空仓下继续建仓，但单笔过大需确认
      if (orderPct > RED_LINE.SINGLE_ORDER_PCT_TIER1) {
        return {
          tier, tierName, allowed: true, autoExecute: false, requiresConfirmation: true,
          redLine: `单笔过大(${(orderPct * 100).toFixed(1)}% > ${(RED_LINE.SINGLE_ORDER_PCT_TIER1 * 100).toFixed(0)}%)`,
          maxPositionPct: cap,
          reason: `档位${tier}(${tierName}) 单笔${(orderPct * 100).toFixed(1)}% 触发红线，需确认`,
        };
      }
      return {
        tier, tierName, allowed: true, autoExecute: true, requiresConfirmation: false,
        maxPositionPct: cap,
        reason: `档位${tier}(${tierName}) 单笔${(orderPct * 100).toFixed(1)}% 在限内，自动执行`,
      };
    }
    // Tier2 非空仓建仓 → 需确认
    return {
      tier, tierName, allowed: true, autoExecute: false, requiresConfirmation: true,
      redLine: "非空仓加仓（Tier2 均衡）",
      maxPositionPct: cap,
      reason: `档位${tier}(${tierName}) 非空仓加仓，需人工确认`,
    };
  }

  // 空仓（或本代码已有持仓加仓）→ 按档位上限 + 单笔红线
  if (orderPct > cap) {
    return {
      tier, tierName, allowed: false, autoExecute: false, requiresConfirmation: true,
      redLine: `单策略仓位超限(${(orderPct * 100).toFixed(1)}% > ${(cap * 100).toFixed(0)}%)`,
      maxPositionPct: cap,
      reason: `档位${tier}(${tierName}) 单笔${(orderPct * 100).toFixed(1)}% 超过档位上限${(cap * 100).toFixed(0)}%，拦截`,
    };
  }

  const singleOrderLine = tier === 1 ? RED_LINE.SINGLE_ORDER_PCT_TIER1 : RED_LINE.SINGLE_ORDER_PCT_TIER2;
  if (orderPct > singleOrderLine) {
    return {
      tier, tierName, allowed: true, autoExecute: false, requiresConfirmation: true,
      redLine: `单笔过大(${(orderPct * 100).toFixed(1)}% > ${(singleOrderLine * 100).toFixed(0)}%)`,
      maxPositionPct: cap,
      reason: `档位${tier}(${tierName}) 单笔${(orderPct * 100).toFixed(1)}% 触发【单笔过大】红线，需确认`,
    };
  }

  return {
    tier, tierName, allowed: true, autoExecute: true, requiresConfirmation: false,
    maxPositionPct: cap,
    reason: `档位${tier}(${tierName}) 单笔${(orderPct * 100).toFixed(1)}% 在限内，自动执行（触发即出单）`,
  };
}

function hasPosition(state: PortfolioState, code: string): boolean {
  return state.positions.some((p) => p.code === code);
}

// ===== 执行层：触发即出单 =====

export type TradeExecutor = (
  side: "buy" | "sell",
  code: string,
  price: number,
  qty: number,
) => Promise<{ status: number; data: unknown }>;

const defaultExecutor: TradeExecutor = (side, code, price, qty) =>
  callGaruda("POST", `/api/trade/${side}`, { code, price, qty });

/**
 * 执行订单：走三档闸控。
 *  - 允许 且 自动 → 直接出单（调 Garuda Trade Bridge）
 *  - 允许 但 需确认 → 不实际下单，返回"暂停待确认"
 *  - 不允许 → 拦截
 * executor 参数可注入（测试用），默认调 trade bridge。
 */
export async function executeOrder(
  intent: OrderIntent,
  state: PortfolioState,
  context: { regime: Regime; riskLevel: RiskLevel },
  executor?: TradeExecutor,
): Promise<{ executed: boolean; decision: RiskDecision; message: string }> {
  const decision = assessOrder(intent, state, context);
  if (!decision.allowed) {
    return {
      executed: false,
      decision,
      message: `⛔ 拦截：${decision.reason}${decision.redLine ? `（红线：${decision.redLine}）` : ""}`,
    };
  }
  if (decision.requiresConfirmation) {
    return {
      executed: false,
      decision,
      message: `⏸ 暂停待确认：${decision.reason}（红线：${decision.redLine}）。未实际下单。`,
    };
  }
  // 触发即出单
  const fn = executor ?? defaultExecutor;
  const orderValue = intent.price * intent.qty;
  try {
    const res = await fn(intent.side, intent.code, intent.price, intent.qty);
    const ok = res.status < 300;
    return {
      executed: ok,
      decision,
      message: ok
        ? `✅ 已出单：${intent.side} ${intent.code}${intent.name ? " " + intent.name : ""} ${intent.qty}股 @ ¥${intent.price}（${(orderValue).toFixed(2)}元）— ${decision.reason}`
        : `⚠️ 出单返回异常(status ${res.status})：${JSON.stringify(res.data)}`,
    };
  } catch (e: unknown) {
    return {
      executed: false,
      decision,
      message: `❌ 出单失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ===== Tool: risk_control =====

const riskControlParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: `操作: tier / gate / empty_position / execute

tier(regime,risk_level,position_pct) → 判定当前三档(1进攻/2均衡/3防守)
empty_position(cash,total_assets,positions_json) → 判定是否空仓
gate(side,code,price,qty,regime,risk_level,cash,total_assets,positions_json) → 评估一笔订单(是否允许/自动/需确认/红线)
execute(side,code,price,qty,regime,risk_level,cash,total_assets,positions_json) → 闸控后自动出单(触发即出单)
`,
  },
  { name: "side", type: "string", description: "buy / sell", required: false },
  { name: "code", type: "string", description: "股票代码", required: false },
  { name: "name", type: "string", description: "股票名称(可选)", required: false },
  { name: "price", type: "number", description: "价格", required: false },
  { name: "qty", type: "integer", description: "数量(股)", required: false },
  { name: "regime", type: "string", description: "牛/震荡/熊/冰点", required: false },
  { name: "risk_level", type: "string", description: "组合风险 高/中/低", required: false },
  { name: "position_pct", type: "number", description: "当前已投入仓位占比(用于tier)", required: false },
  { name: "cash", type: "number", description: "可用现金", required: false },
  { name: "total_assets", type: "number", description: "总资产", required: false },
  { name: "positions_json", type: "string", description: 'JSON 数组 [{"code":"600519","qty":100,"currentPrice":150.0}]', required: false },
];

function parsePositions(positionsJson?: string): Position[] {
  if (!positionsJson) return [];
  try {
    const arr = JSON.parse(positionsJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const riskControlHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  const regime = (args.regime as Regime) || "震荡";
  const riskLevel = (args.risk_level as RiskLevel) || "中";
  const cash = (args.cash as number) || 0;
  const totalAssets = (args.total_assets as number) || 0;
  const positions = parsePositions(args.positions_json as string);
  const state: PortfolioState = { totalAssets, cash, positions };

  switch (subCmd) {
    case "tier": {
      const pct = typeof args.position_pct === "number" ? args.position_pct : 0;
      const tier = computeTier(regime, riskLevel, pct);
      return `🎯 三档判定: 档位${tier}(${TIER_NAMES[tier]}) — regime=${regime}, 风险=${riskLevel}, 已投=${(pct * 100).toFixed(1)}%\n单策略仓位上限：${(TIER_POSITION_CAP[tier] * 100).toFixed(0)}%`;
    }
    case "empty_position": {
      const empty = isEmptyPosition(state);
      const pct = totalAssets > 0 ? (cash / totalAssets) * 100 : 0;
      return empty
        ? `🈳 空仓：现金≈${pct.toFixed(2)}% 总资产（${cash.toFixed(2)}元）`
        : `✋ 非空仓：现金≈${pct.toFixed(2)}%，持仓 ${positions.length} 只`;
    }
    case "gate":
    case "execute": {
      const side = (args.side as "buy" | "sell") || "buy";
      const code = (args.code as string || "").trim();
      const price = args.price as number;
      const qty = args.qty as number;
      if (!code || !price || !qty) return "❌ 需要 code, price, qty";
      const intent: OrderIntent = { side, code, name: args.name as string, price, qty, strategy: args.strategy as string };
      if (subCmd === "gate") {
        const d = assessOrder(intent, state, { regime, riskLevel });
        const parts = [
          `🧭 风控闸控｜档位${d.tier}(${d.tierName})｜${d.allowed ? (d.autoExecute ? "✅ 自动执行" : "⏸ 需确认") : "⛔ 拦截"}`,
          `${intent.side} ${intent.code}${intent.name ? " " + intent.name : ""} ${intent.qty}股@¥${intent.price}（${(intent.price * intent.qty).toFixed(2)}元）`,
          `理由: ${d.reason}`,
        ];
        if (d.redLine) parts.push(`红线: ${d.redLine}`);
        parts.push(`档位单策略上限: ${(d.maxPositionPct * 100).toFixed(0)}%`);
        return parts.join("\n");
      }
      const r = await executeOrder(intent, state, { regime, riskLevel });
      return `${r.message}\n（执行状态: ${r.executed ? "已出单" : "未出单"}）`;
    }
    default:
      return `❌ 未知 sub_cmd: "${subCmd}". 可用: tier, gate, empty_position, execute`;
  }
};

const riskControlTool = new Tool(
  "risk_control",
  `三档风控执行骨架。判定风控档位(1进攻/2均衡/3防守)、空仓条件、订单闸控，并在允许时触发即出单。

用法:
  risk_control(sub_cmd="tier", regime="牛", risk_level="低", position_pct=0.1)
  risk_control(sub_cmd="empty_position", cash=28000, total_assets=28300, positions_json='[]')
  risk_control(sub_cmd="gate", side="buy", code="600519", price=150, qty=100, regime="牛", risk_level="低", cash=28000, total_assets=28300, positions_json='[]')
  risk_control(sub_cmd="execute", side="buy", code="600519", price=150, qty=100, regime="牛", risk_level="低", cash=28000, total_assets=28300, positions_json='[]')

注意: execute 仅在「档位允许 + 未触红线」时自动出单；触红线返回暂停待确认，不实际下单。`,
  riskControlParams,
  riskControlHandler,
);

export function registerRiskControlTool(registry: ToolRegistry): void {
  registry.register(riskControlTool);
}
