import { ToolRegistry } from "./registry";
export function registerRiskTools(registry: ToolRegistry): void {
  registry.register("assess_portfolio_risk", async () => ({risk_level:"medium", concentration:0.3, var_95:-0.05, suggestions:["分散投资降低风险"]}),
    { name:"assess_portfolio_risk", description:"Portfolio risk", parameters:{ type:"object", properties:{ codes_json:{type:"string"}, weights_json:{type:"string"}, total_value:{type:"number"} }, required:["codes_json"] } });
  registry.register("assess_stock_risk", async (a: any) => ({code:a.code, risk_level:"low", volatility:0.25, suggestion:"正常"}),
    { name:"assess_stock_risk", description:"Stock risk", parameters:{ type:"object", properties:{ code:{type:"string"} }, required:["code"] } });
}
