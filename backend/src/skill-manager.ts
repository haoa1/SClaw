/**
 * Skill Manager — scans, reads, and lists skills from disk.
 *
 * Skills are Markdown files in ~/.sclaw/skills/<name>/SKILL.md
 * with YAML frontmatter for metadata.
 *
 * Structure:
 *   ~/.sclaw/skills/
 *     fund-tracker/
 *       SKILL.md
 *     backtest-view/
 *       SKILL.md
 *     ...
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
  categories?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export class SkillManager {
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || path.join(os.homedir(), ".sclaw", "skills");
    // Ensure directory exists
    try {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  /** List all available skills (scans directories for SKILL.md). */
  listSkills(): SkillMeta[] {
    const results: SkillMeta[] = [];
    try {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillPath)) continue;
        const meta = this.parseSkillMeta(skillPath);
        if (meta) results.push(meta);
      }
    } catch {
      // skills dir doesn't exist yet — empty list
    }
    return results;
  }

  /** Read the full content of a skill (frontmatter + body). */
  readSkill(name: string): { meta: SkillMeta | null; content: string } {
    const skillPath = path.join(this.skillsDir, name, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      return { meta: null, content: `Skill '${name}' not found.` };
    }
    const raw = fs.readFileSync(skillPath, "utf-8");
    const meta = this.parseSkillMeta(skillPath);
    const body = this.stripFrontmatter(raw);
    return { meta, content: body };
  }

  /** Check if a skill exists. */
  hasSkill(name: string): boolean {
    return fs.existsSync(path.join(this.skillsDir, name, "SKILL.md"));
  }

  // ===== Internal =====

  private parseSkillMeta(skillPath: string): SkillMeta | null {
    try {
      const raw = fs.readFileSync(skillPath, "utf-8");
      const lines = raw.split("\n");
      if (lines.length < 2 || lines[0].trim() !== "---") return null;

      // Find closing ---
      let endIdx = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
          endIdx = i;
          break;
        }
      }
      if (endIdx < 0) return null;

      const yamlBlock = lines.slice(1, endIdx).join("\n");
      const meta: SkillMeta = {
        name: path.basename(path.dirname(skillPath)),
        description: "",
        filePath: skillPath,
      };

      // Simple YAML key: value parser (no nesting, no arrays-of-objects)
      for (const line of yamlBlock.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx < 0) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let value: unknown = trimmed.slice(colonIdx + 1).trim();

        // Strip quotes
        if (typeof value === "string") {
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
        }

        // Handle array values: [item1, item2, ...]
        if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
          value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        }

        meta[key] = value as string | string[];
      }

      return meta;
    } catch {
      return null;
    }
  }

  private stripFrontmatter(raw: string): string {
    const lines = raw.split("\n");
    if (lines.length < 2 || lines[0].trim() !== "---") return raw;
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx < 0) return raw;
    return lines.slice(endIdx + 1).join("\n").trim();
  }
}
