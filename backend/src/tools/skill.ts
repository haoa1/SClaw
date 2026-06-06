/**
 * Unified Skill Tool — skill(list|load|unload)
 *
 * Replaces: list_skills, load_skill, unload_skill
 * All wrapped in a single tool with sub_cmd dispatch.
 *
 * Note: This tool needs SkillManager, PerUserAgentManager, and getUserId at registration time.
 * See registerSkillTool in index.ts for wiring.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { SkillManager } from "../skill-manager";
import { PerUserAgentManager } from "../agent/manager";

// ===== Tool registration (needs dependencies) =====

export function registerSkillTool(
  registry: ToolRegistry,
  skillManager: SkillManager,
  agentManager: PerUserAgentManager,
  getUserId: () => string,
): void {
  const skillHandler = async (args: Record<string, unknown>): Promise<string> => {
    const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
    if (!subCmd) return "❌ Error: sub_cmd is required. Options: list, load, unload";

    switch (subCmd) {
      case "list": {
        const skills = skillManager.listSkills();
        return JSON.stringify(skills.map((s) => ({
          name: s.name,
          description: s.description,
          categories: s.categories || [],
        })));
      }

      case "load": {
        const skillName = args.skill_name as string;
        if (!skillName) return "Missing required parameter: skill_name.";

        if (!skillManager.hasSkill(skillName)) {
          return `Skill '${skillName}' not found. Use skill(sub_cmd="list") to see available skills.`;
        }

        const { content } = skillManager.readSkill(skillName);
        if (!content || content === "") return `Skill '${skillName}' has no content.`;

        try {
          const userId = getUserId();
          if (!userId) return "No user context available.";
          const agent = agentManager.getAgent(userId);
          return agent.loadSkill(skillName, content);
        } catch (e) {
          return `Error loading skill: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      case "unload": {
        const skillName = args.skill_name as string;
        if (!skillName) return "Missing required parameter: skill_name.";

        try {
          const userId = getUserId();
          if (!userId) return "No user context available.";
          const agent = agentManager.getAgent(userId);
          return agent.unloadSkill(skillName);
        } catch (e) {
          return `Error unloading skill: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      default:
        return `❌ Unknown sub_cmd: "${subCmd}". Options: list, load, unload`;
    }
  };

  const skillParams: ToolParamDef[] = [
    {
      name: "sub_cmd",
      type: "string",
      description: `Sub-command: list / load / unload

list — List all available skills
load(skill_name) — Load a skill, injects instructions into system prompt
unload(skill_name) — Unload a previously loaded skill
`,
    },
    { name: "skill_name", type: "string", description: "Name of the skill — for sub_cmd=load or unload", required: false },
  ];

  registry.register(new Tool(
    "skill",
    `Unified skill management tool. Use sub_cmd to choose operation.

list → List all available skills
load(skill_name) → Load a skill (injects instructions into system prompt)
unload(skill_name) → Unload a previously loaded skill

Skills are Markdown instruction files in ~/.sclaw/skills/<name>/SKILL.md.
Use list first to see available skills, then load to activate.

Examples:
  skill(sub_cmd="list")
  skill(sub_cmd="load", skill_name="fund-tracker")
  skill(sub_cmd="unload", skill_name="fund-tracker")
`,
    skillParams,
    skillHandler,
  ));
}
