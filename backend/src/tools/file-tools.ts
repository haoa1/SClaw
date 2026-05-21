/**
 * File tools with security hardening.
 *
 * Security features:
 * - All paths restricted to PROJECT_ROOT (no ../ escape)
 * - Sensitive system paths blocked (/proc, /etc, .env, etc.)
 * - bash: env vars stripped, dangerous commands blocked, output sanitized
 * - glob/grep: search path restricted to PROJECT_ROOT
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import * as fs from "fs";
import * as path from "path";

// ===== Security: Path Restrictions =====

/** Project root — computed from backend/src/tools/ -> backend/ -> SClaw root */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Regex patterns for blocked file paths (case-insensitive) */
const BLOCKED_PATTERNS: RegExp[] = [
  /\.env$/i,
  /[\/\\]proc[\/\\]/,
  /[\/\\]etc[\/\\]/,
  /[\/\\]sys[\/\\]/,
  /authorized_keys$/i,
  /shadow$/i,
  /passwd$/i,
  /sudoers$/i,
];

/** Check if a path is allowed: must resolve to within PROJECT_ROOT */
function isPathAllowed(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  // Must be within project root
  if (!resolved.startsWith(PROJECT_ROOT)) {
    return "Access denied: path is outside the project directory";
  }
  // Must not match blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(resolved)) {
      return `Access denied: path matches blocked pattern ${pattern}`;
    }
  }
  return null; // allowed
}

/** Sanitize output by redacting sensitive patterns */
function sanitizeOutput(output: string): string {
  // API key patterns (sk-xxxx, deepseek_xxxx)
  const patterns = [
    { regex: /[Ss][Kk]-[a-zA-Z0-9]{20,}/g, replacement: "[API_KEY_REDACTED]" },
    { regex: /deepseek_[a-zA-Z0-9]{30,}/g, replacement: "[API_KEY_REDACTED]" },
    { regex: /sk-placeholder/g, replacement: "[REDACTED]" },
  ];
  let sanitized = output;
  for (const { regex, replacement } of patterns) {
    sanitized = sanitized.replace(regex, replacement);
  }
  return sanitized;
}

// ===== Security: Bash Command Blacklist =====

/** Sensitive env vars to strip from bash subprocess */
const SENSITIVE_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LLM_MODEL",
  "SMTP_AUTH_CODE",
  "SMTP_PASSWORD",
  "SMTP_USER",
];

/** Patterns for dangerous shell commands (checked BEFORE execution) */
const BLOCKED_COMMANDS: RegExp[] = [
  /rm\s+-[rf]+\s+\//,           // rm -rf /
  /mkfs\s/,                       // Format disk
  /dd\s+if=/i,                    // Disk write
  /:\(\)\s*\{/,                   // Fork bomb
  />\s*\/dev\/(sda|sdb|hda|nvme)/i, // Direct device write
  /\|?\s*bash\s+</,               // Pipe to bash
  /\|\s*sh\s*$/,                  // Pipe to sh
];

/** Build a clean environment for subprocess execution */
function buildCleanEnv(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (!SENSITIVE_ENV_KEYS.includes(key)) {
      clean[key] = process.env[key] as string;
    }
  }
  return clean;
}

/** Check command against blacklist — returns error message or null if safe */
function checkCommand(command: string): string | null {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return `Security blocked: command matches dangerous pattern ${pattern}`;
    }
  }
  return null;
}

// ===== read_file =====

const readFileParams: ToolParamDef[] = [
  { name: "file_path", type: "string", description: "Absolute path to file (must be within project directory)" },
  { name: "offset", type: "number", description: "Start line", required: false },
  { name: "limit", type: "number", description: "Max lines", required: false },
];

const readFileFn = (args: Record<string, unknown>): string => {
  const filePath = args.file_path as string;
  if (!filePath) return "Error: file_path is required";

  // Security: path restriction
  const denied = isPathAllowed(filePath);
  if (denied) return denied;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const offset = (args.offset as number) ?? 0;
    const limit = args.limit as number | undefined;
    const slice = limit ? lines.slice(offset, offset + limit) : lines.slice(offset);
    return sanitizeOutput(slice.join("\n"));
  } catch (e: unknown) {
    return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const readFileTool = new Tool("read_file", "Read a file from disk", readFileParams, readFileFn);

// ===== write_file =====

const writeFileParams: ToolParamDef[] = [
  { name: "file_path", type: "string", description: "Absolute path to file (must be within project directory)" },
  { name: "content", type: "string", description: "File content" },
];

const writeFileFn = (args: Record<string, unknown>): string => {
  const filePath = args.file_path as string;
  const content = args.content as string;
  if (!filePath || content === undefined) return "Error: file_path and content are required";

  // Security: path restriction
  const denied = isPathAllowed(filePath);
  if (denied) return denied;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return `Written ${content.length} bytes to ${filePath}`;
  } catch (e: unknown) {
    return `Error writing file: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const writeFileTool = new Tool("write_file", "Write a file to disk", writeFileParams, writeFileFn);

// ===== bash =====

const bashParams: ToolParamDef[] = [
  { name: "command", type: "string", description: "Shell command to run (dangerous commands blocked)" },
  { name: "timeout", type: "number", description: "Timeout in seconds", required: false, default: 30 },
];

const bashFn = (args: Record<string, unknown>): string => {
  const command = args.command as string;
  if (!command) return "Error: command is required";

  // Security: command blacklist check
  const blocked = checkCommand(command);
  if (blocked) return blocked;

  try {
    const { execSync } = require("child_process");
    const timeout = (args.timeout as number) ?? 30;

    // Security: execute with cleaned environment (no API keys)
    const cleanEnv = buildCleanEnv();

    const result = execSync(command, {
      timeout: timeout * 1000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      env: cleanEnv,  // ← strip sensitive env vars
    });

    // Security: sanitize output (redact API key patterns)
    return sanitizeOutput(result) || "(empty output)";
  } catch (e: unknown) {
    if (e instanceof Error && "stdout" in e && "stderr" in e) {
      const err = e as Error & { stdout: string; stderr: string };
      return sanitizeOutput(
        `Exit code: ${(e as any).status}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`
      );
    }
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const bashTool = new Tool(
  "bash",
  "Run a shell command. Restricted: dangerous commands blocked, env cleaned of secrets, output sanitized.",
  bashParams,
  bashFn,
);

// ===== glob =====

const globParams: ToolParamDef[] = [
  { name: "pattern", type: "string", description: "Glob pattern to match" },
  { name: "path", type: "string", description: "Directory to search (must be within project directory)", required: false, default: "." },
];

const globFn = (args: Record<string, unknown>): string => {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || ".";
  if (!pattern) return "Error: pattern is required";

  // Security: restrict search path to project root
  let cwd = searchPath;
  const denied = isPathAllowed(cwd);
  if (denied) cwd = PROJECT_ROOT; // fall back to project root

  try {
    const { globSync } = require("glob");
    const results = globSync(pattern, { cwd, absolute: true });
    return results.length > 0 ? results.join("\n") : "No matches found";
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const globTool = new Tool("glob", "Find files by glob pattern (restricted to project directory)", globParams, globFn);

// ===== grep =====

const grepParams: ToolParamDef[] = [
  { name: "pattern", type: "string", description: "Regex pattern" },
  { name: "path", type: "string", description: "Path to search (must be within project directory)", required: false, default: "." },
  { name: "-i", type: "boolean", description: "Case insensitive", required: false, default: false },
];

const grepFn = (args: Record<string, unknown>): string => {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || ".";
  const caseInsensitive = (args["-i"] as boolean) || false;
  if (!pattern) return "Error: pattern is required";

  // Security: restrict search path to project root
  let safePath = searchPath;
  const denied = isPathAllowed(safePath);
  if (denied) safePath = PROJECT_ROOT; // fall back to project root

  try {
    const { execSync } = require("child_process");
    const flags = caseInsensitive ? "-in" : "-n";
    const result = execSync(
      `grep -r ${flags} "${pattern}" "${safePath}" 2>/dev/null || true`,
      { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );
    const lines = result.split("\n").filter((l: string) => l.trim());
    return lines.length > 0 ? lines.join("\n") : "No matches found";
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const grepTool = new Tool(
  "grep",
  "Search for patterns in files (restricted to project directory)",
  grepParams,
  grepFn,
);

// ===== Register all =====

export function registerFileTools(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(globTool);
  registry.register(grepTool);
}
