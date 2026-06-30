/**
 * Simple session-based auth with hardcoded user list.
 * Users can only be added/removed by editing this file.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ===== Session Persistence =====
const SESSIONS_PATH = path.join(__dirname, "..", "data", "sessions.json");

function loadSessions(): void {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return;
    const raw = fs.readFileSync(SESSIONS_PATH, "utf-8");
    const list: Session[] = JSON.parse(raw);
    for (const s of list) {
      sessions.set(s.token, s);
      userSessions.set(s.userId, s.token);
    }
    console.log(`[Auth] Loaded ${list.length} persisted sessions`);
  } catch (err) {
    console.warn("[Auth] Failed to load sessions:", err);
  }
}

function persistSessions(): void {
  try {
    const list = Array.from(sessions.values());
    fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true });
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.warn("[Auth] Failed to persist sessions:", err);
  }
}

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
  { id: "1", username: "admin", password: "admin123", displayName: "Admin", role: "admin" },
  { id: "2", username: "jack",  password: "123456",   displayName: "Jack", role: "admin" },
  { id: "3", username: "siwei", password: "siwei123", displayName: "Siwei", role: "user" },
  { id: "4", username: "yuwei", password: "yuwei123", displayName: "Yuwei", role: "user" },
  { id: "5", username: "testuser", password: "test123", displayName: "TestUser", role: "user" },
  { id: "6", username: "mumu", password: "mumu123", displayName: "Mumu", role: "user" },
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

// Load persisted sessions on module init
loadSessions();

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
  persistSessions();
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
    persistSessions();
    return null;
  }
  return session;
}

export function logout(token: string): boolean {
  const session = sessions.get(token);
  if (session) {
    sessions.delete(token);
    userSessions.delete(session.userId);
    persistSessions();
    return true;
  }
  return false;
}

export function getUsersList(): Omit<AuthUser, "password">[] {
  return USERS.map(({ password, ...rest }) => rest);
}
