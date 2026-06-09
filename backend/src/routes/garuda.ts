/**
 * Garuda admin routes — send commands to Garuda via SSH reverse tunnel.
 *
 * Architecture:
 *   Browser → POST /api/admin/garuda/exec → SClaw backend
 *     → net.Socket → localhost:19999 (SSH reverse tunnel)
 *     → Mac tunnel → Garuda
 *
 * The tunnel (port 19999) must be maintained by autossh on the server.
 * If tunnel is down, the request will fail with a clear error.
 */

import { Router, Request, Response } from "express";
import * as net from "net";

const GARUDA_TUNNEL_HOST = process.env.GARUDA_TUNNEL_HOST || "127.0.0.1";
const GARUDA_TUNNEL_PORT = parseInt(process.env.GARUDA_TUNNEL_PORT || "19998", 10);
const GARUDA_TIMEOUT = parseInt(process.env.GARUDA_TIMEOUT || "30000", 10); // 30s default

/**
 * Send a command to Garuda via the tunnel and wait for the response.
 * Uses a simple line-based protocol: send the command, read until the
 * command echo + response lines appear, or until a timeout.
 */
function execOnGaruda(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      reject(new Error(`Garuda exec timed out after ${GARUDA_TIMEOUT}ms`));
    }, GARUDA_TIMEOUT);

    socket.connect(GARUDA_TUNNEL_PORT, GARUDA_TUNNEL_HOST, () => {
      // Send the command
      socket.write(command + "\n");
    });

    socket.on("data", (data: Buffer) => {
      if (timedOut) return;
      buffer += data.toString("utf-8");

      // Check if response is complete — look for common prompt patterns
      // Garuda's prompt could be "> ", "$ ", "garuda> " etc.
      // Also stop after a reasonable amount of data
      const promptPatterns = [/>\s*$/, /\$\s*$/, /garuda[>#]\s*$/i];
      const hasPrompt = promptPatterns.some(p => p.test(buffer));

      if (hasPrompt || buffer.length > 65536) {
        clearTimeout(timer);
        socket.end();
        resolve(buffer);
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error(`Garuda tunnel connection failed: ${err.message}. Is autossh running?`));
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (!timedOut && !buffer) {
        reject(new Error("Garuda tunnel closed without data"));
      } else if (!timedOut) {
        resolve(buffer);
      }
    });
  });
}

export function createGarudaRoutes(): Router {
  const router = Router();

  /**
   * POST /api/admin/garuda/exec
   * Body: { command: string }
   * Response: { ok: true, output: string }
   *
   * Sends a command to Garuda and returns the output.
   * The command is executed by sending it as a line of text via the TCP tunnel.
   */
  router.post("/api/admin/garuda/exec", async (req: Request, res: Response) => {
    try {
      const { command } = req.body;
      if (!command || typeof command !== "string") {
        return res.status(400).json({ error: "Missing or invalid 'command' field" });
      }

      const output = await execOnGaruda(command);
      res.json({ ok: true, output });
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Garuda unavailable" });
    }
  });

  /**
   * GET /api/admin/garuda/health
   * Quick check if the tunnel is alive by sending a simple command.
   */
  router.get("/api/admin/garuda/health", async (_req: Request, res: Response) => {
    try {
      await execOnGaruda("echo GARUDA_ALIVE");
      res.json({ ok: true, status: "connected" });
    } catch (err: any) {
      res.json({ ok: false, status: "disconnected", error: err.message });
    }
  });

  /**
   * GET /api/admin/garuda/tasks
   * Convenience: list current tasks from Garuda.
   * Sends "list tasks" and returns the output.
   */
  router.get("/api/admin/garuda/tasks", async (_req: Request, res: Response) => {
    try {
      const output = await execOnGaruda("list tasks");
      res.json({ ok: true, output });
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Garuda unavailable" });
    }
  });

  return router;
}
