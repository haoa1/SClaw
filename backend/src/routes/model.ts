/**
 * Model routes — get/set AI model for the current user.
 */

import { Router, Request, Response } from "express";
import { validateSession } from "../auth";
import { PerUserAgentManager } from "../agent/manager";

function getUserId(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const session = validateSession(token);
  return session ? session.userId : null;
}

export function createModelRoutes(agentManager: PerUserAgentManager): Router {
  const router = Router();

  /** GET /api/model — get current model for the user */
  router.get("/api/model", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }

    const agent = agentManager.getAgent(userId);
    const model = agent.getModel();

    res.json({ model });
  });

  /** POST /api/model — switch model for the user */
  router.post("/api/model", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }

    const { model } = req.body || {};
    if (!model) {
      res.status(400).json({ success: false, message: "Model name is required" });
      return;
    }

    const result = agentManager.switchModel(userId, model);
    res.json(result);
  });

  /** GET /api/model/list — list available models */
  router.get("/api/model/list", (_req: Request, res: Response) => {
    res.json({
      models: [
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fast, lightweight model for quick responses" },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Full-powered model for complex analysis" },
      ],
    });
  });

  return router;
}
