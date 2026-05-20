/**
 * E2E tests — SClaw Backend
 *
 * Tests behavior through HTTP, not implementation.
 * Each test describes what the system does, not how.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../index";

// Shared across tests
let app: Awaited<ReturnType<typeof createApp>>;
let authToken: string;

beforeAll(async () => {
  // Create app with test-specific data dir
  app = await createApp({ dataDir: "/tmp/sclaw-test-data" });
}, 30_000);

// ============================================================================
// Tracer Bullet: Health check
// ============================================================================
describe("GET /api/health", () => {
  it("returns 200 with system status", async () => {
    const res = await request(app.app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body).toHaveProperty("pluginCount");
    expect(typeof res.body.pluginCount).toBe("number");
    expect(res.body).toHaveProperty("timestamp");
  });
});

// ============================================================================
// Auth flow: login → use token → logout
// ============================================================================
describe("POST /api/login", () => {
  it("rejects missing credentials", async () => {
    const res = await request(app.app).post("/api/login").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Username and password are required");
  });

  it("rejects wrong password", async () => {
    const res = await request(app.app)
      .post("/api/login")
      .send({ username: "admin", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("accepts valid credentials and returns a token", async () => {
    const res = await request(app.app)
      .post("/api/login")
      .send({ username: "admin", password: "admin123" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.user).toMatchObject({
      id: "1",
      username: "admin",
      role: "admin",
    });

    // Save for subsequent tests
    authToken = res.body.token;
  });
});

describe("GET /api/me", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app.app).get("/api/me");

    expect(res.status).toBe(401);
  });

  it("returns current user info with valid token", async () => {
    const res = await request(app.app)
      .get("/api/me")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: "1",
      username: "admin",
      role: "admin",
    });
  });
});

// ============================================================================
// Plugin system
// ============================================================================
describe("GET /api/plugins", () => {
  it("returns plugin list with strategies", async () => {
    const res = await request(app.app).get("/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("plugins");
    expect(Array.isArray(res.body.plugins)).toBe(true);
  });
});

// ============================================================================
// Strategies listing
// ============================================================================
describe("GET /api/strategies", () => {
  it("returns available strategies without auth", async () => {
    const res = await request(app.app).get("/api/strategies");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("strategies");
    expect(Array.isArray(res.body.strategies)).toBe(true);
  });
});

// ============================================================================
// Screen (stock screening — core business logic)
// ============================================================================
describe("POST /api/screen", () => {
  it("rejects empty strategies", async () => {
    const res = await request(app.app)
      .post("/api/screen")
      .send({ strategies: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("At least one strategy is required");
  });

  it("rejects missing strategies field", async () => {
    const res = await request(app.app)
      .post("/api/screen")
      .send({});

    expect(res.status).toBe(400);
  });

  it("gracefully handles non-existent strategy id (returns empty)", async () => {
    const res = await request(app.app)
      .post("/api/screen")
      .send({
        strategies: [{ id: "non-existent-strategy", params: {} }],
        market: "SH",
      });

    // System returns 200 with empty results for invalid strategies
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("results");
    expect(res.body.results).toEqual([]);
  });
});

// ============================================================================
// Auth: logout flow
// ============================================================================
describe("POST /api/logout", () => {
  it("invalidates the token after logout", async () => {
    // Login as a different user so we don't invalidate the shared authToken
    const loginRes = await request(app.app)
      .post("/api/login")
      .send({ username: "demo1", password: "demo123" });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    // Verify token works
    const meRes1 = await request(app.app)
      .get("/api/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes1.status).toBe(200);

    // Logout
    const logoutRes = await request(app.app)
      .post("/api/logout")
      .send({ token });
    expect(logoutRes.status).toBe(200);

    // Token should now be invalid
    const meRes2 = await request(app.app)
      .get("/api/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes2.status).toBe(401);
  });

  it("accepts logout without token gracefully", async () => {
    const res = await request(app.app).post("/api/logout").send({});
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// User config (auth required)
// ============================================================================
describe("GET /api/user/config", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app.app).get("/api/user/config");
    expect(res.status).toBe(401);
  });

  it("returns default config for authenticated user", async () => {
    const res = await request(app.app)
      .get("/api/user/config")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
  });
});

describe("POST /api/user/config", () => {
  it("saves and retrieves user config", async () => {
    const testConfig = {
      selectedStrategies: ["pe-value", "volume-surge"],
      preferences: { theme: "dark", refreshInterval: 30 },
    };

    // Save
    const saveRes = await request(app.app)
      .post("/api/user/config")
      .set("Authorization", `Bearer ${authToken}`)
      .send(testConfig);
    expect(saveRes.status).toBe(200);

    // Read back
    const getRes = await request(app.app)
      .get("/api/user/config")
      .set("Authorization", `Bearer ${authToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.selectedStrategies).toEqual(["pe-value", "volume-surge"]);
    expect(getRes.body.preferences.theme).toBe("dark");
  });
});

// ============================================================================
// User screens & logs (auth required)
// ============================================================================
describe("GET /api/user/screens", () => {
  it("requires auth", async () => {
    const res = await request(app.app).get("/api/user/screens");
    expect(res.status).toBe(401);
  });

  it("returns empty screens list for new user", async () => {
    const res = await request(app.app)
      .get("/api/user/screens")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("screens");
    expect(Array.isArray(res.body.screens)).toBe(true);
  });
});

describe("GET /api/user/logs", () => {
  it("requires auth", async () => {
    const res = await request(app.app).get("/api/user/logs");
    expect(res.status).toBe(401);
  });

  it("returns empty logs list for new user", async () => {
    const res = await request(app.app)
      .get("/api/user/logs")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("logs");
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});

// ============================================================================
// User screen detail (auth required)
// ============================================================================
describe("GET /api/user/screens/:id", () => {
  it("requires auth", async () => {
    const res = await request(app.app).get("/api/user/screens/non-existent");
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent screen", async () => {
    const res = await request(app.app)
      .get("/api/user/screens/non-existent-id")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Stock kline data (real API call)
// ============================================================================
describe("GET /api/stock/:code/kline", () => {
  it("rejects unknown stock code gracefully", async () => {
    const res = await request(app.app)
      .get("/api/stock/XXXXXX/kline?market=SH");

    // Either 200 (empty data) or 500 (external API error) — either is fine
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("code", "XXXXXX");
      expect(res.body).toHaveProperty("market", "SH");
    }
  }, 15_000);

  it("fetches kline for a known stock code", async () => {
    // 600519 = 贵州茅台, SH market
    const res = await request(app.app)
      .get("/api/stock/600519/kline?market=SH&days=5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("code", "600519");
    expect(res.body).toHaveProperty("market", "SH");
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
  }, 15_000);
});

// ============================================================================
// Screen with real strategy (actual stock screening)
// ============================================================================
describe("POST /api/screen — real strategy", () => {
  it("runs pe-value strategy against SH market", async () => {
    const res = await request(app.app)
      .post("/api/screen")
      .send({
        strategies: [{ id: "pe-value", params: { maxPe: 15, minPe: 0 } }],
        market: "SH",
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
  }, 30_000);
});

// ============================================================================
// Messages (chat history, auth required)
// ============================================================================
describe("GET /api/messages", () => {
  it("requires auth", async () => {
    const res = await request(app.app).get("/api/messages");
    expect(res.status).toBe(401);
  });

  it("returns empty message list for new user", async () => {
    const res = await request(app.app)
      .get("/api/messages")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("messages");
    expect(Array.isArray(res.body.messages)).toBe(true);
  });
});

describe("POST /api/messages", () => {
  it("requires auth", async () => {
    const res = await request(app.app).post("/api/messages").send({ messages: [] });
    expect(res.status).toBe(401);
  });

  it("rejects non-array body", async () => {
    const res = await request(app.app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ messages: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("saves and retrieves messages", async () => {
    const testMessages = [
      { role: "user", content: "筛选低PE股票" },
      { role: "assistant", content: "以下是一些低PE股票..." },
    ];

    // Save
    const saveRes = await request(app.app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ messages: testMessages });
    expect(saveRes.status).toBe(200);

    // Read back
    const getRes = await request(app.app)
      .get("/api/messages")
      .set("Authorization", `Bearer ${authToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(getRes.body.messages[0].role).toBe("user");
  });
});

// ============================================================================
// Chat SSE endpoint (non-streaming validation)
// ============================================================================
describe("POST /api/chat", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app.app)
      .post("/api/chat")
      .send({ message: "test" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Not logged in");
  });

  it("rejects empty message body", async () => {
    const res = await request(app.app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${authToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("消息不能为空");
  });

  it("streams SSE events with correct shapes (reasoning → token → done)", async () => {
    const res = await request(app.app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ message: "你好，简单介绍下自己" })
      .buffer(true)
      .parse((res, cb) => {
        // Capture raw text from SSE stream
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const body = res.body as string;

    // Parse SSE events: split by double newline, extract data: lines
    const blocks = body.split("\n\n").filter(Boolean);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const events: Record<string, any>[] = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6); // Remove "data: " prefix
          if (payload === "[DONE]") continue;
          try {
            events.push(JSON.parse(payload));
          } catch {
            // Malformed — fail the test
            expect.fail(`Invalid SSE JSON: ${payload}`);
          }
        }
      }
    }

    // Must have at least 2 events (reasoning/token + done)
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Last event should be "done"
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("done");
    expect(typeof lastEvent.content).toBe("string");
    expect(lastEvent.content.length).toBeGreaterThan(0);

    // Should have at least one reasoning or token event before done
    const hasReasoningOrToken = events.some(
      (e) => e.type === "reasoning" || e.type === "token"
    );
    expect(hasReasoningOrToken).toBe(true);

    // All event types should be valid
    const validTypes = new Set(["reasoning", "token", "tool_call", "turn", "tool_result", "done"]);
    for (const event of events) {
      expect(validTypes.has(event.type)).toBe(true);
      if (event.type === "tool_call") {
        expect(typeof event.id).toBe("string");
        expect(typeof event.name).toBe("string");
        expect(typeof event.arguments).toBe("string");
      }
    }
  }, 60_000);
});
