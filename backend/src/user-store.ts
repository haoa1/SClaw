/**
 * Per-user persistent storage.
 * Stores config, screen history, and operation logs as JSON files.
 *
 * data/
 *   users/
 *     {userId}/
 *       config.json    — user preferences (selected strategies, UI state)
 *       screens.json   — history of screening runs
 *       logs.json      — operation log entries
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ===== Types =====

export interface UserConfig {
  selectedStrategies: Array<{
    pluginId: string;
    strategyId: string;
    strategyName: string;
    params: Record<string, any>;
  }>;
  preferences: Record<string, any>; // future: theme, layout, etc.
  model?: string; // user's selected AI model, e.g. "deepseek-v4-flash"
}

export interface ScreenRecord {
  id: string;
  timestamp: number;
  strategies: Array<{ pluginId: string; strategyId: string; params: any }>;
  stats: { totalStocks: number; matchedStocks: number; executionTime: number };
  topResults: Array<{ code: string; name: string; score: number; signals: string[] }>;
  resultCount: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  type: "screen" | "chat" | "strategy" | "auth" | "system";
  action: string;
  detail: string;
}

// ===== UserStore =====

export class UserStore {
  private baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = path.join(dataDir, "users");
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private userDir(userId: string): string {
    const dir = path.join(this.baseDir, userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private fileFor(userId: string, name: string): string {
    return path.join(this.userDir(userId), name);
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch (e) {
      console.warn(`[UserStore] Failed to read ${filePath}:`, e);
    }
    return fallback;
  }

  private writeJson(filePath: string, data: any): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error(`[UserStore] Failed to write ${filePath}:`, e);
    }
  }

  // ===== Config =====

  getConfig(userId: string): UserConfig {
    return this.readJson<UserConfig>(this.fileFor(userId, "config.json"), {
      selectedStrategies: [],
      preferences: {},
    });
  }

  saveConfig(userId: string, config: UserConfig): void {
    this.writeJson(this.fileFor(userId, "config.json"), config);
  }

  // ===== Screen History =====

  getScreens(userId: string, limit = 50): ScreenRecord[] {
    const all = this.readJson<ScreenRecord[]>(
      this.fileFor(userId, "screens.json"),
      []
    );
    return all.slice(-limit).reverse(); // newest first
  }

  getScreenById(userId: string, screenId: string): ScreenRecord | null {
    const all = this.readJson<ScreenRecord[]>(
      this.fileFor(userId, "screens.json"),
      []
    );
    return all.find((s) => s.id === screenId) || null;
  }

  addScreen(userId: string, record: Omit<ScreenRecord, "id" | "timestamp">): ScreenRecord {
    const all = this.readJson<ScreenRecord[]>(
      this.fileFor(userId, "screens.json"),
      []
    );
    const entry: ScreenRecord = {
      ...record,
      id: crypto.randomBytes(8).toString("hex"),
      timestamp: Date.now(),
    };
    all.push(entry);
    // Keep last 200 entries
    const trimmed = all.slice(-200);
    this.writeJson(this.fileFor(userId, "screens.json"), trimmed);
    return entry;
  }

  // ===== Logs =====

  getLogs(userId: string, limit = 100): LogEntry[] {
    const all = this.readJson<LogEntry[]>(
      this.fileFor(userId, "logs.json"),
      []
    );
    return all.slice(-limit).reverse();
  }

  addLog(userId: string, entry: Omit<LogEntry, "id" | "timestamp">): LogEntry {
    const all = this.readJson<LogEntry[]>(
      this.fileFor(userId, "logs.json"),
      []
    );
    const log: LogEntry = {
      ...entry,
      id: crypto.randomBytes(6).toString("hex"),
      timestamp: Date.now(),
    };
    all.push(log);
    // Keep last 500 entries
    const trimmed = all.slice(-500);
    this.writeJson(this.fileFor(userId, "logs.json"), trimmed);
    return log;
  }
}

// ===== Singleton =====
let _instance: UserStore | null = null;

export function getUserStore(dataDir?: string): UserStore {
  if (!_instance) {
    const dir = dataDir || process.env["AI_AGENT_DATA_DIR"] || path.join(process.cwd(), "data");
    _instance = new UserStore(dir);
  }
  return _instance;
}
