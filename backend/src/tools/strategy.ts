/**
 * Unified Strategy Tool — strategy(generate|reload|optimize)
 *
 * Replaces: generate_strategy, reload_plugins, optimize_strategy
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { generateStrategyTool } from "./strategy-generator";
import { reloadPluginsTool } from "./strategy-generator";
import { optimizeStrategyTool } from "./strategy-optimize";

// ===== Handler: dispatch by sub_cmd =====

const strategyHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  if (!subCmd) return "❌ Error: sub_cmd is required. Options: generate, reload, optimize";

  switch (subCmd) {
    case "generate": {
      // generate_strategy has a sync handler, but we call it uniformly
      const result = generateStrategyTool.fn(args);
      return typeof result === "string" ? result : await result;
    }

    case "reload": {
      const result = reloadPluginsTool.fn(args);
      return typeof result === "string" ? result : await result;
    }

    case "optimize": {
      return await optimizeStrategyTool.fn(args);
    }

    default:
      return `❌ Unknown sub_cmd: "${subCmd}". Options: generate, reload, optimize`;
  }
};

// ===== Params =====

const strategyParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: `Sub-command: generate / reload / optimize

generate(plugin_id, plugin_name?, description?, strategies_json) — Generate a new strategy plugin
  strategies_json: JSON array of strategy definitions with execute_fn body
reload — Force-reload all strategy plugins from disk
optimize(strategy_id, param, min, max, steps?, mode?) — Grid-search optimize a strategy parameter
  mode: 'balance' (find sweet spot), 'maximize' (most matches), 'minimize' (fewest)
`,
  },
  // generate
  { name: "plugin_id", type: "string", description: "Unique plugin ID (e.g. 'ai-momentum') — for sub_cmd=generate", required: false },
  { name: "plugin_name", type: "string", description: "Plugin display name — for sub_cmd=generate", required: false },
  { name: "description", type: "string", description: "Plugin description — for sub_cmd=generate", required: false },
  { name: "strategies_json", type: "string", description: "JSON array of strategy definitions — for sub_cmd=generate", required: false },
  // optimize
  { name: "strategy_id", type: "string", description: "Strategy ID to optimize — for sub_cmd=optimize", required: false },
  { name: "param", type: "string", description: "Parameter key to optimize — for sub_cmd=optimize", required: false },
  { name: "min", type: "number", description: "Minimum value — for sub_cmd=optimize", required: false },
  { name: "max", type: "number", description: "Maximum value — for sub_cmd=optimize", required: false },
  { name: "steps", type: "number", description: "Number of steps in grid search (default: 10) — for sub_cmd=optimize", required: false },
  { name: "mode", type: "string", description: "balance|maximize|minimize (default: balance) — for sub_cmd=optimize", required: false },
  { name: "target_match_count", type: "number", description: "For balance mode: ideal match count — for sub_cmd=optimize", required: false },
  { name: "fixed_params_json", type: "string", description: "JSON of fixed params — for sub_cmd=optimize", required: false },
];

// ===== Export =====

export const strategyTool = new Tool(
  "strategy",
  `Unified strategy management tool. Use sub_cmd to choose operation.

generate(plugin_id, plugin_name?, description?, strategies_json) → Generate AI-designed strategy plugin
reload → Force-reload all strategy plugins from disk
optimize(strategy_id, param, min, max, steps?, mode?) → Grid-search optimize a parameter

Examples:
  strategy(sub_cmd="reload")
  strategy(sub_cmd="generate", plugin_id="my-strat", plugin_name="My Strategy", strategies_json='[{"id":"test","name":"Test","execute_fn":"return []"}]')
  strategy(sub_cmd="optimize", strategy_id="low-pe", param="maxPe", min=5, max=50, steps=10)
`,
  strategyParams,
  strategyHandler,
);

export function registerStrategyTool(registry: ToolRegistry): void {
  registry.register(strategyTool);
}
