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
