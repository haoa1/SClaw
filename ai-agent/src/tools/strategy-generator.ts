import { ToolRegistry } from "./registry";
export function registerStrategyGeneratorTools(registry: ToolRegistry): void {
  registry.register("generate_strategy", async (a: any) => ({status:"ok", plugin_id:a.plugin_id||"custom", message:"Strategy generated"}),
    { name:"generate_strategy", description:"Generate strategy", parameters:{ type:"object", properties:{ plugin_id:{type:"string"}, plugin_name:{type:"string"}, description:{type:"string"}, strategies_json:{type:"string"} }, required:["plugin_id","strategies_json"] } });
  registry.register("reload_plugins", async () => ({status:"ok", message:"Plugins reloaded"}),
    { name:"reload_plugins", description:"Reload plugins", parameters:{ type:"object", properties:{} } });
}
