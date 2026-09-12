import { describe, it, expect } from "vitest";
import {
  isCounterTrend,
  classifyCategory,
  limitUpThresholdFor,
  computeDailyPct,
  detectDay,
  computeHypothesisStats,
  COUNTER_TREND_RULE,
  type CounterTrendInstance,
} from "../countertrend";

describe("classifyCategory", () => {
  it("涨停：主板 ≥9.8 归为 limit_up", () => {
    expect(classifyCategory(10.05, 3, COUNTER_TREND_RULE)).toBe("limit_up");
  });
  it("双创涨停阈值走 19.8（limitUpThresholdFor 判定）", () => {
    expect(limitUpThresholdFor("300750")).toBe(19.8);
    expect(limitUpThresholdFor("688001")).toBe(19.8);
    expect(limitUpThresholdFor("600000")).toBe(9.8);
  });
  it("强势上涨：≥3% 未涨停归 strong_up", () => {
    expect(classifyCategory(5, 2, COUNTER_TREND_RULE)).toBe("strong_up");
  });
  it("相对强势：微涨但强于指数≥3pp 归 relative_strong", () => {
    // pctChg=1%，指数 -2.5%，relative=3.5pp ≥3 → relative_strong
    expect(classifyCategory(1, 3.5, COUNTER_TREND_RULE)).toBe("relative_strong");
  });
  it("不满足任何：下跌或不够强 → null", () => {
    expect(classifyCategory(-2, 1, COUNTER_TREND_RULE)).toBeNull();
    expect(classifyCategory(0.5, 1, COUNTER_TREND_RULE)).toBeNull();
  });
});

describe("isCounterTrend", () => {
  it("非逆风日（指数平/涨）一律不纳入", () => {
    // 指数 +0.5%（> -0.3），即便个股涨停也不纳入
    const r = isCounterTrend(10, 0.5, 1e9);
    expect(r.hit).toBe(false);
  });
  it("逆风日 + 涨停 + 足量 → hit", () => {
    const r = isCounterTrend(10.05, -1, 2e8);
    expect(r.hit).toBe(true);
    expect(r.category).toBe("limit_up");
  });
  it("逆风日 + 强势上涨 + 足量 → hit", () => {
    const r = isCounterTrend(4, -1, 2e8);
    expect(r.hit).toBe(true);
    expect(r.category).toBe("strong_up");
  });
  it("逆风日 + 相对强势（微涨但强于指数≥3pp）→ hit", () => {
    const r = isCounterTrend(1, -2.5, 2e8); // rel=3.5
    expect(r.hit).toBe(true);
    expect(r.category).toBe("relative_strong");
  });
  it("流动性过滤：成交额 < 5000万 → 不纳入", () => {
    const r = isCounterTrend(10.05, -1, 1e6); // 100万成交
    expect(r.hit).toBe(false);
  });
  it("逆风日但个股下跌 → 不纳入", () => {
    const r = isCounterTrend(-2, -1, 2e8);
    expect(r.hit).toBe(false);
  });
});

describe("computeDailyPct", () => {
  it("相邻收盘价算逐日涨幅，首日为 NaN", () => {
    const closes = [
      { date: "2026-08-31", close: 100 },
      { date: "2026-09-01", close: 103 },
      { date: "2026-09-02", close: 102 },
    ];
    const out = computeDailyPct(closes);
    expect(out[0].pct).toBeNaN();
    expect(out[1].pct).toBeCloseTo(3);
    expect(out[2].pct).toBeCloseTo(-0.9709, 2);
  });
});

describe("detectDay", () => {
  const rows = [
    { code: "600001", name: "主板涨停", market: "SH" as const, pctChg: 10.02, amount: 3e8 },
    { code: "300001", name: "创业板强势", market: "SZ" as const, pctChg: 5.5, amount: 2e8 },
    { code: "000001", name: "相对强势", market: "SZ" as const, pctChg: 2.5, amount: 1.5e8 }, // rel=3.5pp ≥3
    { code: "600002", name: "下跌股", market: "SH" as const, pctChg: -3, amount: 2e8 },
    { code: "600003", name: "缩量涨停", market: "SH" as const, pctChg: 10, amount: 1e6 }, // 被流动性过滤
  ];

  it("逆风日 index=-1 检出 3 只（主板涨停/创业板强势/相对强势）", () => {
    const hits = detectDay("2026-09-02", -1, rows);
    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.code)).toEqual(["600001", "300001", "000001"]);
    expect(hits[0].category).toBe("limit_up");
    expect(hits[0].relStrength).toBeCloseTo(11.02);
  });

  it("非逆风日 index=+1 检出 0 只", () => {
    const hits = detectDay("2026-09-02", 1, rows);
    expect(hits.length).toBe(0);
  });
});

describe("computeHypothesisStats", () => {
  function mk(over: Partial<CounterTrendInstance>): CounterTrendInstance {
    return {
      detectDate: "2026-09-01",
      code: "600000",
      name: "test",
      market: "SH",
      pctChg: 5,
      amount: 2e8,
      indexPct: -1,
      relStrength: 6,
      category: "strong_up",
      ...over,
    };
  }

  it("无样本：conclusion 为样本不足", () => {
    const s = computeHypothesisStats([]);
    expect(s.totalDetected).toBe(0);
    expect(s.fulfilled).toBe(0);
    expect(s.conclusion).toContain("样本不足");
  });

  it("假说A（惯性）：次日普遍上涨且强于指数 → 假说A成立", () => {
    const samples = [
      mk({ code: "a", nextPct: 2, nextIndexPct: -1, nextRel: 3, fulfilled: true }),
      mk({ code: "b", nextPct: 1.5, nextIndexPct: -1, nextRel: 2.5, fulfilled: true }),
      mk({ code: "c", nextPct: 0.5, nextIndexPct: -1, nextRel: 1.5, fulfilled: true }),
    ];
    const s = computeHypothesisStats(samples);
    expect(s.fulfilled).toBe(3);
    expect(s.nextUpRate).toBe(1);
    expect(s.nextMeanRel).toBeGreaterThan(0);
    expect(s.conclusion).toContain("假说A");
  });

  it("假说B（补跌）：次日普遍下跌且弱于指数 → 假说B成立", () => {
    const samples = [
      mk({ code: "a", nextPct: -3, nextIndexPct: 0, nextRel: -3, fulfilled: true }),
      mk({ code: "b", nextPct: -1, nextIndexPct: 0, nextRel: -1, fulfilled: true }),
      mk({ code: "c", nextPct: -0.5, nextIndexPct: 0, nextRel: -0.5, fulfilled: true }),
    ];
    const s = computeHypothesisStats(samples);
    expect(s.nextUpRate).toBe(0);
    expect(s.nextMeanRel).toBeLessThan(0);
    expect(s.conclusion).toContain("假说B");
  });

  it("次日相对收益中位数计算正确", () => {
    const samples = [
      mk({ code: "a", nextRel: 2, nextPct: 1, fulfilled: true }),
      mk({ code: "b", nextRel: 4, nextPct: 3, fulfilled: true }),
      mk({ code: "c", nextRel: 6, nextPct: 5, fulfilled: true }),
    ];
    const s = computeHypothesisStats(samples);
    expect(s.nextMedianRel).toBe(4);
    expect(s.nextMedianPct).toBe(3);
  });

  it("byCategory 按分类聚合", () => {
    const samples = [
      mk({ code: "a", category: "limit_up", nextRel: 2, nextPct: 1, fulfilled: true }),
      mk({ code: "b", category: "limit_up", nextRel: -1, nextPct: -2, fulfilled: true }),
    ];
    const s = computeHypothesisStats(samples);
    expect(s.byCategory.limit_up.n).toBe(2);
    expect(s.byCategory.strong_up.n).toBe(0);
    expect(s.byCategory.limit_up.nextMeanRel).toBeCloseTo(0.5);
  });
});
