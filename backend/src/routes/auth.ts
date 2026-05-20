/**
 * Auth routes — login/logout/session management.
 * Uses hardcoded user list from src/auth.ts.
 */

import { Router, Request, Response } from "express";
import { login, logout, validateSession } from "../auth";

export function createAuthRoutes(): Router {
  const router = Router();

  /** POST /api/login */
  router.post("/api/login", (req: Request, res: Response) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }
    const session = login(username, password);
    if (!session) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    res.json({
      token: session.token,
      user: {
        id: session.userId,
        username: session.username,
        displayName: session.displayName,
        role: session.role,
      },
    });
  });

  /** POST /api/logout */
  router.post("/api/logout", (req: Request, res: Response) => {
    const { token } = req.body || {};
    if (token) logout(token);
    res.json({ status: "ok" });
  });

  /** GET /api/me — get current user info */
  router.get("/api/me", (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
    const session = validateSession(token);
    if (!session) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    res.json({
      user: {
        id: session.userId,
        username: session.username,
        displayName: session.displayName,
        role: session.role,
      },
    });
  });

  return router;
}
