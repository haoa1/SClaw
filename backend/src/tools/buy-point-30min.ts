/**
 * Buy Point 30min Tool — 30分钟买点确认工具
 *
 * 两步选股流水线第二步:
 *   Step1: v11 全市场打分 → top N 候选 (ml_screener)
 *   Step2: 本工具对候选逐只拉取30分钟K线, 识别缠论买点(一买/二买/三买) + 技术辅助(KDJ/RSI/MA20)
 *
 * 用法:
 *   buy_point_30min(auto_top=30)              — 自动跑v11选股→取top30→30分钟买点确认
 *   buy_point_30min(codes="600519,000001")    — 对指定代码做30分钟买点确认
 *   buy_point_30min(codes="...", min_score=60) — 只显示评分>=60的买点
 */
import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { execSync } from "child_process";

const buyPoint30minHandler = async (args: Record<string, unknown>): Promise<string> => {
  const codes = (args.codes as string) || "";
  const autoTop = (args.auto_top as number) || 0;
  const minScore = (args.min_score as number) || 0;

  let cmd = "python3 /root/sclaw/ml_screener/buy_point_30min.py";
  if (codes) cmd += ` --codes=${codes}`;
  if (autoTop > 0) cmd += ` --auto-top=${autoTop}`;
  if (minScore > 0) cmd += ` --min-score=${minScore}`;

  try {
    const stdout = execSync(cmd, {
      timeout: 420000,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const data = JSON.parse(stdout);
    const points = data.buy_points || [];
    const checked = data.checked ?? 0;
    const total = data.total ?? 0;

    let res = `## 30分钟买点确认 (分析 ${checked}/${total} 只, 命中 ${points.length} 个买点)\n\n`;
    if (points.length > 0) {
      res += `| 排名 | 代码 | 名称 | 买点 | 评分 | 现价 | 参考买入 | 止损 | 信号 |\n`;
      res += `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const p of points.slice(0, 20)) {
        const sigs = (p.signals || []).join(" ");
        res += `| ${p.rank ?? "-"} | ${p.code} | ${p.name} | ${p.type} | ${p.score} | ${p.price} | ${p.ref_price} | ${p.stop_loss} | ${sigs} |\n`;
      }
      if (points.length > 20) {
        res += `\n... 还有 ${points.length - 20} 个买点未显示\n`;
      }
    } else {
      res += `没有符合条件的买点信号。\n`;
    }
    res += `\n**说明**: 缠论一买(底背驰+底分型) / 二买(回调不破前低) / 三买(突破中枢回踩), 辅助KDJ/RSI/MA20信号。已过滤停牌/数据陈旧(>7天)股票。评分≥60为较强信号。`;
    return res;
  } catch (e: any) {
    if (e.stdout) {
      try {
        const data = JSON.parse(e.stdout);
        let res = `## 30分钟买点确认 (共${data.total ?? 0}只, 命中${(data.buy_points || []).length}个)\n\n`;
        for (const p of (data.buy_points || []).slice(0, 10)) {
          res += `- ${p.name}(${p.code}) ${p.type} 评分:${p.score} 现价:${p.price} 止损:${p.stop_loss} ${(p.signals || []).join(" ")}\n`;
        }
        return res;
      } catch {}
    }
    return `BuyPoint30min error: ${e.stderr?.slice(0, 200) || e.message}`;
  }
};

const params: ToolParamDef[] = [
  { name: "codes", type: "string", description: "股票代码列表, 逗号分隔 (例如 '600519,000001')", required: false },
  { name: "auto_top", type: "number", description: "自动运行v11全市场选股并取top N进行30分钟买点确认 (默认: 0=不自动)", required: false },
  { name: "min_score", type: "number", description: "最低买点评分阈值 0-100 (默认: 0)", required: false },
];

export const buyPoint30minTool = new Tool(
  "buy_point_30min",
  `30分钟买点确认工具 - 两步选股流水线第二步

对候选股票逐只拉取30分钟K线, 识别缠论买点(一买/二买/三买) + 技术辅助信号(KDJ/RSI/MA20), 输出买点类型、参考买入价、止损位。

买点规则:
  缠论一买: 30分钟下跌末端 底背驰(价格新低+DIF不新低) + 底分型 + MACD绿柱缩小
  缠论二买: 一买后回调不破前低 (最强买点)
  缠论三买: 突破中枢后回调不进中枢
  技术辅助: KDJ超卖金叉 / RSI超卖回升 / 放量突破MA20

自动过滤: ST/退市 + 停牌/数据陈旧(>7天)

使用示例:
  buy_point_30min(auto_top=30) - 自动跑v11选股, 对top30做30分钟买点确认
  buy_point_30min(codes="600519,000001") - 对指定股票确认买点
  buy_point_30min(codes="...", min_score=60) - 只显示60分以上强信号`,
  params,
  buyPoint30minHandler,
);

export function registerBuyPoint30minTool(registry: ToolRegistry): void {
  registry.register(buyPoint30minTool);
}
