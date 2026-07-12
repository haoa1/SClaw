/**
 * SubAgent HTTP Routes
 *
 * RESTful API for managing subagents and their tasks:
 *   GET    /api/subagent/types         → List all available agent types (built-in + YAML)
 *   GET    /api/subagent/logs          → List subagent run log files (agentType, description, status)
 *   GET    /api/subagent/logs/:file    → Load full messages for a specific run file
 *   GET    /api/subagent/tasks         → List all tasks for a user
 *   GET    /api/subagent/tasks/:id     → Get specific task details
 *   POST   /api/subagent/tasks/:id/cancel → Cancel a running task
 *
 * Each subagent run saves the complete conversation history to:
 *   ~/.sclaw/subagent-logs/{agentType}/{YYYY-MM-DD}_{description}_{taskId}.json
 *
 * This allows full traceability of every subagent run.
 */

import { Router, Request, Response } from "express";
import { SubAgentManager } from "../agent/sub-agent-manager";
import { SubAgentTaskStatus } from "../agent/sub-agent-types";
import { validateSession } from "../auth";

export function createSubAgentRoutes(
  subAgentManager: SubAgentManager,
): Router {
  const router = Router();

  // ===== GET /api/subagent/types =====
  router.get("/types", (req: Request, res: Response) => {
    try {
      const types = subAgentManager.listAgentTypes();
      res.json({ types });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Extract userId from Authorization header */
  function getUserId(req: Request): string {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const session = validateSession(token);
    return session ? session.userId : "anonymous";
  }

  // ===== GET /api/subagent/logs =====
  router.get("/logs", (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const agentType = req.query.agentType as string | undefined;
      const description = req.query.description as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const runs = subAgentManager.listRuns({
        agentType,
        description,
        userId,
        status,
        limit,
        offset,
      });

      const total = subAgentManager.countRuns({
        agentType,
        description,
        userId,
        status,
      });

      res.json({ runs, total, limit, offset });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/subagent/logs/:file =====
  // Load full messages for a specific run file
  router.get("/logs/*", (req: Request, res: Response) => {
    try {
      // The file path is in req.params[0] (after /logs/)
      const filePath = req.params[0];
      if (!filePath) {
        res.status(400).json({ error: "File path required" });
        return;
      }

      const data = subAgentManager.loadRunMessages(filePath);
      if (!data) {
        res.status(404).json({ error: "Log file not found" });
        return;
      }

      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/subagent/tasks =====
  router.get("/tasks", (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const statusFilter = req.query.status as string | undefined;
      const limit = parseInt(req.query.limit as string) || 20;

      const status = statusFilter
        ? (statusFilter as SubAgentTaskStatus)
        : undefined;

      const tasks = subAgentManager.listTasks(userId, status, limit).map((t) => ({
        id: t.id,
        description: t.description,
        subagentType: t.subagentType,
        status: t.status,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        result: t.result ? t.result.slice(0, 500) : undefined,
        error: t.error,
        turnCount: t.turnCount,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
      }));

      res.json({ tasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== GET /api/subagent/tasks/:id =====
  router.get("/tasks/:id", (req: Request, res: Response) => {
    try {
      const task = subAgentManager.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      res.json({
        id: task.id,
        userId: task.userId,
        description: task.description,
        prompt: task.prompt,
        subagentType: task.subagentType,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        result: task.result,
        error: task.error,
        turnCount: task.turnCount,
        inputTokens: task.inputTokens,
        outputTokens: task.outputTokens,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== POST /api/subagent/tasks/:id/cancel =====
  router.post("/tasks/:id/cancel", (req: Request, res: Response) => {
    try {
      const task = subAgentManager.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const cancelled = subAgentManager.cancelTask(req.params.id);
      res.json({
        cancelled,
        status: cancelled ? "cancelled" : task.status,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
