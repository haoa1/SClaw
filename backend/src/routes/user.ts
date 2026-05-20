/**
 * User routes — user config, screen history, operation logs.
 */

import { Router, Request, Response } from "express";
import { validateSession } from "../auth";
import { UserStore } from "../user-store";

function getUserId(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const session = validateSession(token);
  return session ? session.userId : null;
}

export function createUserRoutes(userStore: UserStore): Router {
  const router = Router();

  /** GET /api/user/config — get user preferences */
  router.get("/api/user/config", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    const config = userStore.getConfig(userId);
    res.json(config);
  });

  /** POST /api/user/config — save user preferences */
  router.post("/api/user/config", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    const { selectedStrategies, preferences } = req.body || {};
    userStore.saveConfig(userId, {
      selectedStrategies: selectedStrategies || [],
      preferences: preferences || {},
    });
    res.json({ status: "ok" });
  });

  /** GET /api/user/screens — get screen history */
  router.get("/api/user/screens", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const screens = userStore.getScreens(userId, limit);
    res.json({ screens });
  });

  /** GET /api/user/screens/:id — get specific screen record */
  router.get("/api/user/screens/:id", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    const screen = userStore.getScreenById(userId, req.params.id);
    if (!screen) {
      res.status(404).json({ error: "记录未找到" });
      return;
    }
    res.json(screen);
  });

  /** GET /api/user/logs — get operation logs */
  router.get("/api/user/logs", (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "未登录" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 100;
    const logs = userStore.getLogs(userId, limit);
    res.json({ logs });
  });

  return router;
}
