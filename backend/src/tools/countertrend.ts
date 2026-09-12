/**
 * 反走势研究数据采集器 (Counter-Trend Data Collector)
 *
 * 目标：验证两条假说 ——
 *   假说A（惯性）: 大盘下跌日里「逆势强势股」（逆着大盘上涨/相对强度高）次日继续走强
 *   假说B（补跌）: 逆势强势股次日补跌（强势是耗竭/最后多头的衰竭）
 *
 * 数据链路：
 *   - 指数日涨幅：腾讯 K 线 sh000001（上证指数）收盘价逐日算
 *   - 全 A 个股日涨幅：Tushare `daily`（每天返回全市场 5500+ 只，含 pct_chg/amount）
 *   - 用「个股涨幅 - 指数涨幅」的**相对强度**剥离市场 beta，检验逆势强度
 *
 * 采集逻辑（逆风日判定）：
 *   当 indexPct <= DOWN_INDEX_PCT（如 ≤-0.3%，大盘明确下跌）时，
 *   扫描全市场，挑出「逆势强势」股票：
 *     - 涨停(limit_up)：pctChg >= 板块涨停阈值（主板9.8 / 双创19.8）
 *     - 强势上涨(strong_up)：pctChg >= STRONG_PCT（如 ≥3%）
 *     - 相对强势(relative_strong)：pctChg>0 且 (pctChg - indexPct) >= REL_STRENGTH（强于指数≥3pp）
 *   并加上流动性过滤（amount >= MIN_AMOUNT），剔除缩量噪音。
 *
 * 次日追踪：
 *   T 日采集的股票，T+1 记录其 nextPct（次日涨跌幅）与 nextRel（次日相对指数收益），
 *   汇总统计 nextUpRate / nextMeanRel / nextMedianRel → 判断 A 还是 B 成立。
 *
 * 纯函数 isCounterTrend / detectDay / computeHypothesisStats 与网络解耦，便于单测。
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { DataFetcher } from "../data/data-fetcher";

// ===== 类型 =====

export interface CounterTrendRule {
  DOWN_INDEX_PCT: number;     // 指数日涨幅 ≤ 此值视为「逆风日」（下跌日），如 -0.3
  STRONG_PCT: number;         // 个股日涨幅 ≥ 此值视为「强势上涨」（未涨停也够强）
  REL_STRENGTH: number;       // 个股 - 指数 相对强度 ≥ 此值（百分点）视为「相对强势」
  MIN_AMOUNT: number;         // 最低成交额（元），剔除缩量噪音，如 5000 万
  LIMIT_UP_MAIN: number;      // 主板涨停近似阈值（%）
  LIMIT_UP_GROWTH: number;    // 创业板/科创板涨停近似阈值（%）
}

export const COUNTER_TREND_RULE: CounterTrendRule = {
  DOWN_INDEX_PCT: -0.3,
  STRONG_PCT: 3,
  REL_STRENGTH: 3,
  MIN_AMOUNT: 5e7,            // 5000 万元
  LIMIT_UP_MAIN: 9.8,
  LIMIT_UP_GROWTH: 19.8,
};

export type CounterTrendCategory = "limit_up" | "strong_up" | "relative_strong";

export interface CounterTrendInstance {
  detectDate: string;          // T 检测日（Y-M-D）
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ";
  pctChg: number;              // 当日涨幅 %
  amount: number;              // 当日成交额（元）
  turnoverRate?: number;       // 换手率 %
  indexPct: number;            // 当日指数涨幅 %
  relStrength: number;         // pctChg - indexPct
  category: CounterTrendCategory;
  // 次日追踪（backfill 直接填，live 先空待 track）
  nextDate?: string;           // T+1 日期
  nextPct?: number;            // T+1 涨幅 %
  nextIndexPct?: number;       // T+1 指数涨幅 %
  nextRel?: number;            // T+1 相对指数收益 %
  fulfilled?: boolean;         // 是否已追踪到次日
}

export interface HypothesisStats {
  totalDetected: number;       // 检测到的逆势强势股总数
  daysScanned: number;         // 扫描的天数
  daysWithHit: number;         // 实际检出股票的天数
  fulfilled: number;           // 已追踪到次日样本数
  nextUpRate: number;          // 次日上涨占比
  nextMeanPct: number;         // 次日绝对涨幅均值 %
  nextMedianPct: number;       // 次日绝对涨幅中位数 %
  nextMeanRel: number;         // 次日相对指数收益均值 %
  nextMedianRel: number;       // 次日相对指数收益中位数 %
  byCategory: Record<CounterTrendCategory, { n: number; nextMeanRel: number; nextUpRate: number }>;
  conclusion: string;          // 假说A惯性 / 假说B补跌 / 不确定
}

// ===== 纯函数 =====

/** 计算某只股票是否为「逆势强势股」（需已满足逆风日前提） */
export function isCounterTrend(
  pctChg: number,
  indexPct: number,
  amount: number,
  rule: CounterTrendRule = COUNTER_TREND_RULE,
): { hit: boolean; category: CounterTrendCategory | null } {
  // 非逆风日：不纳入
  if (indexPct > rule.DOWN_INDEX_PCT) return { hit: false, category: null };
  // 流动性过滤
  if (amount < rule.MIN_AMOUNT) return { hit: false, category: null };

  const rel = pctChg - indexPct;
  const category = classifyCategory(pctChg, rel, rule);
  if (category) return { hit: true, category };
  return { hit: false, category: null };
}

/** 归类：涨停 > 强势上涨 > 相对强势 */
export function classifyCategory(
  pctChg: number,
  rel: number,
  rule: CounterTrendRule = COUNTER_TREND_RULE,
): CounterTrendCategory | null {
  if (pctChg >= rule.LIMIT_UP_MAIN) return "limit_up";
  if (pctChg >= rule.STRONG_PCT) return "strong_up";
  if (pctChg > 0 && rel >= rule.REL_STRENGTH) return "relative_strong";
  return null;
}

/** 根据股票代码判断板块涨停阈值 */
export function limitUpThresholdFor(code: string, rule: CounterTrendRule = COUNTER_TREND_RULE): number {
  // 创业板 30x/301x，科创板 688/689 → 20cm
  if (/^(30|68)/.test(code)) return rule.LIMIT_UP_GROWTH;
  return rule.LIMIT_UP_MAIN;
}

/** 从收盘价序列计算逐日涨幅（首日 N/A→NaN），返回 {date, close, pct} 数组 */
export function computeDailyPct(
  closes: Array<{ date: string; close: number }>,
): Array<{ date: string; close: number; pct: number }> {
  const out: Array<{ date: string; close: number; pct: number }> = [];
  for (let i = 0; i < closes.length; i++) {
    const prev = closes[i - 1];
    const pct = prev && prev.close ? ((closes[i].close - prev.close) / prev.close) * 100 : NaN;
    out.push({ date: closes[i].date, close: closes[i].close, pct });
  }
  return out;
}

/** 对某交易日检测逆势强势股（全市场），返回命中实例列表 */
export function detectDay(
  date: string,
  indexPct: number,
  rows: Array<{ code: string; name: string; market: "SH" | "SZ" | "BJ"; pctChg: number; amount: number; turnoverRate?: number }>,
  rule: CounterTrendRule = COUNTER_TREND_RULE,
): CounterTrendInstance[] {
  const out: CounterTrendInstance[] = [];
  for (const r of rows) {
    if (typeof r.pctChg !== "number" || Number.isNaN(r.pctChg)) continue;
    const { hit, category } = isCounterTrend(r.pctChg, indexPct, r.amount, rule);
    if (!hit || !category) continue;
    out.push({
      detectDate: date,
      code: r.code,
      name: r.name,
      market: r.market,
      pctChg: r.pctChg,
      amount: r.amount,
      turnoverRate: r.turnoverRate,
      indexPct,
      relStrength: r.pctChg - indexPct,
      category,
    });
  }
  return out;
}

/** 汇总假说A/B 统计 */
export function computeHypothesisStats(
  instances: CounterTrendInstance[],
): HypothesisStats {
  const fulfilled = instances.filter((i) => i.fulfilled && typeof i.nextPct === "number" && typeof i.nextRel === "number");
  const n = fulfilled.length;

  const mean = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const nextRels = fulfilled.map((i) => i.nextRel!);
  const nextPcts = fulfilled.map((i) => i.nextPct!);
  const nextUpRate = n ? fulfilled.filter((i) => i.nextPct! > 0).length / n : 0;
  const nextMeanRel = mean(nextRels);
  const nextMedianRel = median(nextRels);

  const categories: CounterTrendCategory[] = ["limit_up", "strong_up", "relative_strong"];
  const byCategory = {} as HypothesisStats["byCategory"];
  for (const cat of categories) {
    const sub = fulfilled.filter((i) => i.category === cat);
    const subRels = sub.map((i) => i.nextRel!);
    byCategory[cat] = {
      n: sub.length,
      nextMeanRel: mean(subRels),
      nextUpRate: sub.length ? sub.filter((i) => i.nextPct! > 0).length / sub.length : 0,
    };
  }

  const daysScanned = new Set(instances.map((i) => i.detectDate)).size;
  const daysWithHit = new Set(
    instances.filter((i) => i.category).map((i) => i.detectDate),
  ).size;

  let conclusion: string;
  if (n === 0) {
    conclusion = "样本不足：尚无已追踪到次日的逆势强势股，无法判定假说。";
  } else if (nextMeanRel > 0 && nextUpRate > 0.5) {
    conclusion = `假说A（惯性）成立：逆势强势股次日均值相对收益 ${nextMeanRel.toFixed(2)}%，上涨占比 ${(nextUpRate * 100).toFixed(1)}%。`;
  } else if (nextMeanRel < 0 && nextUpRate < 0.5) {
    conclusion = `假说B（补跌）成立：逆势强势股次日均值相对收益 ${nextMeanRel.toFixed(2)}%，上涨占比 ${(nextUpRate * 100).toFixed(1)}%。`;
  } else {
    conclusion = `结论不确定：相对收益均值 ${nextMeanRel.toFixed(2)}% / 上涨占比 ${(nextUpRate * 100).toFixed(1)}% 未形成单边倾向。`;
  }

  return {
    totalDetected: instances.length,
    daysScanned,
    daysWithHit,
    fulfilled: n,
    nextUpRate,
    nextMeanPct: mean(nextPcts),
    nextMedianPct: median(nextPcts),
    nextMeanRel,
    nextMedianRel,
    byCategory,
    conclusion,
  };
}

/** 格式化假设统计结果为可读文本 */
export function formatHypothesisStats(s: HypothesisStats): string {
  const bucket = (cat: CounterTrendCategory) => {
    const b = s.byCategory[cat];
    if (!b || b.n === 0) return `- ${cat}: 无样本`;
    return `- ${cat}: n=${b.n}, 次日均相对收益 ${b.nextMeanRel.toFixed(2)}%, 上涨占比 ${(b.nextUpRate * 100).toFixed(1)}%`;
  };
  return [
    `# 反走势假说统计`,
    `- 扫描天数: ${s.daysScanned}（检出天数 ${s.daysWithHit}）`,
    `- 检测到逆势强势股: ${s.totalDetected} 只`,
    `- 已追踪到次日: ${s.fulfilled} 只`,
    `- 次日上涨占比: ${(s.nextUpRate * 100).toFixed(1)}%`,
    `- 次日绝对涨幅: 均值 ${s.nextMeanPct.toFixed(2)}% / 中位 ${s.nextMedianPct.toFixed(2)}%`,
    `- 次日相对指数: 均值 ${s.nextMeanRel.toFixed(2)}% / 中位 ${s.nextMedianRel.toFixed(2)}%`,
    `- 按分类:`,
    bucket("limit_up"),
    bucket("strong_up"),
    bucket("relative_strong"),
    `---`,
    `结论: ${s.conclusion}`,
  ].join("\n");
}

// ===== 数据抓取层 =====

const TUSHARE_API = "http://api.tushare.pro";
const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || "2f1bdb8c76da9b32cd3fd07968200666b6356aa03ec18a1c9f4a8bc3";

// 保存路径
import * as fs from "fs";
import * as path from "path";
const CT_ROOT = path.resolve(__dirname, "../../data/countertrend");
const DAYS_CACHE_DIR = path.join(CT_ROOT, "daily");
const SAMPLES_FILE = path.join(CT_ROOT, "samples.json");

export interface TushareDailyRow {
  code: string;
  market: "SH" | "SZ" | "BJ";
  pctChg: number;
  amount: number;      // 元
  turnoverRate?: number;
}

/** 拉取 Tushare 某交易日全市场（含缓存）。amount 单位 千元 → 元 */
export async function fetchTushareDay(dateStr: string, force = false): Promise<TushareDailyRow[]> {
  const cacheFile = path.join(DAYS_CACHE_DIR, `${dateStr}.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as TushareDailyRow[];
    } catch {
      // 缓存损坏则重新拉
    }
  }
  const res = await fetch(TUSHARE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_name: "daily",
      token: TUSHARE_TOKEN,
      params: { trade_date: dateStr.replace(/-/g, "") },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const json: any = await res.json();
  if (json.code !== 0) throw new Error(`Tushare daily ${dateStr} fail: ${json.code} ${json.msg}`);
  const fields: string[] = json.data.fields;
  const fTs = fields.indexOf("ts_code");
  const fPct = fields.indexOf("pct_chg");
  const fAmt = fields.indexOf("amount");
  const fTurn = fields.indexOf("turnover_rate");
  const rows: TushareDailyRow[] = [];
  for (const item of json.data.items) {
    const tsCode: string = item[fTs];
    const suffix = tsCode.split(".").pop() || "";
    const market = suffix === "SH" ? "SH" : suffix === "SZ" ? "SZ" : suffix === "BJ" ? "BJ" : null;
    if (!market) continue;
    const pct = Number(item[fPct]);
    const amtQian = Number(item[fAmt]); // 千元
    const row: TushareDailyRow = {
      code: tsCode.split(".")[0],
      market: market as TushareDailyRow["market"],
      pctChg: Number.isNaN(pct) ? 0 : pct,
      amount: Number.isNaN(amtQian) ? 0 : amtQian * 1000,
    };
    if (fTurn >= 0) row.turnoverRate = Number(item[fTurn]) || 0;
    rows.push(row);
  }
  // 缓存
  if (!fs.existsSync(DAYS_CACHE_DIR)) fs.mkdirSync(DAYS_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(rows), "utf-8");
  return rows;
}

/** 从腾讯 K 线拿上证指数日收盘 + 涨跌幅，返回按日期索引的 {date -> pct} 映射 */
export async function fetchIndexPctMap(
  df: DataFetcher,
  days = 45,
  indexCode = "000001",
): Promise<Record<string, number>> {
  const { data } = await df.fetchKLine(indexCode, "SH", days);
  const series = computeDailyPct(data.map((d) => ({ date: d.date, close: d.close })));
  const map: Record<string, number> = {};
  for (const s of series) {
    if (!Number.isNaN(s.pct)) map[s.date] = s.pct;
  }
  return map;
}

/** 从本地 K-line 列表生成名称 map（从 stock_list.json 读取，供展示用） */
function loadNameMap(): Record<string, string> {
  try {
    const listFile = path.resolve(__dirname, "../../data/stock_list.json");
    if (!fs.existsSync(listFile)) return {};
    const list = JSON.parse(fs.readFileSync(listFile, "utf-8")) as Array<{ code: string; name: string }>;
    const m: Record<string, string> = {};
    for (const s of list) m[s.code] = s.name;
    return m;
  } catch {
    return {};
  }
}

/** 读取已有样本库 */
export function loadSamples(): CounterTrendInstance[] {
  if (!fs.existsSync(SAMPLES_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(SAMPLES_FILE, "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 保存样本库（原子写：先写临时文件再改名） */
export function saveSamples(samples: CounterTrendInstance[]): void {
  if (!fs.existsSync(CT_ROOT)) fs.mkdirSync(CT_ROOT, { recursive: true });
  const tmp = SAMPLES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(samples, null, 0), "utf-8");
  fs.renameSync(tmp, SAMPLES_FILE);
}

/**
 * 30 日回溯：拉指数 + 全 A 面板，检测每个逆风日的逆势强势股，并填 T+1 表现。
 * 返回检测到的样本数组。
 */
export async function backfill(
  df: DataFetcher,
  days = 30,
  rule: CounterTrendRule = COUNTER_TREND_RULE,
): Promise<CounterTrendInstance[]> {
  const nameMap = loadNameMap();
  const indexPctMap = await fetchIndexPctMap(df, days + 10);
  const dates = Object.keys(indexPctMap).sort();

  // 只取最近 days 个有指数的交易日
  const scanDates = dates.slice(-(days + 1)).slice(0, -1); // 留出一个作为 T+1 观察窗口
  const samples: CounterTrendInstance[] = [];

  for (const date of scanDates) {
    const indexPct = indexPctMap[date];
    if (indexPct > rule.DOWN_INDEX_PCT) continue; // 非逆风日跳过
    let rows: TushareDailyRow[];
    try {
      rows = await fetchTushareDay(date);
    } catch (e) {
      console.warn(`[CT] ${date} fetch fail: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // 找 T+1
    const nextDate = nextTradingDate(indexPctMap, date);
    let nextPctMap: Record<string, { pct: number; indexPct: number }> = {};
    if (nextDate) {
      try {
        const nextRows = await fetchTushareDay(nextDate);
        const nextIndexPct = indexPctMap[nextDate];
        for (const r of nextRows) {
          nextPctMap[r.code] = { pct: r.pctChg, indexPct: nextIndexPct };
        }
      } catch {
        // 忽略，T+1 缺数据则样本不填 next
      }
    }

    const enriched = rows.map((r) => ({
      code: r.code,
      name: nameMap[r.code] || r.code,
      market: r.market,
      pctChg: r.pctChg,
      amount: r.amount,
      turnoverRate: r.turnoverRate,
    }));
    const hits = detectDay(date, indexPct, enriched, rule);
    for (const h of hits) {
      const nv = nextDate ? nextPctMap[h.code] : undefined;
      if (nv) {
        h.nextDate = nextDate!;
        h.nextPct = nv.pct;
        h.nextIndexPct = nv.indexPct;
        h.nextRel = nv.pct - nv.indexPct;
        h.fulfilled = true;
      }
      samples.push(h);
    }
    console.log(`[CT] ${date}: index ${indexPct.toFixed(2)}% detected ${hits.length} 逆势强势 (T+1=${nextDate || "N/A"})`);
    await sleep(1500); // Tushare 频率限制
  }

  return samples;
}

function nextTradingDate(indexPctMap: Record<string, number>, date: string): string | null {
  const dates = Object.keys(indexPctMap).sort();
  const idx = dates.indexOf(date);
  if (idx < 0 || idx + 1 >= dates.length) return null;
  return dates[idx + 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== Tool: countertrend =====

const ctParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description:
      "操作: backfill / collect / stats / rules\\nbackfill → 拉取最近N个交易日全A面板，检测逆风日逆势强势股并追踪次日表现(默认30日回溯)\\ncollect → 实时扫描当前全A市场，采集今日逆势强势股(带index参数可指定当日指数涨幅)\\nstats → 汇总样本库，输出假说A惯性/假说B补跌统计\\nrules → 输出判定阈值",
    required: false,
  },
  { name: "days", type: "integer", description: "backfill 回溯交易日数(默认30)", required: false },
  { name: "date", type: "string", description: "collect 指定日期(默认今日，用于指数对齐)", required: false },
  { name: "index_pct", type: "number", description: "collect 当日指数涨幅%，不传则自动抓上证指数", required: false },
];

const ctHandler = async (args: Record<string, unknown>): Promise<string> => {
  const df = (globalThis as any).__sclawDataFetcher as DataFetcher | undefined;
  if (!df) {
    return "❌ 未初始化行情数据源（globalThis.__sclawDataFetcher 未设置）。请先初始化 DataFetcher。";
  }

  const subCmd = (args.sub_cmd as string || "stats").toLowerCase().trim();

  if (subCmd === "rules") {
    const r = COUNTER_TREND_RULE;
    return [
      "📏 反走势判定阈值：",
      `- 逆风日：指数日涨幅 ≤ ${r.DOWN_INDEX_PCT}%`,
      `- 强势上涨：个股涨幅 ≥ ${r.STRONG_PCT}%`,
      `- 相对强势：个股 - 指数 相对强度 ≥ ${r.REL_STRENGTH}pp`,
      `- 最低成交额：${(r.MIN_AMOUNT / 1e8).toFixed(0)} 亿元`,
      `- 涨停阈值：主板 ${r.LIMIT_UP_MAIN}% / 双创 ${r.LIMIT_UP_GROWTH}%`,
    ].join("\n");
  }

  if (subCmd === "backfill") {
    const days = typeof args.days === "number" ? args.days : 30;
    try {
      const samples = await backfill(df, days);
      // 合并进现有样本库（按 detectDate+code 去重）
      const existing = loadSamples();
      const keySet = new Set(existing.map((s) => `${s.detectDate}|${s.code}`));
      const newOnes = samples.filter((s) => !keySet.has(`${s.detectDate}|${s.code}`));
      saveSamples([...existing, ...newOnes]);
      const stats = computeHypothesisStats(loadSamples());
      return [
        `✅ 回溯完成：新增 ${newOnes.length} 条逆势强势样本（累计 ${existing.length + newOnes.length} 条）`,
        formatHypothesisStats(stats),
      ].join("\n");
    } catch (e) {
      return `❌ 回溯失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (subCmd === "collect") {
    try {
      // 指数当日涨幅
      let indexPct: number;
      if (typeof args.index_pct === "number") {
        indexPct = args.index_pct;
      } else {
        const idxMap = await fetchIndexPctMap(df, 5);
        const today = new Date().toISOString().slice(0, 10);
        indexPct = idxMap[today] ?? NaN;
        if (Number.isNaN(indexPct)) {
          // 可能今天还没收盘，用最近一个交易日（昨收）
          const dates = Object.keys(idxMap).sort();
          indexPct = dates.length ? idxMap[dates[dates.length - 1]] : NaN;
        }
      }
      if (Number.isNaN(indexPct)) {
        return "⚠️ 无法获取指数当日涨幅，请传 index_pct 参数。如 09-02 上证约 -0.08%。";
      }
      const date = (args.date as string) || new Date().toISOString().slice(0, 10);
      const stocks = await df.fetchAllStocks(["SH", "SZ"]);
      const nameMap = loadNameMap();
      const enriched = stocks.map((s: any) => ({
        code: s.code,
        name: nameMap[s.code] || s.name || s.code,
        market: s.market,
        pctChg: s.changePercent ?? 0,
        amount: s.turnover ?? 0,
        turnoverRate: s.turnoverRate,
      }));
      const hits = detectDay(date, indexPct, enriched, COUNTER_TREND_RULE);
      // 合并，避免重复
      const existing = loadSamples();
      const keySet = new Set(existing.map((s) => `${s.detectDate}|${s.code}`));
      const newOnes = hits.filter((s) => !keySet.has(`${s.detectDate}|${s.code}`));
      saveSamples([...existing, ...newOnes]);
      return [
        `# 今日逆势强势采集 (${date})`,
        `- 指数涨幅: ${indexPct.toFixed(2)}%`,
        `- 全市场扫描: ${stocks.length} 只`,
        `- 检测到逆势强势: ${hits.length} 只`,
        ...hits.slice(0, 15).map((h, i) =>
          `${i + 1}. ${h.code} ${h.name} [${h.category}] 涨${h.pctChg.toFixed(2)}% 相对+${h.relStrength.toFixed(2)}pp`,
        ),
        hits.length > 15 ? `... 共 ${hits.length} 只（全部已入库，次日用 countertrend sub_cmd=track 追踪）` : "",
        `- 次日请调用 countertrend sub_cmd=track 追踪 T+1 表现`,
      ]
        .filter(Boolean)
        .join("\n");
    } catch (e) {
      return `❌ 采集失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (subCmd === "track") {
    try {
      const samples = loadSamples();
      const today = new Date().toISOString().slice(0, 10);
      const idxMap = await fetchIndexPctMap(df, 5);
      let pending = samples.filter((s) => !s.fulfilled);
      if (pending.length === 0) {
        return "无待追踪样本。所有逆势强势股均已填入次日表现。";
      }
      // 抓取当前全市场，填充今日作为 T+1
      const stocks = await df.fetchAllStocks(["SH", "SZ"]);
      const byCode = new Map<string, { pct: number; indexPct: number }>();
      const todayIndex = idxMap[today] ?? NaN;
      for (const s of stocks as any[]) {
        byCode.set(s.code, { pct: s.changePercent ?? 0, indexPct: todayIndex });
      }
      let filled = 0;
      for (const s of pending) {
        const cur = byCode.get(s.code);
        if (cur) {
          s.nextDate = today;
          s.nextPct = cur.pct;
          s.nextIndexPct = cur.indexPct;
          s.nextRel = cur.pct - cur.indexPct;
          s.fulfilled = true;
          filled++;
        }
      }
      const stats = computeHypothesisStats(samples);
      return [
        `✅ 追踪完成：${filled}/${pending.length} 只逆势强势股已填入今日(T+1)表现`,
        formatHypothesisStats(stats),
      ].join("\n");
    } catch (e) {
      return `❌ 追踪失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 默认 stats
  const samples = loadSamples();
  const stats = computeHypothesisStats(samples);
  return formatHypothesisStats(stats);
};

export function registerCounterTrendTool(registry: ToolRegistry): void {
  registry.register(
    new Tool(
      "countertrend",
      "反走势研究数据采集器：采集大盘下跌日逆势强势股并追踪次日表现，验证假说A惯性/假说B补跌。",
      ctParams,
      ctHandler,
    ),
  );
}
