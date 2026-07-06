/**
 * Trade routes — proxy to Garuda Trade Bridge (local Mac:5001).
 *
 * Architecture:
 *   Sclaw (cloud or local:3001) —HTTP→ Garuda HTTP server (local Mac:5001)
 *                                        ↓
 *                              TradeBridge → Accessibility API → 东方财富.app
 *
 * Garuda's Trade Bridge API:
 *   GET  /api/trade/account    — 账户信息
 *   GET  /api/trade/positions  — 持仓列表
 *   POST /api/trade/buy        — 买入
 *   POST /api/trade/sell       — 卖出
 *   POST /api/trade/activate   — 激活窗口
 *
 * Environment:
 *   GARUDA_TRADE_HOST — default: 127.0.0.1
 *   GARUDA_TRADE_PORT — default: 5001
 *   GARUDA_TRADE_TIMEOUT — default: 15000ms
 */

import { Router, Request, Response } from "express";
import * as http from "http";

const TRADE_HOST = process.env.GARUDA_TRADE_HOST || "127.0.0.1";
const TRADE_PORT = parseInt(process.env.GARUDA_TRADE_PORT || "5001", 10);
const TRADE_TIMEOUT = parseInt(process.env.GARUDA_TRADE_TIMEOUT || "15000", 10);

/**
 * Proxy an HTTP request to Garuda Trade Bridge.
 */
function proxyToGaruda(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: TRADE_HOST,
      port: TRADE_PORT,
      path,
      method,
      timeout: TRADE_TIMEOUT,
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode || 500,
            data: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode || 500, data });
        }
      });
    });

    req.on("error", (err) => {
      reject(
        new Error(
          `Garuda Trade Bridge unreachable (${TRADE_HOST}:${TRADE_PORT}): ${err.message}`,
        ),
      );
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Garuda Trade Bridge timed out"));
    });

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

export function createTradeRoutes(): Router {
  const router = Router();

  /**
   * GET /api/trade/account — 账户信息
   */
  router.get("/api/trade/account", async (_req: Request, res: Response) => {
    try {
      const result = await proxyToGaruda("GET", "/api/trade/account");
      res.status(result.status).json(result.data);
    } catch (err: any) {
      res.status(503).json({
        status: "error",
        error: err.message || "Trade Bridge unavailable",
      });
    }
  });

  /**
   * GET /api/trade/positions — 持仓列表
   */
  router.get("/api/trade/positions", async (_req: Request, res: Response) => {
    try {
      const result = await proxyToGaruda("GET", "/api/trade/positions");
      res.status(result.status).json(result.data);
    } catch (err: any) {
      res.status(503).json({
        status: "error",
        error: err.message || "Trade Bridge unavailable",
      });
    }
  });

  /**
   * POST /api/trade/buy — 买入
   * Body: { code: string, price: number, qty: number }
   */
  router.post("/api/trade/buy", async (req: Request, res: Response) => {
    try {
      const { code, price, qty } = req.body;
      if (!code || !price || !qty) {
        return res.status(400).json({
          status: "error",
          error: "Missing required fields: code, price, qty",
        });
      }
      const result = await proxyToGaruda("POST", "/api/trade/buy", {
        code,
        price,
        qty,
      });
      res.status(result.status).json(result.data);
    } catch (err: any) {
      res.status(503).json({
        status: "error",
        error: err.message || "Trade Bridge unavailable",
      });
    }
  });

  /**
   * POST /api/trade/sell — 卖出
   * Body: { code: string, price: number, qty: number }
   */
  router.post("/api/trade/sell", async (req: Request, res: Response) => {
    try {
      const { code, price, qty } = req.body;
      if (!code || !price || !qty) {
        return res.status(400).json({
          status: "error",
          error: "Missing required fields: code, price, qty",
        });
      }
      const result = await proxyToGaruda("POST", "/api/trade/sell", {
        code,
        price,
        qty,
      });
      res.status(result.status).json(result.data);
    } catch (err: any) {
      res.status(503).json({
        status: "error",
        error: err.message || "Trade Bridge unavailable",
      });
    }
  });

  /**
   * GET /api/trade/health — 检查 Trade Bridge 连接状态
   */
  router.get("/api/trade/health", async (_req: Request, res: Response) => {
    try {
      await proxyToGaruda("GET", "/api/trade/account");
      res.json({ ok: true, status: "connected", host: TRADE_HOST, port: TRADE_PORT });
    } catch {
      res.json({ ok: false, status: "disconnected", host: TRADE_HOST, port: TRADE_PORT });
    }
  });

  return router;
}
