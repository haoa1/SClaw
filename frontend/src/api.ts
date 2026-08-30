import { PluginInfo, ScreenRequest, ScreenResponse, StrategyInfo } from './types';

const API_BASE = '/api';

function getToken(): string | null {
  try { return localStorage.getItem('auth-token'); } catch { return null; }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: authHeaders(),
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface LoginResponse {
  token: string;
  user: { id: string; username: string; displayName: string; role: string };
}

export interface UserConfig {
  selectedStrategies: Array<{
    pluginId: string;
    strategyId: string;
    strategyName: string;
    params: Record<string, any>;
  }>;
  preferences: Record<string, any>;
}

export interface ScreenRecord {
  id: string;
  timestamp: number;
  strategies: Array<{ pluginId: string; strategyId: string; params: any }>;
  stats: { totalStocks: number; matchedStocks: number; executionTime: number };
  topResults: Array<{ code: string; name: string; score: number; signals: string[] }>;
  resultCount: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  type: 'screen' | 'chat' | 'strategy' | 'auth' | 'system';
  action: string;
  detail: string;
}

export const api = {
  // Generic POST
  post: <T>(url: string, body: any) =>
    fetchJson<T>(url, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Auth
  login: (username: string, password: string) =>
    fetchJson<LoginResponse>('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: (token: string) =>
    fetchJson<{ status: string }>('/logout', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  me: () => fetchJson<{ user: LoginResponse['user'] }>('/me'),

  getPlugins: () => fetchJson<{ plugins: PluginInfo[] }>('/plugins'),

  getStrategies: () => fetchJson<{ strategies: StrategyInfo[] }>('/strategies'),

  screen: (req: ScreenRequest) =>
    fetchJson<ScreenResponse>('/screen', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  refreshData: () =>
    fetchJson<{ message: string; count: number }>('/data/refresh', {
      method: 'POST',
    }),

  health: () => fetchJson<{ status: string; pluginCount: number }>('/health'),

  // User config (server-persistent)
  getUserConfig: () =>
    fetchJson<UserConfig>('/user/config'),

  saveUserConfig: (config: UserConfig) =>
    fetchJson<{ status: string }>('/user/config', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  // Screen history
  getScreens: (limit = 20) =>
    fetchJson<{ screens: ScreenRecord[] }>(`/user/screens?limit=${limit}`),

  getScreenById: (id: string) =>
    fetchJson<ScreenRecord>(`/user/screens/${id}`),

  // Operation logs
  // Scheduler
  getSchedulerTasks: () =>
    fetchJson<{ tasks: import('./types').ScheduledTask[] }>('/scheduler/tasks'),

  getQueueStatus: () =>
    fetchJson<import('./types').QueueStatus>('/scheduler/queue'),

  runSchedulerTask: (taskId: string) =>
    fetchJson<{ success: boolean }>('/scheduler/tasks/' + taskId + '/run', {
      method: 'POST',
    }),

  cancelSchedulerTask: (taskId: string) =>
    fetchJson<{ success: boolean; message: string }>('/scheduler/tasks/' + taskId + '/cancel', {
      method: 'POST',
    }),

  toggleSchedulerTask: (taskId: string, enabled: boolean) =>
    fetchJson<{ success: boolean }>('/scheduler/tasks/' + taskId + '/toggle', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  deleteSchedulerTask: (taskId: string) =>
    fetchJson<{ success: boolean }>('/scheduler/tasks/' + taskId, {
      method: 'DELETE',
    }),

  getLogs: (limit = 50) =>
    fetchJson<{ logs: LogEntry[] }>(`/user/logs?limit=${limit}`),

  // Watch tasks
  getWatchTasks: () =>
    fetchJson<{ tasks: import('./types').WatchTaskSimple[] }>('/watch/tasks'),

  // Model switching
  getModel: () =>
    fetchJson<{ model: string }>('/model'),

  setModel: (model: string) =>
    fetchJson<{ success: boolean; model: string; message: string }>('/model', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

  getModelList: () =>
    fetchJson<{ models: Array<{ id: string; name: string; description: string }> }>('/model/list'),
};
