/**
 * Watch routes — SSE push for 盯盘 alerts + REST API for task management.
 *
 * GET /api/watch-stream  — SSE endpoint, pushes WatchAlert to authenticated clients.
 * GET /api/watch/tasks   — List the current user's watch tasks (for frontend display).
 */

import { Router, Request, Response } from 'express';
import { validateSession } from '../auth';
import { WatchEngine } from '../watch-engine';
import type { WatchAlert } from '../types';

export function createWatchStreamRoutes(watchEngine: WatchEngine): Router {
  const router = Router();

  /**
   * GET /api/watch/tasks — List watch tasks for the authenticated user.
   */
  router.get('/api/watch/tasks', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token as string);
    const session = validateSession(token);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const tasks = watchEngine.listTasks(session.userId);
    // Return a sanitized view: expose task config but strip internal runtime state
    const sanitized = tasks.map(t => ({
      id: t.id,
      label: t.label || null,
      enabled: t.enabled,
      interval: t.interval,
      watchTargets: t.watchTargets,
      conditions: t.conditions,
      cooldownSeconds: t.cooldownSeconds,
      alertChannels: t.alertChannels,
      email: t.email || null,
      createdAt: t.createdAt,
      lastRun: t.lastRun || null,
      lastAlert: t.lastAlert || null,
    }));
    res.json({ tasks: sanitized });
  });

  /**
   * GET /api/watch-stream
   *
   * SSE endpoint that pushes watch alerts to the authenticated user's browser.
   * Uses the same auth as /api/chat (Authorization: Bearer <token>).
   *
   * SSE events:
   *   data: { type: "alert", ...WatchAlert }
   *   data: { type: "status", activeTasks: number, totalTasks: number }
   *   data: { type: "keepalive", timestamp: number }
   *   data: [DONE]
   */
  router.get('/api/watch-stream', (req: Request, res: Response) => {
    // Auth
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token as string);
    const session = validateSession(token);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = session.userId;

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    // Initial connection OK
    res.write(':ok\n\n');

    // Send initial status
    const userTasks = watchEngine.listTasks(userId);
    res.write(`data: ${JSON.stringify({
      type: 'status',
      activeTasks: userTasks.filter(t => t.enabled).length,
      totalTasks: userTasks.length,
    })}\n\n`);

    // Alert handler — only forward alerts for this user
    const onAlert = (alert: WatchAlert) => {
      if (alert.userId === userId) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'alert', ...alert })}\n\n`);
        } catch {
          // Client may have disconnected
        }
      }
    };

    watchEngine.on('alert', onAlert);

    // Keepalive ping every 30s to prevent proxy timeouts
    const keepalive = setInterval(() => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'keepalive', timestamp: Date.now() })}\n\n`);
      } catch {
        clearInterval(keepalive);
      }
    }, 30_000);

    // Cleanup on disconnect
    req.on('close', () => {
      watchEngine.off('alert', onAlert);
      clearInterval(keepalive);
      res.end();
    });
  });

  return router;
}
