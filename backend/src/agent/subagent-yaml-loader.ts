/**
 * SubAgent YAML Loader
 *
 * Loads agent definitions from YAML files in the `agents/` directory.
 * Supports hot-reload via fs.watch — edit a YAML file and the changes
 * are picked up without restarting the server.
 *
 * YAML format:
 * ```yaml
 * # agents/my-agent.yaml
 * name: my-agent
 * display_name: "我的 Agent"
 * description: "用来做 XXX 的专家"
 * emoji: "🤖"
 * prompt: |
 *   You are a specialized agent...
 * tools:
 *   allowed:
 *     - read
 *     - grep
 *     - bash
 *   disallowed: []
 * skills: []
 * max_turns: 20
 * model: claude-sonnet-4-20250514
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import * as yaml from "js-yaml";
import { AgentDefinition, SubAgentType } from "./sub-agent-types";

/** Shape of a raw YAML agent file */
interface YamlAgentConfig {
  name: string;
  display_name?: string;
  description: string;
  emoji?: string;
  prompt: string;
  tools?: {
    allowed?: string[];
    disallowed?: string[];
  };
  skills?: string[];
  max_turns?: number;
  model?: string;
}

/**
 * Manages loading, caching, and hot-reloading of YAML-defined agents.
 * Emits 'agents-updated' when the agent list changes.
 */
export class SubAgentYamlLoader extends EventEmitter {
  private agentsDir: string;
  /** Loaded YAML agents: { agentType → AgentDefinition } */
  private agents = new Map<string, AgentDefinition>();
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(agentsDir: string) {
    super();
    this.agentsDir = agentsDir;
  }

  /** Initialize: ensure dir exists, load all YAML files, start watcher */
  init(): void {
    // Ensure agents directory exists
    fs.mkdirSync(this.agentsDir, { recursive: true });

    // Initial load
    this.loadAll();

    // Start watching for changes
    this.startWatcher();

    console.log(
      `[SubAgentYamlLoader] Loaded ${this.agents.size} YAML agents from ${this.agentsDir}`,
    );
  }

  /** Get all loaded YAML agent definitions */
  getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /** Get a specific agent by type */
  get(agentType: string): AgentDefinition | undefined {
    return this.agents.get(agentType);
  }

  /** Check if an agent type exists */
  has(agentType: string): boolean {
    return this.agents.has(agentType);
  }

  /** Reload all YAML files from disk */
  reloadAll(): void {
    this.loadAll();
    this.emit("agents-updated", this.getAll());
    console.log(
      `[SubAgentYamlLoader] Reloaded: ${this.agents.size} YAML agents`,
    );
  }

  /** Stop the file watcher */
  destroy(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ===== Internal =====

  /** Load all .yaml/.yml files from agents directory */
  private loadAll(): void {
    const newAgents = new Map<string, AgentDefinition>();

    let files: string[];
    try {
      files = fs.readdirSync(this.agentsDir);
    } catch {
      return;
    }

    // Sort so deterministic order (last file with same name wins)
    files.sort().forEach((file) => {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) return;

      const filePath = path.join(this.agentsDir, file);
      try {
        const raw = yaml.load(fs.readFileSync(filePath, "utf-8")) as
          | YamlAgentConfig
          | undefined;
        if (!raw || !raw.name) {
          console.warn(
            `[SubAgentYamlLoader] Skipping ${file}: missing 'name' field`,
          );
          return;
        }

        const def = this.parseConfig(raw, file);
        if (def) {
          newAgents.set(def.agentType, def);
          console.log(
            `[SubAgentYamlLoader] Loaded: ${def.agentType} from ${file}`,
          );
        }
      } catch (err: any) {
        console.error(
          `[SubAgentYamlLoader] Failed to load ${file}: ${err.message}`,
        );
      }
    });

    this.agents = newAgents;
  }

  /** Parse a YAML config into an AgentDefinition */
  private parseConfig(
    raw: YamlAgentConfig,
    sourceFile: string,
  ): AgentDefinition | null {
    const agentType = raw.name.trim().toLowerCase().replace(/\s+/g, "-");

    if (!raw.description) {
      console.warn(
        `[SubAgentYamlLoader] ${sourceFile}: missing 'description'`,
      );
    }
    if (!raw.prompt) {
      console.warn(`[SubAgentYamlLoader] ${sourceFile}: missing 'prompt'`);
      return null;
    }

    const allowedTools = raw.tools?.allowed?.length
      ? raw.tools.allowed
      : undefined;
    const disallowedTools = raw.tools?.disallowed?.length
      ? raw.tools.disallowed
      : undefined;

    return {
      agentType,
      description: raw.description || `${raw.display_name || agentType} agent`,
      systemPrompt: raw.prompt,
      allowedTools,
      disallowedTools,
      model: raw.model,
      maxTurns: raw.max_turns,
      source: "custom",
    };
  }

  /** Start the file watcher for hot-reload */
  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.agentsDir, (eventType, filename) => {
        if (!filename) return;
        if (
          !filename.endsWith(".yaml") &&
          !filename.endsWith(".yml")
        ) {
          return;
        }

        // Debounce rapid changes (e.g. editor save → multiple events)
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.reloadAll();
        }, 300);
      });
    } catch (err: any) {
      console.warn(
        `[SubAgentYamlLoader] Failed to start watcher: ${err.message}`,
      );
    }
  }
}
