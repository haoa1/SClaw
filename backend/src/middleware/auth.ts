/**
 * Unified authentication middleware for Express.
 *
 * Extracts the token from the Authorization header (or query param for SSE),
 * validates it, and attaches the user info to `req.user`.
 *
 * Usage:
 *   import { requireAuth, optionalAuth } from "./middleware/auth";
 *   router.get("/api/protected", requireAuth, handler);
 *   router.get("/api/optional", optionalAuth, handler); // req.user may be null
 */

import { Request, Response, NextFunction } from "express";
import { validateSession } from "../auth";

// Extend Express Request type to include user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        username: string;
        displayName: string;
        role: string;
      } | null;
    }
  }
}

/**
 * Extract token from request: Authorization header > query param (for SSE).
 */
function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Fallback: query param (used by SSE / watch-stream)
  if (typeof req.query.token === "string") {
    return req.query.token;
  }
  return undefined;
}

/**
 * Middleware: requires a valid session.
 * Returns 401 if not authenticated.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  req.user = {
    userId: session.userId,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
  };
  next();
}

/**
 * Middleware: optional authentication.
 * Attaches user info if a valid session exists, otherwise sets req.user = null.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const session = validateSession(token);
  if (session) {
    req.user = {
      userId: session.userId,
      username: session.username,
      displayName: session.displayName,
      role: session.role,
    };
  } else {
    req.user = null;
  }
  next();
}

/**
 * Middleware: requires admin role.
 * Must be used AFTER requireAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ error: "Forbidden: admin access required" });
    return;
  }
  next();
}
