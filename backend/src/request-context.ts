/**
 * Per-request context using AsyncLocalStorage.
 * Each HTTP request gets its own isolated storage context.
 * Tools read the current user ID from this context instead of a shared global.
 *
 * Usage:
 *   import { runWithUserId, getCurrentUserId } from "./request-context";
 *   // In route handler:
 *   app.post("/api/chat", (req, res) => {
 *     runWithUserId(userId, async () => {
 *       await agent.run(...);
 *     });
 *   });
 *   // In tool handler:
 *   const userId = getCurrentUserId();
 */

import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage<{ userId: string }>();

/**
 * Run a function (typically an HTTP request handler) within a user-scoped context.
 * Any tools, nested calls, or async operations within `fn` can retrieve the userId
 * via getCurrentUserId() — even across await boundaries.
 */
export function runWithUserId<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ userId }, fn);
}

/**
 * Get the current user ID from the request context.
 * Returns null if called outside a runWithUserId() context (shouldn't happen in normal operation).
 */
export function getCurrentUserId(): string | null {
  const store = storage.getStore();
  return store?.userId ?? null;
}
