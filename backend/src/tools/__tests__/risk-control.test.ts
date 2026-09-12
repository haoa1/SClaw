/**
 * 三档风控执行骨架单元测试 (Three-Tier Risk Control Skeleton)
 *
 * 验收: 代码遵循三档模型, 触发即出单。
 * 覆盖:
 *   - computeTier: 牛/震荡/熊/冰点 × 风险 × 仓位 → 1/2/3 档
 *   - isEmptyPosition: 空仓判定(现金≥99.9% / 残留碎股<1%)
 *   - assessOrder: 允许/自动/需确认/红线 (gate)
 *   - executeOrder: 档位允许且未触红线 → 自动出单(触发即出单); 红线 → 暂停/拦截
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeTier,
  isEmptyPosition,
  assessOrder,
  executeOrder,
  TIER_POSITION_CAP,
  type PortfolioState,
  type OrderIntent,
  type TradeExecutor,
} from "../risk-control";

// ===== 固定测试资产 =====

// 空仓: 现金≈28,347.97, 无持仓 → cash/totalAssets = 100%
const EMPTY_STATE: PortfolioState = {
  totalAssets: 28347.97,
  cash: 28347.97,
  positions: [],
};

// 非空仓: 半仓持有贵州茅台(50000/100000)
const HALF_STATE: PortfolioState = {
  totalAssets: 100000,
  cash: 50000,
  positions: [{ code: "600519", name: "贵州茅台", qty: 1000, currentPrice: 50.0 }],
};

// 残留碎股: 现金99.9% + 持仓0.1% → 视为空仓
const RESIDUAL_STATE: PortfolioState = {
  totalAssets: 100000,
  cash: 99900,
  positions: [{ code: "600519", name: "贵州茅台", qty: 5, currentPrice: 20.0 }],
};

function order(side: "buy" | "sell", price: number, qty: number, code = "600519"): OrderIntent {
  return { side, code, price, qty };
}

// ===== computeTier: 三档模型 =====

describe("computeTier - 三档风控模型", () => {
  it("牛 + 低风险 + 空仓 → 档位1(进攻)", () => {
    expect(computeTier("牛", "低", 0)).toBe(1);
  });

  it("牛 + 中风险 → 档位1(进攻, 牛市优先)", () => {
    expect(computeTier("牛", "中", 0)).toBe(1);
  });

  it("震荡 + 中风险 → 档位2(均衡)", () => {
    expect(computeTier("震荡", "中", 0.1)).toBe(2);
  });

  it("震荡 + 低风险 → 档位1(进攻)", () => {
    expect(computeTier("震荡", "低", 0.1)).toBe(1);
  });

  it("熊 + 低风险 → 档位3(防守)", () => {
    expect(computeTier("熊", "低", 0)).toBe(3);
  });

  it("冰点 → 档位3(防守, 冰点禁止开仓)", () => {
    expect(computeTier("冰点", "低", 0)).toBe(3);
  });

  it("高组合风险 → 档位3(防守)", () => {
    expect(computeTier("牛", "高", 0)).toBe(3);
  });

  it("近满仓(positionPct≥99%) → 档位3(防守)", () => {
    expect(computeTier("牛", "低", 0.99)).toBe(3);
  });
});

// ===== isEmptyPosition: 空仓条件 =====

describe("isEmptyPosition - 空仓条件", () => {
  it("无持仓 + 现金100% → 空仓", () => {
    expect(isEmptyPosition(EMPTY_STATE)).toBe(true);
  });

  it("残留碎股(<1%持仓, 现金99.9%) → 视为空仓", () => {
    expect(isEmptyPosition(RESIDUAL_STATE)).toBe(true);
  });

  it("半仓持仓 → 非空仓", () => {
    expect(isEmptyPosition(HALF_STATE)).toBe(false);
  });

  it("总资产≤0 → 非空仓", () => {
    expect(isEmptyPosition({ totalAssets: 0, cash: 0, positions: [] })).toBe(false);
  });
});

// ===== assessOrder: 闸控 (gate) =====

describe("assessOrder - 闸控", () => {
  it("档位1 + 小单买入(空仓) → 允许 + 自动执行(触发即出单)", () => {
    const d = assessOrder(order("buy", 10, 100), EMPTY_STATE, { regime: "牛", riskLevel: "低" });
    expect(d.tier).toBe(1);
    expect(d.allowed).toBe(true);
    expect(d.autoExecute).toBe(true);
    expect(d.requiresConfirmation).toBe(false);
    expect(d.maxPositionPct).toBeCloseTo(TIER_POSITION_CAP[1], 5);
  });

  it("档位2 + 小单买入(空仓) → 允许 + 自动执行", () => {
    const d = assessOrder(order("buy", 10, 100), EMPTY_STATE, { regime: "震荡", riskLevel: "中" });
    expect(d.tier).toBe(2);
    expect(d.allowed).toBe(true);
    expect(d.autoExecute).toBe(true);
  });

  it("档位1 + 大单买入(超30%仓位上限) → 拦截(单策略仓位超限)", () => {
    // price=100*100=10000 → 10000/28347.97≈35.3% > 30%
    const d = assessOrder(order("buy", 100, 100), EMPTY_STATE, { regime: "牛", riskLevel: "低" });
    expect(d.allowed).toBe(false);
    expect(d.requiresConfirmation).toBe(true);
    expect(d.redLine).toContain("仓位超限");
  });

  it("档位1 + 单笔过大(15%~30%之间) → 需确认(单笔过大红线)", () => {
    // price=80*100=8000 → 8000/28347.97≈28.2% > 15% 且 < 30%
    const d = assessOrder(order("buy", 80, 100), EMPTY_STATE, { regime: "牛", riskLevel: "低" });
    expect(d.allowed).toBe(true);
    expect(d.autoExecute).toBe(false);
    expect(d.requiresConfirmation).toBe(true);
    expect(d.redLine).toContain("单笔过大");
  });

  it("档位3(熊市) + 买入 → 直接拦截, 禁止新开仓", () => {
    const d = assessOrder(order("buy", 10, 100), EMPTY_STATE, { regime: "熊", riskLevel: "低" });
    expect(d.tier).toBe(3);
    expect(d.allowed).toBe(false);
    expect(d.requiresConfirmation).toBe(true);
    expect(d.redLine).toContain("禁止新开仓");
  });

  it("任意档位 + 卖出 → 允许 + 自动执行(降风险动作)", () => {
    const d = assessOrder(order("sell", 100, 100), EMPTY_STATE, { regime: "熊", riskLevel: "高" });
    expect(d.allowed).toBe(true);
    expect(d.autoExecute).toBe(true);
  });
});

// ===== executeOrder: 触发即出单 =====

describe("executeOrder - 触发即出单", () => {
  it("档位1小单自动 → 调用executor出单, executed=true", async () => {
    const executor: TradeExecutor = vi.fn(async (side, code, price, qty) => ({ status: 200, data: { side, code, price, qty } }));
    const r = await executeOrder(order("buy", 10, 100), EMPTY_STATE, { regime: "牛", riskLevel: "低" }, executor);
    expect(r.executed).toBe(true);
    expect(executor).toHaveBeenCalledWith("buy", "600519", 10, 100);
    expect(r.message).toContain("已出单");
  });

  it("档位3(熊市)买入 → 拦截, 不调用executor", async () => {
    const executor: TradeExecutor = vi.fn(async () => ({ status: 200, data: {} }));
    const r = await executeOrder(order("buy", 10, 100), EMPTY_STATE, { regime: "熊", riskLevel: "低" }, executor);
    expect(r.executed).toBe(false);
    expect(executor).not.toHaveBeenCalled();
    expect(r.message).toContain("拦截");
  });

  it("档位1单笔过大 → 暂停待确认, 不调用executor", async () => {
    const executor: TradeExecutor = vi.fn(async () => ({ status: 200, data: {} }));
    const r = await executeOrder(order("buy", 80, 100), EMPTY_STATE, { regime: "牛", riskLevel: "低" }, executor);
    expect(r.executed).toBe(false);
    expect(executor).not.toHaveBeenCalled();
    expect(r.message).toContain("暂停");
  });

  it("executor抛错 → executed=false, 返回错误信息", async () => {
    const executor: TradeExecutor = vi.fn(async () => { throw new Error("trade bridge down"); });
    const r = await executeOrder(order("buy", 10, 100), EMPTY_STATE, { regime: "牛", riskLevel: "低" }, executor);
    expect(r.executed).toBe(false);
    expect(r.message).toContain("出单失败");
  });
});
