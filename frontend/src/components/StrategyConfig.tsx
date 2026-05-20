import { SelectedStrategy } from '../types'
import StrategyParamInput from './StrategyParamInput'

interface Props {
  selected: SelectedStrategy[]
  onUpdateParams: (index: number, params: Record<string, any>) => void
  onRemove: (index: number) => void
  onRun: () => void
  loading: boolean
}

export default function StrategyConfig({ selected, onUpdateParams, onRemove, onRun, loading }: Props) {
  if (selected.length === 0) {
    return (
      <div className="bg-stock-card rounded-xl border border-gray-800 p-12 text-center">
        <div className="text-5xl mb-4">🧩</div>
        <h3 className="text-lg font-semibold text-gray-300 mb-2">尚未选择策略</h3>
        <p className="text-sm text-gray-500">
          从左侧插件面板选择一个或多个筛选策略，然后执行选股
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {selected.map((item, idx) => (
        <div key={`${item.pluginId}-${item.strategyId}-${idx}`} className="bg-stock-card rounded-xl border border-gray-800 overflow-hidden animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gray-800/50 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-medium">
                {idx + 1}
              </span>
              <div>
                <span className="text-sm font-medium text-gray-200">{item.strategyName}</span>
                <span className="ml-2 text-xs text-gray-500">{item.pluginName}</span>
              </div>
            </div>
            <button
              onClick={() => onRemove(idx)}
              className="text-xs text-gray-500 hover:text-red-400 transition px-2 py-1 rounded hover:bg-red-900/20"
            >
              移除
            </button>
          </div>

          {/* Params */}
          <div className="px-4 py-3">
            {/* We need to find the params definition - fetch from the plugin */}
            {/* For now, render params from the selected item */}
            <StrategyParamInput
              strategyIndex={idx}
              selected={item}
              onUpdateParams={onUpdateParams}
            />
          </div>
        </div>
      ))}

      {/* Run button */}
      <button
        onClick={onRun}
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white py-3 rounded-xl font-medium transition flex items-center justify-center gap-2"
      >
        {loading ? (
          <><span className="loading-dot">●</span><span className="loading-dot">●</span><span className="loading-dot">●</span> 执行中...</>
        ) : (
          `🚀 执行选股 (${selected.length} 个策略)`
        )}
      </button>
    </div>
  )
}
