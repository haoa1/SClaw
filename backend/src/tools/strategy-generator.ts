/**
 * Strategy Generator — AI generates new trading strategies as plugins.
 * Dynamically creates plugin files and hot-reloads them.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { reloadPlugins } from "./strategy-validator";
import * as path from "path";
import * as fs from "fs";

// ===== Helpers =====

let pluginsDirCache: string | null = null;

function resolvePluginsDir(): string | null {
  if (pluginsDirCache) return pluginsDirCache;

  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "..", "plugins"),
    path.resolve(process.cwd(), "..", "plugins"),
    path.resolve(process.cwd(), "plugins"),
    path.resolve(__dirname, "..", "..", "..", "plugins"),
  ];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        pluginsDirCache = dir;
        return dir;
      }
    } catch { /* ignore */ }
  }

  // Fallback: create at project root
  const fallback = path.resolve(__dirname, "..", "..", "..", "..", "plugins");
  try {
    fs.mkdirSync(fallback, { recursive: true });
    pluginsDirCache = fallback;
    return fallback;
  } catch {
    return null;
  }
}

// ===== Security: execute_fn Sanitizer =====

/** Patterns that are blocked in execute_fn (dangerous Node.js APIs) */
const BLOCKED_EXEC_PATTERNS: RegExp[] = [
  /process\.env/i,
  /\brequire\s*\(/,
  /\bimport\s+.*\s+from\s+/,
  /\bchild_process\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bfs\./,
  /\bexec(File)?(Sync)?\s*\(/,
  /\bspawn(Sync)?\s*\(/,
  /\bfork\s*\(/,
  /process\.exit/,
  /process\.kill/,
  /process\.abort/,
  /global\./,
  /\bglobalThis\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

/**
 * Sanitize execute_fn — returns true if safe, or error string if blocked.
 */
function sanitizeExecuteFn(code: string): true | string {
  for (const pattern of BLOCKED_EXEC_PATTERNS) {
    if (pattern.test(code)) {
      return `Code contains blocked pattern: ${pattern}`;
    }
  }
  // Check for path traversal in string literals
  if (/['"][.][.]\/['"]/.test(code) || /['"][/]\s*etc\s*\//.test(code)) {
    return "Code contains suspicious path traversal";
  }
  return true;
}

// ===== Code Generator =====

interface ParamDef {
  key: string;
  label: string;
  type: string;
  default: any;
  options?: string[];
  min?: number;
  max?: number;
}

interface StrategyDef {
  id: string;
  name: string;
  description: string;
  category: string;
  params: ParamDef[];
  execute_fn: string;
}

function buildPluginSource(
  pluginId: string,
  pluginName: string,
  description: string,
  strategies: StrategyDef[]
): string {
  const stratSources = strategies.map((s) => {
    const paramsJson = JSON.stringify(s.params, null, 4)
      .split("\n")
      .map((l, i) => (i === 0 ? l : "      " + l))
      .join("\n");

    // Indent the execute_fn body
    const bodyLines = s.execute_fn.split("\n");

    return `    {
      id: '${s.id}',
      name: '${s.name.replace(/'/g, "\\'")}',
      description: '${s.description.replace(/'/g, "\\'")}',
      category: '${s.category}',
      params: ${paramsJson},
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
${bodyLines.map((l) => "        " + l).join("\n")}
      },
    }`;
  });

  return (
    `import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';\n\n` +
    `const plugin: StockScreenerPlugin = {\n` +
    `  id: '${pluginId}',\n` +
    `  name: '${pluginName.replace(/'/g, "\\'")}',\n` +
    `  version: '1.0.0',\n` +
    `  description: '${description.replace(/'/g, "\\'")}',\n` +
    `  strategies: [\n` +
    stratSources.join(",\n") +
    `\n  ],\n};\n\n` +
    `export default plugin;\n`
  );
}

// ===== Tool: generate_strategy =====

const generateStrategyParams: ToolParamDef[] = [
  {
    name: "plugin_id",
    type: "string",
    description: "Unique plugin ID (e.g. 'ai-momentum')",
  },
  {
    name: "plugin_name",
    type: "string",
    description: "Plugin display name (e.g. 'AI动量策略')",
  },
  {
    name: "description",
    type: "string",
    description: "Plugin description",
    required: false,
  },
  {
    name: "strategies_json",
    type: "string",
    description: `JSON array of strategy definitions. Each strategy object:
{
  "id": "strategy-id",
  "name": "策略名称",
  "description": "策略描述",
  "category": "long-term|mid-term|short-term|day-trade|special|sector|macro|quant|momentum|income|reversal",
  "params": [
    {
      "key": "param1",
      "label": "参数名",
      "type": "number|string|boolean|select",
      "default": 10,
      "min": 0,
      "max": 100,
      "options": ["a","b"]   // only for 'select' type
    }
  ],
  "execute_fn": "TypeScript/JavaScript code for the function body. Available: data (StockData[]), params (Record<string,any>). Must return FilterResult[] sorted by score desc. Each result: { code: string, name: string, score: number (0-100), signals: string[], metrics: Record<string,number> }"
}`,
  },
];

const generateStrategyFn = (args: Record<string, unknown>): string => {
  const pluginId = (args.plugin_id as string || "").trim();
  const pluginName = (args.plugin_name as string || pluginId).trim();
  const description = (args.description as string || `AI generated plugin: ${pluginName}`).trim();
  const strategiesJson = (args.strategies_json as string || "[]").trim();

  // Validate plugin_id
  if (!pluginId) return "❌ Error: plugin_id is required";
  if (!/^[a-z0-9_-]+$/.test(pluginId)) {
    return "❌ Error: plugin_id must be lowercase alphanumeric with hyphens/underscores only";
  }

  // Parse strategies
  let strategies: StrategyDef[];
  try {
    strategies = JSON.parse(strategiesJson);
  } catch (e) {
    return `❌ Error: strategies_json parse failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!Array.isArray(strategies) || strategies.length === 0) {
    return "❌ Error: strategies_json must be a non-empty array";
  }

  // Validate each strategy
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    if (!s.id || typeof s.id !== "string") return `❌ Error: strategy[${i}] must have string 'id'`;
    if (!s.name || typeof s.name !== "string") return `❌ Error: strategy[${i}] must have string 'name'`;
    if (!s.execute_fn || typeof s.execute_fn !== "string") return `❌ Error: strategy[${i}] must have string 'execute_fn'`;
    if (!s.description) s.description = s.name;
    if (!s.category) s.category = "special";
    if (!Array.isArray(s.params)) s.params = [];

    // Validate category
    const validCategories = ["long-term", "mid-term", "short-term", "day-trade", "special", "sector", "macro", "quant", "momentum", "income", "reversal"];
    if (!validCategories.includes(s.category)) {
      return `❌ Error: strategy[${i}] category '${s.category}' invalid. Must be one of: ${validCategories.join(", ")}`;
    }

    // 🔒 Security: sanitize execute_fn — block dangerous Node.js APIs
    const sanitized = sanitizeExecuteFn(s.execute_fn);
    if (sanitized !== true) {
      return `❌ Error: strategy[${i}] execute_fn contains blocked code: ${sanitized}`;
    }
  }

  // Find plugins directory
  const pluginsDir = resolvePluginsDir();
  if (!pluginsDir) {
    return "❌ Error: Cannot find or create plugins directory";
  }

  // Create plugin directory
  const pluginDir = path.join(pluginsDir, pluginId);
  try {
    if (fs.existsSync(pluginDir)) {
      return `❌ Error: Plugin directory already exists: ${pluginDir}. Use a different plugin_id or delete the directory first.`;
    }
    fs.mkdirSync(pluginDir, { recursive: true });
  } catch (e) {
    return `❌ Error: Cannot create plugin directory: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Generate and write plugin source
  const source = buildPluginSource(pluginId, pluginName, description, strategies);
  const outputPath = path.join(pluginDir, "index.ts");

  try {
    fs.writeFileSync(outputPath, source, "utf-8");
  } catch (e) {
    return `❌ Error: Cannot write plugin file: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Reload plugins
  try {
    const reloaded = reloadPlugins();
    const pluginFound = reloaded.find((p: any) => p.id === pluginId);
    const pluginStatus = pluginFound
      ? `✅ 已成功加载 (${pluginFound.strategies.length} 个策略)`
      : "⚠️ 已写入但加载失败，请检查插件格式";

    return `✅ 策略插件已生成！

📁 路径: ${outputPath}
📦 插件: ${pluginName} (${pluginId})
📝 说明: ${description}
📊 策略数: ${strategies.length} 个
🔄 当前总插件: ${reloaded.length} 个
📌 状态: ${pluginStatus}

策略列表:
${strategies.map((s, i) => `  ${i + 1}. [${s.id}] ${s.name} (${s.category})`).join("\n")}

💡 提示:
• 用 list_strategies 查看新策略详情
• 用 run_screen 运行筛选
• 策略ID可在 run_screen 中使用：{ "id": "${strategies[0].id}", "params": {} }`;
  } catch (e: unknown) {
    return `⚠️ 文件已写入 ${outputPath}，但热加载失败: ${e instanceof Error ? e.message : String(e)}。\n请使用 reload_plugins 手动重载。`;
  }
};

export const generateStrategyTool = new Tool(
  "generate_strategy",
  "Generate a new trading strategy plugin from AI-designed logic and hot-reload it. Creates the plugin file, writes it to the plugins directory, and reloads all plugins automatically.",
  generateStrategyParams,
  generateStrategyFn
);

// ===== Tool: reload_plugins =====

const reloadPluginsParams: ToolParamDef[] = [];

const reloadPluginsFn = (): string => {
  try {
    const plugins = reloadPlugins();
    const totalStrats = plugins.reduce((sum: number, p: any) => sum + p.strategies.length, 0);

    if (plugins.length === 0) {
      return "⚠️ 未加载到任何插件。请检查 plugins/ 目录。";
    }

    return `✅ 插件已重新加载！

共 ${plugins.length} 个插件，${totalStrats} 个策略

${(plugins as any[])
  .map(
    (p) =>
      `  📦 ${p.name} v${p.version} — ${p.strategies.length} 个策略`
  )
  .join("\n")}`;
  } catch (e: unknown) {
    return `❌ 重载插件失败: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const reloadPluginsTool = new Tool(
  "reload_plugins",
  "Force-reload all strategy plugins from disk. Use this after manually editing plugin files, or if hot-reload fails after generate_strategy.",
  reloadPluginsParams,
  reloadPluginsFn
);

// ===== Register All =====

export function registerStrategyGeneratorTools(registry: ToolRegistry): void {
  registry.register(generateStrategyTool);
  registry.register(reloadPluginsTool);
}
