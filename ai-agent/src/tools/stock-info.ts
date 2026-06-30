import { ToolRegistry } from "./registry";
const STOCKS_CACHE: any[] = [];
const SAMPLE_STOCKS = [
  { code:"600000", name:"浦发银行", market:"SH", price:8.50, change_pct:1.2, volume:5000000, turnover:0.8, pe:5.2, pb:0.45, market_cap:250e9 },
  { code:"600519", name:"贵州茅台", market:"SH", price:1850, change_pct:-0.5, volume:200000, turnover:0.3, pe:30.5, pb:10.2, market_cap:2300e9 },
  { code:"000001", name:"平安银行", market:"SZ", price:12.30, change_pct:2.1, volume:8000000, turnover:1.5, pe:6.8, pb:0.72, market_cap:240e9 },
  { code:"300750", name:"宁德时代", market:"SZ", price:220, change_pct:3.5, volume:3000000, turnover:2.1, pe:25, pb:5.8, market_cap:500e9 },
  { code:"688256", name:"寒武纪", market:"SH", price:150, change_pct:20, volume:15000000, turnover:8.5, pe:-1, pb:15, market_cap:600e9 },
  { code:"000333", name:"美的集团", market:"SZ", price:65, change_pct:0.8, volume:2000000, turnover:0.6, pe:12, pb:2.5, market_cap:450e9 },
  { code:"600036", name:"招商银行", market:"SH", price:35, change_pct:1.5, volume:4000000, turnover:0.9, pe:6, pb:0.85, market_cap:880e9 },
  { code:"601318", name:"中国平安", market:"SH", price:45, change_pct:-0.3, volume:6000000, turnover:1.2, pe:8.5, pb:1.1, market_cap:820e9 },
  { code:"688521", name:"芯原股份", market:"SH", price:78, change_pct:20, volume:8000000, turnover:6.5, pe:-1, pb:8.0, market_cap:380e9 },
  { code:"300769", name:"德方纳米", market:"SZ", price:85, change_pct:12.92, volume:5000000, turnover:5.0, pe:35, pb:4.2, market_cap:150e9 },
];
export async function getStocks(): Promise<any[]> {
  if (STOCKS_CACHE.length > 0) return STOCKS_CACHE;
  STOCKS_CACHE.push(...SAMPLE_STOCKS);
  return STOCKS_CACHE;
}
export function registerStockTools(registry: ToolRegistry): void {
  registry.register("search_stocks", async (a: any) => { const q = (a.query||"").toLowerCase(); return (await getStocks()).filter((s:any) => s.code.includes(q)||s.name.includes(q)); },
    { name:"search_stocks", description:"Search stocks", parameters:{ type:"object", properties:{ query:{type:"string"}, limit:{type:"number"} }, required:["query"] } });
  registry.register("get_stock_detail", async (a: any) => { return (await getStocks()).find((s:any) => s.code===a.code)||{error:"Not found"}; },
    { name:"get_stock_detail", description:"Get stock detail", parameters:{ type:"object", properties:{ code:{type:"string"} }, required:["code"] } });
  registry.register("get_kline", async (a: any) => { return {code:a.code, days:a.days||30, data:"mock kline"}; },
    { name:"get_kline", description:"Get K-line", parameters:{ type:"object", properties:{ code:{type:"string"}, market:{type:"string"}, days:{type:"number"} }, required:["code"] } });
  registry.register("market_overview", async () => { return {total:5200, up:2800, down:1900, flat:500, description:"今日市场涨多跌少"}; },
    { name:"market_overview", description:"Market overview", parameters:{ type:"object", properties:{} } });
}
