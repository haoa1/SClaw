/**
 * Skill Tools — list_skills, load_skill, unload_skill
 *
 * Skills are Markdown instruction files in ~/.sclaw/skills/<name>/SKILL.md.
 * Loading a skill injects its content into the agent's system prompt,
 * teaching the AI new capabilities on the fly.
 */

import { ToolRegistry, Tool } from "./registry";
import { SkillManager } from "../skill-manager";
import { PerUserAgentManager } from "../agent/manager";

export function registerSkillTools(
  registry: ToolRegistry,
  skillManager: SkillManager,
  agentManager: PerUserAgentManager,
  getUserId: () => string,
): void {
  // ---- list_skills ----
  registry.register(
    new Tool(
      "list_skills",
      "List all available skills that can be loaded. Skills are reusable Markdown instruction files in ~/.sclaw/skills/.",
      [],
      async () => {
        const skills = skillManager.listSkills();
        return JSON.stringify(skills.map((s) => ({
          name: s.name,
          description: s.description,
          categories: s.categories || [],
        })));
      },
    ),
  );

  // ---- load_skill ----
  registry.register(
    new Tool(
      "load_skill",
      "Load a skill by name. The skill's instructions will be injected into the system prompt, adding new capabilities. Use list_skills first to see available skills.",
      [
        {
          name: "skill_name",
          type: "string",
          description: "Name of the skill to load.",
        },
      ],
      async (params) => {
        const skillName = params.skill_name as string;
        if (!skillName) return "Missing required parameter: skill_name.";

        if (!skillManager.hasSkill(skillName)) {
          return `Skill '${skillName}' not found. Use list_skills to see available skills.`;
        }

        const { content } = skillManager.readSkill(skillName);
        if (!content || content === "") {
          return `Skill '${skillName}' has no content.`;
        }

        // Load into the current user's agent
        try {
          const userId = getUserId();
          if (!userId) return "No user context available.";
          const agent = agentManager.getAgent(userId);
          return agent.loadSkill(skillName, content);
        } catch (e) {
          return `Error loading skill: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    ),
  );

  // ---- unload_skill ----
  registry.register(
    new Tool(
      "unload_skill",
      "Unload a previously loaded skill by name, removing its instructions from the system prompt.",
      [
        {
          name: "skill_name",
          type: "string",
          description: "Name of the skill to unload.",
        },
      ],
      async (params) => {
        const skillName = params.skill_name as string;
        if (!skillName) return "Missing required parameter: skill_name.";

        try {
          const userId = getUserId();
          if (!userId) return "No user context available.";
          const agent = agentManager.getAgent(userId);
          return agent.unloadSkill(skillName);
        } catch (e) {
          return `Error unloading skill: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    ),
  );
}
