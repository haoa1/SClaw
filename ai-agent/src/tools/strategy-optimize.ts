import { ToolRegistry } from "./registry";
export function registerOptimizeTools(registry: ToolRegistry): void {
  registry.register("optimize_strategy", async (a: any) => ({strategy_id:a.strategy_id, best_params:{}, results:[]}),
    { name:"optimize_strategy", description:"Optimize strategy", parameters:{ type:"object", properties:{ strategy_id:{type:"string"}, param:{type:"string"}, min:{type:"number"}, max:{type:"number"}, steps:{type:"number"} }, required:["strategy_id","param"] } });
}
