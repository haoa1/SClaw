import { ToolRegistry } from "./registry";
export function registerStrategyTools(registry: ToolRegistry): void {
  registry.register("list_strategies", async (a: any) => [
    { id:"pe-value", name:"低市盈率选股", category:"long-term", description:"筛选市盈率低的股票", params:[{key:"max_pe",label:"最大市盈率",type:"number",default:15}] },
    { id:"pb-value", name:"破净选股", category:"long-term", description:"筛选市净率低于1的股票", params:[{key:"max_pb",label:"最大市净率",type:"number",default:1}] },
    { id:"volume-surge", name:"放量上涨", category:"short-term", description:"放量上涨的股票", params:[{key:"min_volume_ratio",label:"最小量比",type:"number",default:1.5}] },
    { id:"limit-up", name:"涨停监测", category:"short-term", description:"检测涨停股票", params:[{key:"min_pct",label:"最小涨幅",type:"number",default:9.5}] },
    { id:"high-turnover", name:"换手活跃", category:"short-term", description:"换手率活跃的股票", params:[{key:"min_turnover",label:"最小换手率",type:"number",default:3}] },
  ], { name:"list_strategies", description:"List strategies", parameters:{ type:"object", properties:{ category:{type:"string"} } } });
  registry.register("run_multi_strategy", async () => ({results:[], stats:{totalStocks:5200,matchedStocks:0}}),
    { name:"run_multi_strategy", description:"Run multi strategy", parameters:{ type:"object", properties:{ strategies_json:{type:"string"}, combine_mode:{type:"string"}, limit:{type:"number"} }, required:["strategies_json"] } });
}
