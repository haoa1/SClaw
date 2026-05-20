/**
 * Per-request context for tools that need to know the current user.
 * Set before agent.run() and read from inside tool executions.
 */

let _currentUserId: string | null = null;

export function setCurrentUserId(userId: string | null): void {
  _currentUserId = userId;
}

export function getCurrentUserId(): string | null {
  return _currentUserId;
}
