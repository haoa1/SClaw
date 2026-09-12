/**
 * 大盘 regime 判定 (Market Regime)
 *
 * 将大盘判定为四态之一，供策略开仓/仓位分级兜底：
 *   牛 / 震荡 / 熊 / 冰点
 *
 * 输入（由数据抓取层提供，数据源=东财 push2/腾讯行情 + akshare 备用）：
 *   - 上证指数近 N 日收盘价（用于 MA20 及 MA20 斜率）
 *   - 涨跌家数（上涨/下跌、涨停/跌停计数）
 *   - 两市总成交额
 *
 * 纯函数 determineRegime 负责「规则→状态」，与网络解耦，便于单元测试。
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { DataFetcher } from "../data/data-fetcher";

// ===== Types =====

export type Regime = "牛" | "震荡" | "熊" | "冰点";

export interface RegimeInput {
  indexCloses: number[];   // 上证指数最近 N 日收盘价（升序，最后一个=今日）
  advanceCount: number;    // 上涨家数
  declineCount: number;    // 下跌家数
  limitUpCount: number;    // 涨停家数
  limitDownCount: number;  // 跌停家数
  totalTurnover: number;   // 沪深两市总成交额（元）
  turnoverThreshold?: number; // 成交额阈值（元），默认 1.2 万亿
  now?: Date;              // 判定时刻（用于交易时段归一；缺省=按全天口径，向后兼容）
}

export interface RegimeMetrics {
  ma20: number;
  ma20Prev: number;
  ma20Up: boolean;
  ma20Down: boolean;
  close: number;
  distanceToMa20Pct: number; // (close-ma20)/ma20 * 100
  upDownRatio: number;       // 涨幅家数 / max(跌幅家数,1)
  turnover: number;
  turnoverVsThreshold: number; // turnover / threshold（全天口径，保留向后兼容）
  elapsedFraction: number;            // 已过交易时段占比（0~1；无 now 时为 1）
  turnoverVsTimeAdjThreshold: number; // turnover / (threshold × elapsedFraction)
}

export interface RegimeResult {
  regime: Regime;
  metrics: RegimeMetrics;
  basis: string[]; // 判定依据，每条 human-readable
}

// ===== 规则常量（可调） =====

export const REGIME_RULE = {
  MA_PERIOD: 20,
  NEAR_MA20_PCT: 0.02,      // 距 MA20 2% 以内视为「贴均线」
  BULL_RATIO_MIN: 2.0,      // 牛：涨跌比 > 2.0
  BEAR_RATIO_MAX: 0.8,      // 熊：涨跌比 < 0.8
  TURNOVER_THRESHOLD: 1.2e12, // 牛需成交额 > 1.2 万亿
  FREEZE_TURNOVER_PCT: 0.7, // 冰点：成交额 < 阈值×0.7
  FREEZE_LIMITUP_MAX: 20,   // 冰点：涨停家数 < 20
  LIMIT_UP_PCT: 9.8,        // 涨停近似阈值（主板10%/创科20%取保守9.8%）
  LIMIT_DOWN_PCT: -9.8,     // 跌停近似阈值
  // —— 时段归一：A股 09:30-11:30 + 13:00-15:00 共 240 分钟 ——
  SESSION_MORNING: [9 * 60 + 30, 11 * 60 + 30],  // [开盘, 午休] = [570, 690]
  SESSION_AFTERNOON: [13 * 60, 15 * 60],         // [午后开, 收盘] = [780, 900]
  TURNOVER_MIN_ELAPSED_FRAC: 1 / 240, // 最小已过占比（≈1分钟），避免开盘瞬间阈值归零
};

// ===== 纯函数：MA / 涨跌比 =====

export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

export function computeUpDownRatio(advanceCount: number, declineCount: number): number {
  return advanceCount / Math.max(declineCount, 1);
}

/**
 * 已过交易时段占比（0~1）。
 * 交易时段 = 上午 09:30-11:30 + 下午 13:00-15:00，共 240 分钟。
 * 用于把「全天成交额阈值」折算成「当前时刻应有成交额」，避免早盘低成交额被误判为「冰点」。
 */
export function tradingElapsedFraction(now: Date): number {
  const mins = now.getHours() * 60 + now.getMinutes();
  const [mOpen, mClose] = REGIME_RULE.SESSION_MORNING;
  const [aOpen, aClose] = REGIME_RULE.SESSION_AFTERNOON;
  let elapsed: number;
  if (mins >= aClose) elapsed = 240;
  else if (mins >= aOpen) elapsed = mClose - mOpen + (mins - aOpen);
  else if (mins >= mClose) elapsed = mClose - mOpen;
  else if (mins >= mOpen) elapsed = mins - mOpen;
  else elapsed = 0;
  return Math.min(Math.max(elapsed / 240, 0), 1);
}

// ===== 纯函数：规则 → 状态 =====

export function determineRegime(input: RegimeInput): RegimeResult {
  const {
    indexCloses,
    advanceCount,
    declineCount,
    limitUpCount,
    limitDownCount: _limitDownCount,
    totalTurnover,
  } = input;
  const threshold = input.turnoverThreshold ?? REGIME_RULE.TURNOVER_THRESHOLD;
  const now = input.now;
  // 时段归一：成交额阈值按「已过交易时段占比」缩放。
  // 早盘累计成交额本就远小于全天，若不归一，必然 < 阈值×0.7 → 恒判「冰点」（假阳性）。
  const elapsedFraction = now
    ? Math.max(tradingElapsedFraction(now), REGIME_RULE.TURNOVER_MIN_ELAPSED_FRAC)
    : 1;
  const thresholdEff = threshold * elapsedFraction;

  const closes = indexCloses.slice(-REGIME_RULE.MA_PERIOD - 1); // 需要至少 MA20+1 天
  const close = closes.length > 0 ? closes[closes.length - 1] : NaN;
  const ma20 = sma(closes, REGIME_RULE.MA_PERIOD);
  const ma20Prev = sma(closes.slice(0, closes.length - 1), REGIME_RULE.MA_PERIOD); // 昨日MA20
  const ma20Up = !isNaN(ma20) && !isNaN(ma20Prev) && ma20 > ma20Prev;
  const ma20Down = !isNaN(ma20) && !isNaN(ma20Prev) && ma20 < ma20Prev;
  const distanceToMa20Pct = !isNaN(ma20) && ma20 !== 0 ? ((close - ma20) / ma20) * 100 : NaN;
  const upDownRatio = computeUpDownRatio(advanceCount, declineCount);
  const turnoverVsThreshold = totalTurnover / threshold;             // 全天口径（向后兼容）
  const turnoverVsTimeAdjThreshold = totalTurnover / thresholdEff;   // 时段归一口径
  const nearMa20 = !isNaN(distanceToMa20Pct) && Math.abs(distanceToMa20Pct) <= REGIME_RULE.NEAR_MA20_PCT * 100;

  const metrics: RegimeMetrics = {
    ma20: isNaN(ma20) ? 0 : ma20,
    ma20Prev: isNaN(ma20Prev) ? 0 : ma20Prev,
    ma20Up,
    ma20Down,
    close: isNaN(close) ? 0 : close,
    distanceToMa20Pct: isNaN(distanceToMa20Pct) ? 0 : distanceToMa20Pct,
    upDownRatio,
    turnover: totalTurnover,
    turnoverVsThreshold,
    elapsedFraction,
    turnoverVsTimeAdjThreshold,
  };

  const basis: string[] = [
    `上证收盘 ${close.toFixed(2)}，MA20=${ma20.toFixed(2)}（${ma20Up ? "上行" : ma20Down ? "下行" : "走平"}），距MA20 ${distanceToMa20Pct.toFixed(1)}%`,
    `涨跌比(涨${advanceCount}/跌${declineCount})=${upDownRatio.toFixed(2)}，涨停${limitUpCount}家/跌停${_limitDownCount}家`,
    now
      ? `两市成交额 ${(totalTurnover / 1e8).toFixed(0)} 亿（时段归一阈值 ${(thresholdEff / 1e8).toFixed(0)} 亿的 ${(turnoverVsTimeAdjThreshold * 100).toFixed(0)}%；已过 ${(elapsedFraction * 100).toFixed(0)}% 交易时段）`
      : `两市成交额 ${(totalTurnover / 1e8).toFixed(0)} 亿（阈值的${(turnoverVsThreshold * 100).toFixed(0)}%）`,
  ];

  // 1) 冰点：成交额塌陷（相对「时段归一阈值」）+ 涨停稀少
  if (
    !isNaN(totalTurnover) &&
    totalTurnover < thresholdEff * REGIME_RULE.FREEZE_TURNOVER_PCT &&
    limitUpCount < REGIME_RULE.FREEZE_LIMITUP_MAX
  ) {
    basis.push(
      `触发「冰点」：成交额塌陷(<时段归一阈值${(thresholdEff / 1e8).toFixed(0)}亿的70%) 且 涨停家数稀少(<20)`,
    );
    return { regime: "冰点", metrics, basis };
  }

  // 2) 熊：价在MA20下方 + MA20下行 + 涨跌比偏弱
  if (
    !isNaN(close) && !isNaN(ma20) &&
    close < ma20 && ma20Down && upDownRatio < REGIME_RULE.BEAR_RATIO_MAX
  ) {
    basis.push("触发「熊」：价格在MA20下方且MA20下行，涨跌比<0.8");
    return { regime: "熊", metrics, basis };
  }

  // 3) 牛：价在MA20上方 + MA20上行 + 涨跌比强 + 放量
  if (
    !isNaN(close) && !isNaN(ma20) &&
    close > ma20 && ma20Up && upDownRatio > REGIME_RULE.BULL_RATIO_MIN &&
    totalTurnover > threshold
  ) {
    basis.push("触发「牛」：价格在MA20上方且MA20上行，涨跌比>2.0，放量>1.2万亿");
    return { regime: "牛", metrics, basis };
  }

  // 4) 震荡（默认兜底）：贴均线 + 涨跌比中性
  basis.push(
    nearMa20
      ? "归入「震荡」：价格贴均线(±2%)，涨跌比中性，未达牛/熊/冰点条件"
      : "归入「震荡」：未触发牛/熊/冰点强信号，以震荡对待",
  );
  return { regime: "震荡", metrics, basis };
}

// ===== 数据抓取层：拉取上证指数 + 全市场统计 =====

export interface MarketSnapshot {
  advanceCount: number;
  declineCount: number;
  limitUpCount: number;
  limitDownCount: number;
  totalTurnover: number;   // 沪深两市总成交额（元）
  universeCount: number;   // 广度统计覆盖的股票数量
  isFullMarket: boolean;   // 是否为全市场（true=全覆盖；false=抽样/局部）
  turnoverNote: string;    // 成交额口径说明（指数级 vs 股票样本求和）
}

export interface RegimeDataFetcher {
  fetchIndexCloses(indexCode: string, days: number): Promise<number[]>;
  fetchMarketSnapshot(): Promise<MarketSnapshot>;
}

// 腾讯指数行情字段约定：field[37] = 成交额（万元）
const INDEX_TURNOVER_FIELD = 37;
const WAN_TO_YUAN = 10000;

/** 判定指数代码归属市场：399xxx 深证系→SZ；其余(000xxx/880xxx/上证系)→SH。 */
export function detectIndexMarket(indexCode: string): "SH" | "SZ" {
  const code = String(indexCode || "").trim();
  if (/^399/.test(code)) return "SZ";
  if (/^(000|880|890)/.test(code)) return "SH";
  // 兜底：000/600/60x 开头上证，9开头B股沪市；否则默认 SH（与 market_regime 默认 000001 一致）
  return "SH";
}

/**
 * 从腾讯行情直连拉取沪深两市指数成交额（元）。
 *   - sh000001 = 上证综指（覆盖全部沪市股票）→ 沪市成交额
 *   - sz399106 = 深证综指（覆盖全部深市股票）→ 深市成交额
 * 两者相加 = 沪深两市总成交额。避免用少数个股样本求和造成低估。
 */
async function fetchTwoMarketTurnover(): Promise<{ total: number; note: string }> {
  try {
    const res = await fetch("http://qt.gtimg.cn/q=sh000001,sz399106", {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const text = await res.text();
    let total = 0;
    let got = 0;
    for (const line of text.split(";")) {
      const m = line.match(/(\w+)="([^"]*)"/);
      if (!m) continue;
      const code = m[1]; // v_sh000001 / v_sz399106
      const parts = m[2].split("~");
      const wan = Number(parts[INDEX_TURNOVER_FIELD]);
      if (!Number.isNaN(wan) && wan > 0) {
        total += wan * WAN_TO_YUAN;
        got++;
      }
    }
    if (got >= 2) {
      return { total, note: "沪深两市总成交额=上证综指(sh000001)+深证综指(sz399106)" };
    }
    if (got === 1) {
      return { total, note: "成交额部分缺失(仅取到1个指数)，可能不完整" };
    }
    return { total: 0, note: "成交额拉取失败" };
  } catch (e) {
    return { total: 0, note: `成交额拉取异常: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 基于 DataFetcher 的默认实现 */
export function createDataFetcherDataFetcher(df: DataFetcher): RegimeDataFetcher {
  return {
    async fetchIndexCloses(indexCode, days) {
      // 指数代码必须按归属市场取前缀，不能一律 SH：
      //   - 399xxx 深证系指数(深证成指/创业板指/深证综指) → SZ
      //   - 000xxx 上证系指数(上证综指/沪深300/上证180) → SH
      // 若误用 sh399001 会拉不到数据(0行)或取错标的，导致大盘判定失效。
      // 另外必须用 fetchIndexKLine(在线指数K线) 而非 fetchKLine：
      //   fetchKLine 会先查 stock_daily 本地库，把指数代码(如 000001)当成同名股票(平安银行)取到错误价格(~11.74)。
      const market = detectIndexMarket(indexCode);
      const { data } = await df.fetchIndexKLine(indexCode, market, days + 20);
      return data.map((d) => d.close).slice(-days);
    },
    async fetchMarketSnapshot() {
      const stocks = await df.fetchAllStocks(["SH", "SZ", "BJ"]);
      // 涨跌家数/涨跌停计数：基于当前股票池（可能是抽样），如实标注覆盖率
      let advance = 0, decline = 0, limitUp = 0, limitDown = 0;
      for (const s of stocks) {
        const pct = s.changePercent ?? 0;
        if (pct > 0) advance++;
        else if (pct < 0) decline++;
        if (pct >= REGIME_RULE.LIMIT_UP_PCT) limitUp++;
        if (pct <= REGIME_RULE.LIMIT_DOWN_PCT) limitDown++;
      }
      // 两市总成交额：改用指数口径（指数级），避免股票样本求和低估
      const { total: totalTurnover, note: turnoverNote } = await fetchTwoMarketTurnover();
      return {
        advanceCount: advance,
        declineCount: decline,
        limitUpCount: limitUp,
        limitDownCount: limitDown,
        totalTurnover,
        universeCount: stocks.length,
        isFullMarket: false, // fetchAllStocks 基于 stock_list.json（目前为样本）
        turnoverNote,
      };
    },
  };
}

/** 一键取齐并判定（返回判定结果 + 数据快照，便于输出覆盖率口径） */
export async function fetchRegimeData(
  df: DataFetcher,
  indexCode = "000001",
  days = 60,
  now: Date = new Date(),
): Promise<{ regime: RegimeResult; snapshot: MarketSnapshot }> {
  const fetcher = createDataFetcherDataFetcher(df);
  const [indexCloses, snapshot] = await Promise.all([
    fetcher.fetchIndexCloses(indexCode, days),
    fetcher.fetchMarketSnapshot(),
  ]);
  return { regime: determineRegime({ indexCloses, ...snapshot, now }), snapshot };
}

// ===== Tool: market_regime =====

const regimeParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: "操作: detect / rules\n\ndetect → 实时抓取数据并判定当前 regime(牛/震荡/熊/冰点)+依据\nrules → 输出判定规则常量",
    required: false,
  },
  { name: "index_code", type: "string", description: "上证指数代码(默认000001)", required: false },
  { name: "days", type: "integer", description: "取K线天数(默认60)", required: false },
];

const regimeHandler = async (args: Record<string, unknown>): Promise<string> => {
  // 懒加载 DataFetcher，避免与工具注册循环依赖；这里用全局单例
  const df = (globalThis as any).__sclawDataFetcher as DataFetcher | undefined;
  if (!df) {
    return "❌ 未初始化行情数据源（globalThis.__sclawDataFetcher 未设置）。请先初始化 DataFetcher。";
  }

  const subCmd = (args.sub_cmd as string || "detect").toLowerCase().trim();
  if (subCmd === "rules") {
    const r = REGIME_RULE;
    return [
      "📏 大盘 regime 判定规则：",
      `- 牛：上证>MA20 且 MA20上行，涨跌比>${r.BULL_RATIO_MIN}，成交额>${(r.TURNOVER_THRESHOLD / 1e12).toFixed(1)}万亿`,
      `- 震荡：未达牛/熊/冰点强信号（贴MA20±${r.NEAR_MA20_PCT * 100}%）`,
      `- 熊：上证<MA20 且 MA20下行，涨跌比<${r.BEAR_RATIO_MAX}`,
      `- 冰点：成交额<阈值×${r.FREEZE_TURNOVER_PCT} 且 涨停<${r.FREEZE_LIMITUP_MAX}家`,
    ].join("\n");
  }

  const indexCode = (args.index_code as string || "000001").trim();
  const days = typeof args.days === "number" ? args.days : 60;
  try {
    const { regime: result, snapshot } = await fetchRegimeData(df, indexCode, days);
    const tierLabel: Record<Regime, string> = {
      "牛": "🟢 全面进攻",
      "震荡": "🟡 半仓/打板可做",
      "熊": "🔴 空仓优先/只做极强",
      "冰点": "⚫ 全面空仓等待",
    };
    const coverageLine = snapshot.isFullMarket
      ? `覆盖：全市场真实统计`
      : `覆盖：广度按样本统计(${snapshot.universeCount}只，非全市场)；成交额=${snapshot.turnoverNote}`;
    return [
      `# 大盘 regime：${result.regime}`,
      `策略开关：${tierLabel[result.regime]}`,
      "---",
      "📊 指标：",
      ...result.basis.map((b) => `- ${b}`),
      `- ${coverageLine}`,
      "---",
      "🧭 判定依据（阈值可调）：见 rules",
    ].join("\n");
  } catch (e: unknown) {
    return `❌ 判定失败：${e instanceof Error ? e.message : String(e)}`;
  }
};

export function registerMarketRegimeTool(registry: ToolRegistry): void {
  registry.register(
    new Tool("market_regime", "判定大盘 regime(牛/震荡/熊/冰点)并给出依据。", regimeParams, regimeHandler),
  );
}
