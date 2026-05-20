/**
 * Simple session-based auth with hardcoded user list.
 * Users can only be added/removed by editing this file.
 */

import * as crypto from "crypto";

// ===== Hardcoded Users =====
// Edit this array to add/remove users. Passwords should be hashed in production.
export interface AuthUser {
  id: string;
  username: string;
  password: string;        // plaintext for simplicity — hash in production
  displayName: string;
  role: "admin" | "user";
}

const USERS: AuthUser[] = [
  { id: "1", username: "admin", password: "admin123", displayName: "管理员", role: "admin" },
  { id: "2", username: "jack",  password: "123456",   displayName: "Jack", role: "user" },
  { id: "3", username: "siwei", password: "siwei123", displayName: "Siwei", role: "user" },
];

// ===== Session Management =====
export interface Session {
  token: string;
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  createdAt: number;
}

const sessions = new Map<string, Session>();
const userSessions = new Map<string, string>(); // userId -> token
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function login(username: string, password: string): Session | null {
  const user = USERS.find(u => u.username === username && u.password === password);
  if (!user) return null;

  // Reuse existing session if valid
  const existingToken = userSessions.get(user.id);
  if (existingToken) {
    const existing = sessions.get(existingToken);
    if (existing && Date.now() - existing.createdAt < SESSION_TTL) {
      return existing;
    }
  }

  // Create new session
  const token = generateToken();
  const session: Session = {
    token,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: Date.now(),
  };
  sessions.set(token, session);
  userSessions.set(user.id, token);
  return session;
}

export function validateSession(token: string | undefined): Session | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  // Check TTL
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    userSessions.delete(session.userId);
    return null;
  }
  return session;
}

export function logout(token: string): boolean {
  const session = sessions.get(token);
  if (session) {
    sessions.delete(token);
    userSessions.delete(session.userId);
    return true;
  }
  return false;
}

export function getUsersList(): Omit<AuthUser, "password">[] {
  return USERS.map(({ password, ...rest }) => rest);
}
