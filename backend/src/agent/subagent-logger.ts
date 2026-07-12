/**
 * SubAgent Logger — saves full messages history per subagent run.
 *
 * Architecture:
 *   ~/.sclaw/subagent-logs/{agentType}/{YYYY-MM-DD}_{description}_{taskId}.json
 *
 * Each file contains the complete messages array from the subagent's LLM loop,
 * which includes system prompt, user query, all tool calls/results, and final answer.
 *
 * This lets you review every step of any past subagent run.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LLMMessage } from "./llm";

/** Metadata for a subagent run, stored alongside the messages */
export interface SubAgentRunMeta {
  taskId: string;
  agentType: string;
  description: string;
  userId: string;
  status: "completed" | "failed" | "cancelled";
  ts: number;           // completion timestamp
  iso: string;          // ISO format
  durationMs: number;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;       // for failed/cancelled runs
}

export interface SubAgentLogQuery {
  agentType?: string;
  description?: string;  // fuzzy match in filename
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

const LOGS_DIR = path.join(os.homedir(), ".sclaw", "subagent-logs");

export class SubAgentLogger {

  constructor() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  /**
   * Save a complete subagent run: messages + metadata.
   *
   * Writes to: ~/.sclaw/subagent-logs/{agentType}/{date}_{description}_{taskId}.json
   *
   * The file structure:
   * {
   *   "meta": { ... SubAgentRunMeta ... },
   *   "messages": [ ... LLMMessage[] ... ]
   * }
   */
  saveRun(
    meta: SubAgentRunMeta,
    messages: LLMMessage[],
  ): void {
    try {
      const agentDir = path.join(LOGS_DIR, meta.agentType);
      fs.mkdirSync(agentDir, { recursive: true });

      const dateStr = meta.iso.slice(0, 10); // YYYY-MM-DD
      const safeDesc = (meta.description || "unknown")
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
        .slice(0, 40);
      const filename = `${dateStr}_${safeDesc}_${meta.taskId}.json`;
      const filepath = path.join(agentDir, filename);

      fs.writeFileSync(
        filepath,
        JSON.stringify({ meta, messages }, null, 2),
        "utf-8",
      );
    } catch {
      // best effort — logging should never crash the app
    }
  }

  /** List saved run files matching query */
  listRuns(q: SubAgentLogQuery): { file: string; meta: SubAgentRunMeta }[] {
    try {
      const results: { file: string; meta: SubAgentRunMeta }[] = [];
      const agentDirs = q.agentType
        ? [q.agentType]
        : fs.readdirSync(LOGS_DIR).filter((d) =>
            fs.statSync(path.join(LOGS_DIR, d)).isDirectory(),
          );

      for (const agentDir of agentDirs) {
        const dirPath = path.join(LOGS_DIR, agentDir);
        if (!fs.existsSync(dirPath)) continue;

        const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json"));
        for (const file of files) {
          try {
            const content = JSON.parse(
              fs.readFileSync(path.join(dirPath, file), "utf-8"),
            );
            const meta = content.meta as SubAgentRunMeta;
            if (this.matches(meta, q)) {
              results.push({ file: path.join(agentDir, file), meta });
            }
          } catch {
            // skip corrupt files
          }
        }
      }

      // Sort newest first
      results.sort((a, b) => b.meta.ts - a.meta.ts);

      const offset = q.offset || 0;
      const limit = q.limit || 50;
      return results.slice(offset, offset + limit);
    } catch {
      return [];
    }
  }

  /** Load the full messages for a specific run file */
  loadMessages(filePath: string): { meta: SubAgentRunMeta; messages: LLMMessage[] } | null {
    try {
      const fullPath = path.join(LOGS_DIR, filePath);
      if (!fs.existsSync(fullPath)) return null;
      const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      return content as { meta: SubAgentRunMeta; messages: LLMMessage[] };
    } catch {
      return null;
    }
  }

  /** Count run files matching query */
  countRuns(q: SubAgentLogQuery): number {
    try {
      let count = 0;
      const agentDirs = q.agentType
        ? [q.agentType]
        : fs.readdirSync(LOGS_DIR).filter((d) =>
            fs.statSync(path.join(LOGS_DIR, d)).isDirectory(),
          );

      for (const agentDir of agentDirs) {
        const dirPath = path.join(LOGS_DIR, agentDir);
        if (!fs.existsSync(dirPath)) continue;
        const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json"));
        for (const file of files) {
          try {
            const content = JSON.parse(
              fs.readFileSync(path.join(dirPath, file), "utf-8"),
            );
            if (this.matches(content.meta as SubAgentRunMeta, q)) count++;
          } catch {
            // skip
          }
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  private matches(meta: SubAgentRunMeta, q: SubAgentLogQuery): boolean {
    if (q.agentType && meta.agentType !== q.agentType) return false;
    if (q.userId && meta.userId !== q.userId) return false;
    if (q.status && meta.status !== q.status) return false;
    if (q.description) {
      const kw = q.description.toLowerCase();
      if (!meta.description.toLowerCase().includes(kw)) return false;
    }
    return true;
  }
}

/** Singleton instance */
export const subAgentLogger = new SubAgentLogger();
