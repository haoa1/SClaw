/**
 * Skill Manager — scans, reads, and lists skills from disk.
 *
 * Runtime skills live in ~/.sclaw/skills/<name>/SKILL.md
 * with YAML frontmatter for metadata.
 *
 * Built-in skills live in <repo>/backend/builtin-skills/<name>/
 * and are auto-bootstrapped to ~/.sclaw/skills/ at startup
 * (without overwriting existing files).
 *
 * Structure:
 *   backend/builtin-skills/          ← source of truth in repo
 *     fund-tracker/
 *       SKILL.md
 *       scripts/
 *         fund_api.js
 *
 *   ~/.sclaw/skills/                 ← runtime copy (auto-bootstrapped)
 *     fund-tracker/
 *       SKILL.md
 *       scripts/
 *         fund_api.js
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

  /**
   * @param skillsDir   Runtime skills directory (default: ~/.sclaw/skills)
   * @param builtinDir  Built-in skills source (default: <this file>/../../builtin-skills)
   */
  constructor(skillsDir?: string, builtinDir?: string) {
    this.skillsDir = skillsDir || path.join(os.homedir(), ".sclaw", "skills");

    // 1. Ensure runtime directory exists
    this.ensureDir(this.skillsDir);

    // 2. Bootstrap built-in skills to runtime directory
    // Try relative to src/ or dist/ — both resolve to backend/builtin-skills/
    const srcDir = builtinDir || path.resolve(__dirname, "..", "builtin-skills");
    if (fs.existsSync(srcDir)) {
      this.bootstrapBuiltinSkills(srcDir, this.skillsDir);
    }
  }

  /** Bootstrap built-in skills from repo to runtime dir (no overwrite). */
  private bootstrapBuiltinSkills(src: string, dest: string): void {
    try {
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const srcSkillDir = path.join(src, entry.name);
        const destSkillDir = path.join(dest, entry.name);

        // Don't overwrite if skill already exists at destination
        const destSkillFile = path.join(destSkillDir, "SKILL.md");
        if (fs.existsSync(destSkillFile)) continue;

        // Copy entire skill directory
        this.copyDir(srcSkillDir, destSkillDir);
        console.log(`  [SKILL] Bootstrap '${entry.name}' → ${destSkillDir}`);
      }
    } catch {
      // builtin dir not available — skip
    }
  }

  /** Recursively copy a directory (with mkdirp). */
  private copyDir(src: string, dest: string): void {
    this.ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
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
