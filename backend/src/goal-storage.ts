/**
 * Shared goal storage — used by both goal tool and agent stop_hook.
 *
 * Data stored in <projectRoot>/data/goals.json, scoped by userId.
 * userId is obtained from request-context (AsyncLocalStorage).
 */

import * as fs from 'fs';
import * as path from 'path';

// ===== Types =====

export interface GoalStep {
  step: number;
  desc: string;
  status: 'pending' | 'done';
  summary?: string;
}

export interface Goal {
  id: string;
  description: string;
  status: 'active' | 'completed' | 'cancelled';
  paused: boolean;
  plan: GoalStep[];
  current_step: number;
  created_at: string;
  updated_at: string;
}

export interface UserGoals {
  current: Goal | null;
  history: Goal[];
}

export interface GoalsStore {
  sessions: Record<string, UserGoals>;
}

// ===== Storage =====

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const GOALS_PATH = path.join(DATA_DIR, 'goals.json');

export function getGoalsPath(): string {
  return GOALS_PATH;
}

export function loadGoals(): GoalsStore {
  try {
    if (fs.existsSync(GOALS_PATH)) {
      return JSON.parse(fs.readFileSync(GOALS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[Goal] Failed to load goals.json, starting fresh:', e);
  }
  return { sessions: {} };
}

export function saveGoals(store: GoalsStore): void {
  try {
    fs.writeFileSync(GOALS_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Goal] Failed to save goals.json:', e);
  }
}

export function getSessionKey(userId: string): string {
  return `session-${userId}`;
}

export function getOrCreateUserGoals(store: GoalsStore, userId: string): UserGoals {
  const key = getSessionKey(userId);
  if (!store.sessions[key]) {
    store.sessions[key] = { current: null, history: [] };
  }
  return store.sessions[key];
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
