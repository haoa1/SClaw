/**
 * Unified Strategy Tool — strategy(generate|reload|optimize|promote)
 *
 * Replaces: generate_strategy, reload_plugins, optimize_strategy
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { generateStrategyTool } from "./strategy-generator";
import { reloadPluginsTool } from "./strategy-generator";
import { optimizeStrategyTool } from "./strategy-optimize";
import { getPluginManager } from "./strategy-validator";
import * as path from "path";
import * as fs from "fs";

// ===== Handler: dispatch by sub_cmd =====

const strategyHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  if (!subCmd) return "❌ Error: sub_cmd is required. Options: generate, reload, optimize, promote";

  switch (subCmd) {
    case "generate": {
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

    case "promote": {
      return promotePlugin(args);
    }

    default:
      return `❌ Unknown sub_cmd: "${subCmd}". Options: generate, reload, optimize, promote`;
  }
};

/**
 * Promote a plugin from a user's private directory to the common directory.
 * This makes it available to ALL users.
 */
function promotePlugin(args: Record<string, unknown>): string {
  const pluginId = (args.plugin_id as string || "").trim();
  if (!pluginId) return "❌ Error: plugin_id is required for promote";

  const pm = getPluginManager();
  if (!pm) return "❌ Error: PluginManager not available";

  const commonDir = pm.getCommonPluginsDir();
  const usersRoot = pm.getUsersPluginsRoot();

  // Search all user dirs for this plugin
  let sourceDir: string | null = null;
  let sourceUser: string | null = null;

  try {
    if (!fs.existsSync(usersRoot)) return `❌ Error: Users plugins directory not found: ${usersRoot}`;
    const userDirs = fs.readdirSync(usersRoot, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const userDir of userDirs) {
      const candidate = path.join(usersRoot, userDir.name, pluginId);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        sourceDir = candidate;
        sourceUser = userDir.name;
        break;
      }
    }
  } catch (e) {
    return `❌ Error searching user plugins: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!sourceDir || !sourceUser) {
    return `❌ Plugin "${pluginId}" not found in any user plugins directory.`;
  }

  // Check if already exists in common
  const targetDir = path.join(commonDir, pluginId);
  if (fs.existsSync(targetDir)) {
    return `⚠️ Plugin "${pluginId}" already exists in common directory. Delete it first if you want to overwrite.`;
  }

  try {
    // Copy the plugin directory recursively
    copyDirSync(sourceDir, targetDir);
    // Reload plugins
    pm.reloadAll();
    return `✅ Plugin "${pluginId}" promoted from user "${sourceUser}" to common directory!

📁 Source: ${sourceDir}
📁 Target: ${targetDir}

The plugin is now available to ALL users.
Use strategy(sub_cmd="reload") to confirm it loaded.`;
  } catch (e) {
    return `❌ Failed to promote plugin: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Recursively copy a directory */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ===== Params =====

const strategyParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: `Sub-command: generate / reload / optimize / promote

generate(plugin_id, plugin_name?, description?, strategies_json) — Generate a new strategy plugin
  strategies_json: JSON array of strategy definitions with execute_fn body
reload — Force-reload all strategy plugins from disk
optimize(strategy_id, param, min, max, steps?, mode?) — Grid-search optimize a strategy parameter
  mode: 'balance' (find sweet spot), 'maximize' (most matches), 'minimize' (fewest)
promote(plugin_id) — Promote a user plugin to common (makes it available to ALL users)
`,
  },
  // generate
  { name: "plugin_id", type: "string", description: "Unique plugin ID (e.g. 'ai-momentum') — for sub_cmd=generate|promote", required: false },
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
promote(plugin_id) → Promote user plugin to common directory (all users)

Examples:
  strategy(sub_cmd="reload")
  strategy(sub_cmd="generate", plugin_id="my-strat", plugin_name="My Strategy", strategies_json='[{"id":"test","name":"Test","execute_fn":"return []"}]')
  strategy(sub_cmd="optimize", strategy_id="low-pe", param="maxPe", min=5, max=50, steps=10)
  strategy(sub_cmd="promote", plugin_id="my-strat")
`,
  strategyParams,
  strategyHandler,
);

export function registerStrategyTool(registry: ToolRegistry): void {
  registry.register(strategyTool);
}
