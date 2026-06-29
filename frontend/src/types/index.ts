export interface StrategyParam {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  default: any;
  options?: string[];
  min?: number;
  max?: number;
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  pluginId: string;
  params: StrategyParam[];
  enabled: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  strategyCount: number;
  enabled: boolean;
  strategies: StrategyInfo[];
}

export interface FilterResult {
  code: string;
  name: string;
  score: number;
  signals: string[];
  metrics: Record<string, number>;
}

export interface ScreenRequest {
  strategies: Array<{
    pluginId: string;
    strategyId: string;
    params: Record<string, any>;
  }>;
  market?: ('SH' | 'SZ' | 'BJ')[];
}

export interface ScreenResponse {
  results: FilterResult[];
  stats: {
    totalStocks: number;
    matchedStocks: number;
    executionTime: number;
  };
}

export interface SelectedStrategy {
  pluginId: string;
  strategyId: string;
  pluginName: string;
  strategyName: string;
  params: Record<string, any>;
  paramsDef: StrategyParam[];
}

// Watch alert types
export interface WatchAlert {
  id: string;
  userId: string;
  taskId: string;
  taskLabel?: string;
  stock: string;
  stockName: string;
  conditionType: string;
  price: number;
  changePercent: number;
  volume: number;
  volumeRatio?: number;
  message: string;
  timestamp: number;
  /** UI-only: whether this alert has been seen */
  read?: boolean;
}

export interface WatchSSEStatus {
  type: 'status';
  activeTasks: number;
  totalTasks: number;
}

// Scheduler task types
export interface ScheduledTask {
  id: string;
  userId: string;
  taskType: 'screen' | 'backtest';
  cronExpr: string;
  email: string;
  aiMode?: 'email' | 'agent' | 'both';
  strategies: Array<{
    pluginId: string;
    strategyId: string;
    strategyName?: string;
    params: Record<string, any>;
  }>;
  backtestConfig?: any;
  label?: string;
  enabled: boolean;
  lastRun?: number;
  lastResult?: {
    matchedCount: number;
    totalCount: number;
    topResults: Array<{code: string; name: string; score: number}>;
    strategies: string;
    timestamp: number;
  };
  createdAt: number;
}

export interface QueueStatus {
  running: { id: string; label: string } | null;
  queued: Array<{ id: string; label: string }>;
}
