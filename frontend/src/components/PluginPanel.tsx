import { useState } from 'react'
import { PluginInfo, SelectedStrategy } from '../types'

interface Props {
  plugins: PluginInfo[]
  selected: SelectedStrategy[]
  onAdd: (item: SelectedStrategy) => void
  onRemove: (index: number) => void
}

const CATEGORY_LABELS: Record<string, string> = {
  'long-term': '📈 Long-term Value',
  'mid-term': '📊 Mid-term Swing',
  'short-term': '⚡ Short-term Trading',
  'day-trade': '🎯 Day Trade',
  'sector': '🏭 Sector Rotation',
  'macro': '🌍 Macro Hedge',
  'quant': '🤖 Quant Arbitrage',
  'momentum': '🚀 Trend Following',
  'income': '💰 Dividend Income',
  'reversal': '🔄 Reversal',
  'special': '⭐ Special Events',
}

const CATEGORY_ORDER = [
  'long-term', 'mid-term', 'short-term', 'day-trade',
  'sector', 'macro', 'quant', 'momentum', 'income', 'reversal', 'special'
]

export default function PluginPanel({ plugins, selected, onAdd, onRemove }: Props) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['short-term', 'day-trade', 'long-term']))

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  // Group strategies by category across all plugins
  const grouped = new Map<string, Array<{ plugin: PluginInfo; strategy: PluginInfo['strategies'][0] }>>()
  for (const plugin of plugins) {
    for (const strategy of plugin.strategies) {
      const cat = strategy.category || 'special'
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat)!.push({ plugin, strategy })
    }
  }

  const isSelected = (pluginId: string, strategyId: string) =>
    selected.some(s => s.pluginId === pluginId && s.strategyId === strategyId)

  return (
    <div className="bg-stock-card rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-gray-200">Screening Strategies</h2>
        <p className="text-xs text-gray-500 mt-0.5">Selected {selected.length} strategies</p>
      </div>

      <div className="divide-y divide-gray-800/50 max-h-[70vh] overflow-y-auto">
        {plugins.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            No plugins found. Add plugins to the plugins/ directory
          </div>
        )}

        {CATEGORY_ORDER.filter(c => grouped.has(c)).map(cat => {
          const items = grouped.get(cat)!
          const catSelected = items.filter(i => isSelected(i.plugin.id, i.strategy.id)).length
          const isExpanded = expandedCategories.has(cat)

          return (
            <div key={cat}>
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-stock-hover transition text-left"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] ${isExpanded ? 'rotate-90' : ''} transition-transform text-gray-500`}>▶</span>
                  <span className="text-xs font-medium text-gray-300">{CATEGORY_LABELS[cat] || cat}</span>
                </div>
                <div className="flex items-center gap-2">
                  {catSelected > 0 && (
                    <span className="text-[10px] text-bronze bg-bronze-glow px-1.5 py-0.5 rounded">{catSelected}</span>
                  )}
                  <span className="text-[10px] text-gray-600">{items.length}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="bg-gray-900/50 pb-1">
                  {items.map(({ plugin, strategy }) => {
                    const selIdx = selected.findIndex(
                      s => s.pluginId === plugin.id && s.strategyId === strategy.id
                    )
                    const selected_item = selIdx >= 0

                    return (
                      <div
                        key={`${plugin.id}-${strategy.id}`}
                        className="flex items-center justify-between px-6 py-2 hover:bg-stock-hover/50 transition group"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-200">{strategy.name}</span>
                            {selected_item && (
                              <span className="text-[10px] text-bronze bg-bronze-glow px-1.5 py-0.5 rounded">Active</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 truncate mt-0.5">{strategy.description}</p>
                        </div>
                        <button
                          onClick={() => {
                            if (selected_item) {
                              onRemove(selIdx)
                            } else {
                              const params: Record<string, any> = {}
                              strategy.params.forEach(p => { params[p.key] = p.default })
                              onAdd({
                                pluginId: plugin.id,
                                strategyId: strategy.id,
                                pluginName: plugin.name,
                                strategyName: strategy.name,
                                params,
                                paramsDef: strategy.params,
                              })
                            }
                          }}
                          className={`ml-2 px-3 py-1 rounded text-xs font-medium transition whitespace-nowrap ${
                            selected_item
                              ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50'
                              : 'bg-bronze-glow text-bronze hover:bg-bronze/20'
                          }`}
                        >
                          {selected_item ? 'Remove' : 'Add'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
