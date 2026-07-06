/**
 * Trade Tool — account|positions|buy|sell
 *
 * Calls Garuda Trade Bridge (localhost:5001) via HTTP.
 * Garuda → macOS Accessibility API → 东方财富.app
 *
 * Available only when Garuda is running locally on port 5001.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import * as http from "http";

const TRADE_HOST = process.env.GARUDA_TRADE_HOST || "127.0.0.1";
const TRADE_PORT = parseInt(process.env.GARUDA_TRADE_PORT || "5001", 10);
const TRADE_TIMEOUT = parseInt(process.env.GARUDA_TRADE_TIMEOUT || "15000", 10);

/**
 * Direct HTTP call to Garuda Trade Bridge (no Express router dependency).
 */
function callGaruda(
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
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 500, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 500, data });
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Garuda Trade Bridge (${TRADE_HOST}:${TRADE_PORT}) unreachable: ${err.message}. Is Garuda running?`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Garuda Trade Bridge timed out"));
    });

    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ===== Tool definition =====

const tradeParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: "操作类型: 'account' 查询账户, 'positions' 查询持仓, 'buy' 买入, 'sell' 卖出",
    required: true,
  },
  {
    name: "code",
    type: "string",
    description: "股票代码（buy/sell 时需要）",
    required: false,
  },
  {
    name: "price",
    type: "number",
    description: "价格（buy/sell 时需要）",
    required: false,
  },
  {
    name: "qty",
    type: "integer",
    description: "数量/股数（buy/sell 时需要）",
    required: false,
  },
];

const tradeHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase();

  switch (subCmd) {
    case "account": {
      const result = await callGaruda("GET", "/api/trade/account");
      const d = result.data as any;
      if (d?.status === "ok" && d?.data) {
        const info = d.data;
        const lines: string[] = [];
        for (const [key, val] of Object.entries(info)) {
          if (key === "_raw_values_count") continue;
          const label = typeof val === "number" ? val.toFixed(2) : String(val);
          lines.push(`  ${key}: ${label}`);
        }
        return `📋 账户信息\n${lines.join("\n")}`;
      }
      return `❌ 读取账户失败: ${JSON.stringify(d)}`;
    }

    case "positions": {
      const result = await callGaruda("GET", "/api/trade/positions");
      const d = result.data as any;
      if (d?.status === "ok" && Array.isArray(d?.data)) {
        if (d.data.length === 0) return "📭 暂无持仓";
        const lines = d.data.map((p: any, i: number) => {
          return `${i + 1}. ${p.name} (${p.code}) — ${p.qty}股, 现价¥${p.current_price?.toFixed(2) || "?"}`;
        });
        return `📊 持仓列表 (${d.data.length}只)\n${lines.join("\n")}`;
      }
      return `❌ 读取持仓失败: ${JSON.stringify(d)}`;
    }

    case "buy": {
      const code = (args.code as string || "").trim();
      const price = args.price as number;
      const qty = args.qty as number;
      if (!code || !price || !qty) {
        return "❌ 买入需要 code, price, qty 三个参数";
      }
      const result = await callGaruda("POST", "/api/trade/buy", { code, price, qty });
      const d = result.data as any;
      return `🟢 买入委托: ${code} ${qty}股 @ ¥${price}\n${JSON.stringify(d)}`;
    }

    case "sell": {
      const code = (args.code as string || "").trim();
      const price = args.price as number;
      const qty = args.qty as number;
      if (!code || !price || !qty) {
        return "❌ 卖出需要 code, price, qty 三个参数";
      }
      const result = await callGaruda("POST", "/api/trade/sell", { code, price, qty });
      const d = result.data as any;
      return `🔴 卖出委托: ${code} ${qty}股 @ ¥${price}\n${JSON.stringify(d)}`;
    }

    default:
      return `❌ 未知 sub_cmd: "${subCmd}"，可用: account, positions, buy, sell`;
  }
};

const tradeTool = new Tool(
  "trade",
  `东方财富交易 — 查账户、查持仓、买入、卖出。通过 Garuda Trade Bridge (本地:5001) 操作。

用法:
  trade(sub_cmd="account")                  — 查账户总资产/可用/市值
  trade(sub_cmd="positions")                — 查持仓列表
  trade(sub_cmd="buy", code="600519", price=150.0, qty=100)   — 买入
  trade(sub_cmd="sell", code="600519", price=155.0, qty=100)  — 卖出

注意:
  - 仅当本地 Garuda (port 5001) 运行且连接东方财富时可用
  - buy/sell 需要用户确认，不会自动提交`,
  tradeParams,
  tradeHandler,
);

export function registerTradeTools(registry: ToolRegistry): void {
  registry.register(tradeTool);
}
