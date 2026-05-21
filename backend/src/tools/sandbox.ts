/**
 * Sandbox Tool - safely execute scripts within a skill's scripts/ directory.
 *
 * Scripts live at ~/.sclaw/skills/<skill>/scripts/<script>.js
 * Run via run_script({ skill: "fund-tracker", script: "fund_api.js", args: [...] })
 *
 * Security: path traversal blocked, 30s timeout, output capped 50K chars.
 */

import { execFile } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { ToolRegistry, Tool } from "./registry";

const SKILLS_DIR = path.join(os.homedir(), ".sclaw", "skills");
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

function runScript(
  scriptPath: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_CHARS,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
      (error, stdout, stderr) => {
        const exitCode = error?.code ?? 0;
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: exitCode ?? -1,
        });
      }
    );
  });
}

/**
 * Resolve script path: ~/.sclaw/skills/<skill>/scripts/<script>.js
 * Returns the full path if valid, or an error message.
 */
function resolveScriptPath(skillName: string, scriptName: string): { ok: true; fullPath: string } | { ok: false; error: string } {
  // Prevent path traversal in both params
  const cleanedSkill = path.normalize(skillName).replace(/^(\.\.(\/|\\|$))+/, "");
  const cleanedScript = path.normalize(scriptName).replace(/^(\.\.(\/|\\|$))+/, "");
  if (cleanedSkill.includes("..") || cleanedScript.includes("..")) {
    return { ok: false, error: "Path traversal detected: skill/script name must not contain '..'" };
  }

  const scriptsDir = path.resolve(SKILLS_DIR, cleanedSkill, "scripts");
  const fullPath = path.resolve(scriptsDir, cleanedScript);

  // Must be within the skill's scripts directory
  if (!fullPath.startsWith(scriptsDir + path.sep)) {
    return { ok: false, error: "Script must be inside ~/.sclaw/skills/" + cleanedSkill + "/scripts/" };
  }

  // Must exist and be a file
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return { ok: false, error: "Not a file: " + fullPath };
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, error: "Script not found: " + fullPath };
    }
    return { ok: false, error: "Error accessing script: " + err.message };
  }

  try {
    fs.accessSync(fullPath, fs.constants.R_OK);
  } catch {
    return { ok: false, error: "Script not readable: " + fullPath };
  }

  return { ok: true, fullPath };
}

export function registerSandboxTools(registry: ToolRegistry): void {
  registry.register(
    new Tool(
      "run_script",
      "Execute a script from a skill's scripts/ directory in a sandboxed environment. Scripts live at ~/.sclaw/skills/<skill>/scripts/<script>.js. Use this to run tools that fetch external data (e.g., fund data, market data). All scripts run with a 30-second timeout. Output is captured and returned as text. Use list_skills to see available skills and their scripts.",
      [
        {
          name: "skill",
          type: "string",
          description:
            "Skill name (e.g., 'fund-tracker'). The script lives at ~/.sclaw/skills/<skill>/scripts/.",
        },
        {
          name: "script",
          type: "string",
          description:
            "Script file name (e.g., 'fund_api.js'). Must exist in the skill's scripts/ directory.",
        },
        {
          name: "args",
          type: "string",
          description:
            'Arguments to pass to the script, as a JSON array of strings. Example: ["search", "\\u6613\\u65b9\\u8fbe"]',
          required: false,
        },
        {
          name: "timeout",
          type: "number",
          description:
            "Max execution time in seconds (default: 30, max: 60).",
          required: false,
        },
      ],
      async (args) => {
        const skillName = args["skill"] as string;
        const scriptName = args["script"] as string;

        if (!skillName || !scriptName) {
          return JSON.stringify({ error: `Both 'skill' and 'script' are required. Example: run_script({ skill: \\"fund-tracker\\", script: \\"fund_api.js\\", args: [...] })` });
        }

        const rawArgs = args["args"];
        let scriptArgs: string[] = [];
        if (rawArgs) {
          try {
            scriptArgs =
              typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs as string[]);
            if (!Array.isArray(scriptArgs)) {
              scriptArgs = [String(rawArgs)];
            }
          } catch {
            scriptArgs = [String(rawArgs)];
          }
        }

        const requestedTimeout = (args["timeout"] as number) || 30;
        const timeoutMs = Math.min(Math.max(requestedTimeout * 1000, 1000), 60_000);

        // Validate script path
        const resolved = resolveScriptPath(skillName, scriptName);
        if (!resolved.ok) {
          return JSON.stringify({ error: resolved.error });
        }

        try {
          const result = await runScript(
            resolved.fullPath,
            scriptArgs,
            Math.min(timeoutMs, MAX_TIMEOUT_MS)
          );

          const output: Record<string, unknown> = {
            skill: skillName,
            script: scriptName,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(0, MAX_OUTPUT_CHARS),
          };

          if (result.stderr) {
            output.stderr = result.stderr.slice(0, 10_000);
          }

          if (result.exitCode !== 0) {
            output.warning = "Script exited with code " + result.exitCode;
          }

          return JSON.stringify(output, null, 2);
        } catch (err) {
          return JSON.stringify({
            error: "Script execution failed: " + err.message,
            skill: skillName,
            script: scriptName,
          });
        }
      }
    )
  );
}
