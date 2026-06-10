/**
 * Garuda admin routes - send commands to Garuda via JSON-lines over TCP.
 *
 * Architecture (new - UDS + socat bridge):
 *   Browser -> POST /api/admin/garuda/exec -> SClaw backend
 *     -> net.Socket -> localhost:19998 (SSH reverse tunnel)
 *     -> Mac socat -> UNIX-CONNECT:/tmp/garuda.sock
 *     -> Garuda UDS server (JSON-lines protocol)
 *
 * Protocol (JSON-lines, one JSON per line):
 *   -> {"type":"msg","content":"..."}        send user message
 *   <- {"type":"done","response":"..."}      AI reply
 *   -> {"type":"ping"}
 *   <- {"type":"pong"}
 *
 * The tunnel (port 19998) must be maintained by autossh on the server.
 * If tunnel is down, the request will fail with a clear error.
 */

import { Router, Request, Response } from "express";
import * as net from "net";

const GARUDA_TUNNEL_HOST = process.env.GARUDA_TUNNEL_HOST || "127.0.0.1";
const GARUDA_TUNNEL_PORT = parseInt(process.env.GARUDA_TUNNEL_PORT || "19998", 10);
const GARUDA_TIMEOUT = parseInt(process.env.GARUDA_TIMEOUT || "60000", 10);

/**
 * Send a JSON-lines message to Garuda via the tunnel and wait for a response.
 */
function execOnGaruda(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      reject(new Error("Garuda exec timed out after " + GARUDA_TIMEOUT + "ms"));
    }, GARUDA_TIMEOUT);

    socket.connect(GARUDA_TUNNEL_PORT, GARUDA_TUNNEL_HOST, () => {
      const msg = JSON.stringify({ type: "msg", content: command });
      socket.write(msg + "\n");
    });

    socket.on("data", (data: Buffer) => {
      if (timedOut) return;
      buffer += data.toString("utf-8");

      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);

        try {
          const resp = JSON.parse(line);
          if (resp.type === "done") {
            clearTimeout(timer);
            socket.end();
            resolve(resp.response || "");
          } else if (resp.type === "error") {
            clearTimeout(timer);
            socket.end();
            reject(new Error(resp.content || "Unknown error from Garuda"));
          }
        } catch {
          // Not valid JSON yet - keep reading
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error("Garuda tunnel connection failed: " + err.message + ". Is autossh running?"));
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (!timedOut && !buffer) {
        reject(new Error("Garuda tunnel closed without data"));
      } else if (!timedOut) {
        reject(new Error("Garuda closed unexpectedly. Raw: " + buffer.substring(0, 200)));
      }
    });
  });
}

/**
 * Ping Garuda via JSON-lines protocol.
 */
function pingGaruda(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      resolve(false);
    }, 10000);

    socket.connect(GARUDA_TUNNEL_PORT, GARUDA_TUNNEL_HOST, () => {
      socket.write(JSON.stringify({ type: "ping" }) + "\n");
    });

    let buffer = "";
    socket.on("data", (data: Buffer) => {
      if (timedOut) return;
      buffer += data.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = buffer.substring(0, newlineIdx).trim();
        try {
          const resp = JSON.parse(line);
          if (resp.type === "pong") {
            clearTimeout(timer);
            socket.end();
            resolve(true);
          }
        } catch {
          // keep waiting
        }
      }
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (!timedOut) resolve(false);
    });
  });
}

export function createGarudaRoutes(): Router {
  const router = Router();

  /**
   * POST /api/admin/garuda/exec
   * Body: { command: string }
   * Response: { ok: true, output: string }
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
   */
  router.get("/api/admin/garuda/health", async (_req: Request, res: Response) => {
    try {
      const alive = await pingGaruda();
      if (alive) {
        res.json({ ok: true, status: "connected" });
      } else {
        res.json({ ok: false, status: "disconnected", error: "No pong response" });
      }
    } catch (err: any) {
      res.json({ ok: false, status: "disconnected", error: err.message });
    }
  });

  /**
   * GET /api/admin/garuda/tasks
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
