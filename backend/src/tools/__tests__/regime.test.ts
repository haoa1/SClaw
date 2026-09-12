import { describe, it, expect } from "vitest";
import {
  determineRegime,
  sma,
  computeUpDownRatio,
  tradingElapsedFraction,
  REGIME_RULE,
  type RegimeInput,
} from "../regime";

// 构造一组升序收盘价，便于控制 MA20 与斜率
function makeCloses(closeNow: number, deltaPerDay: number, days = 25): number[] {
  const arr: number[] = [];
  let price = closeNow - deltaPerDay * (days - 1);
  for (let i = 0; i < days; i++) {
    arr.push(price);
    price += deltaPerDay;
  }
  return arr;
}

const base = (over: Partial<RegimeInput>): RegimeInput => ({
  indexCloses: makeCloses(100, 0.5, 30), // 上升趋势
  advanceCount: 3000,
  declineCount: 1000,
  limitUpCount: 80,
  limitDownCount: 5,
  totalTurnover: 1.5e12,
  ...over,
});

describe("sma", () => {
  it("计算简单移动平均", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
  });
  it("数据不足返回 NaN", () => {
    expect(sma([1, 2], 5)).toBeNaN();
  });
});

describe("computeUpDownRatio", () => {
  it("上涨多于下跌时 >1", () => {
    expect(computeUpDownRatio(3000, 1000)).toBe(3);
  });
  it("下跌家数为0时不除零", () => {
    expect(computeUpDownRatio(2000, 0)).toBe(2000);
  });
});

describe("tradingElapsedFraction（交易日时段归一）", () => {
  it("开盘前为 0", () => {
    expect(tradingElapsedFraction(new Date(2026, 8, 10, 9, 0))).toBe(0);
  });
  it("上午 10:30 → 60/240 = 25%", () => {
    expect(tradingElapsedFraction(new Date(2026, 8, 10, 10, 30))).toBeCloseTo(0.25, 5);
  });
  it("午休时段 → 上午已满 = 50%", () => {
    expect(tradingElapsedFraction(new Date(2026, 8, 10, 12, 0))).toBeCloseTo(0.5, 5);
  });
  it("下午 14:00 → (120+60)/240 = 75%", () => {
    expect(tradingElapsedFraction(new Date(2026, 8, 10, 14, 0))).toBeCloseTo(0.75, 5);
  });
  it("收盘后 → 100%", () => {
    expect(tradingElapsedFraction(new Date(2026, 8, 10, 16, 0))).toBe(1);
  });
});

describe("determineRegime", () => {
  it("牛：价在MA20上、MA20上行、涨跌比>2、放量", () => {
    const r = determineRegime(base({}));
    expect(r.regime).toBe("牛");
    expect(r.metrics.upDownRatio).toBe(3);
    expect(r.basis.length).toBeGreaterThan(0);
  });

  it("熊：价在MA20下、MA20下行、涨跌比<0.8", () => {
    const r = determineRegime(
      base({
        indexCloses: makeCloses(100, -0.5, 30),
        advanceCount: 800,
        declineCount: 2200,
        totalTurnover: 9e11,
      }),
    );
    expect(r.regime).toBe("熊");
  });

  it("冰点：成交额塌陷 + 涨停稀少", () => {
    const r = determineRegime(
      base({
        totalTurnover: 6e11, // < 阈值1.2e12 × 0.7 = 8.4e11
        limitUpCount: 10, // < 20
      }),
    );
    expect(r.regime).toBe("冰点");
    expect(r.metrics.turnoverVsThreshold).toBeLessThan(0.7);
  });

  it("早盘低成交额不再误判冰点（时段归一修复）", () => {
    const r = determineRegime(
      base({
        totalTurnover: 6e11, // 全天口径 < 8.4e11 → 若不归一会误判冰点
        limitUpCount: 10,
        now: new Date(2026, 8, 10, 9, 35), // 仅过去 5 分钟 → 归一阈值≈2.5e10
      }),
    );
    expect(r.regime).not.toBe("冰点");
    expect(r.metrics.elapsedFraction).toBeCloseTo(5 / 240, 5);
    expect(r.metrics.turnoverVsThreshold).toBeLessThan(0.7); // 全天口径仍"塌陷"
    expect(r.metrics.turnoverVsTimeAdjThreshold).toBeGreaterThan(1); // 时段口径并不塌陷
  });

  it("尾盘同样成交额仍判冰点（时段已接近满）", () => {
    const r = determineRegime(
      base({
        totalTurnover: 6e11,
        limitUpCount: 10,
        now: new Date(2026, 8, 10, 14, 59), // 239/240
      }),
    );
    expect(r.regime).toBe("冰点");
    expect(r.metrics.elapsedFraction).toBeCloseTo(239 / 240, 5);
  });

  it("不传 now 时保持全天口径（向后兼容）", () => {
    const r = determineRegime(base({ totalTurnover: 6e11, limitUpCount: 10 }));
    expect(r.regime).toBe("冰点");
    expect(r.metrics.elapsedFraction).toBe(1);
    expect(r.metrics.turnoverVsTimeAdjThreshold).toBeCloseTo(
      r.metrics.turnoverVsThreshold,
      10,
    );
  });

  it("震荡：贴均线 + 涨跌比中性（牛信号不足）", () => {
    // 涨跌比1.5，未达牛(>2)，也未达熊条件
    const r = determineRegime(
      base({
        advanceCount: 1500,
        declineCount: 1000,
        totalTurnover: 1.0e12,
      }),
    );
    expect(r.regime).toBe("震荡");
  });

  it("震荡：未达任何强信号（下跌但涨跌比中性）", () => {
    const r = determineRegime(
      base({
        indexCloses: makeCloses(100, -0.1, 30), // 小幅下行但 MA 走平
        advanceCount: 1200,
        declineCount: 1200,
        totalTurnover: 1.0e12,
      }),
    );
    expect(r.regime).toBe("震荡");
  });

  it("自定义成交额阈值起作用", () => {
    const r = determineRegime(
      base({ totalTurnover: 1.0e12, turnoverThreshold: 9e11 }),
    );
    // 1.0e12 > 9e11 → 放量成立，且其余满足牛条件
    expect(r.regime).toBe("牛");
  });
});

describe("REGIME_RULE 常量", () => {
  it("阈值合理", () => {
    expect(REGIME_RULE.MA_PERIOD).toBe(20);
    expect(REGIME_RULE.FREEZE_LIMITUP_MAX).toBe(20);
    expect(REGIME_RULE.BULL_RATIO_MIN).toBe(2);
    expect(REGIME_RULE.SESSION_MORNING).toEqual([570, 690]);
    expect(REGIME_RULE.SESSION_AFTERNOON).toEqual([780, 900]);
    expect(REGIME_RULE.TURNOVER_MIN_ELAPSED_FRAC).toBeCloseTo(1 / 240, 10);
  });
});
