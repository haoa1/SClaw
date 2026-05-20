import { SelectedStrategy } from '../types'

interface Props {
  strategyIndex: number
  selected: SelectedStrategy
  onUpdateParams: (index: number, params: Record<string, any>) => void
}

export default function StrategyParamInput({ strategyIndex, selected, onUpdateParams }: Props) {
  const updateParam = (key: string, value: any) => {
    onUpdateParams(strategyIndex, { ...selected.params, [key]: value })
  }

  return (
    <div className="space-y-3">
      {selected.paramsDef.length === 0 && (
        <p className="text-xs text-gray-500">This strategy has no configurable parameters</p>
      )}

      {selected.paramsDef.map(param => (
        <div key={param.key} className="flex items-center gap-4">
          <label className="text-xs text-gray-400 w-28 shrink-0">{param.label}</label>

          {param.type === 'boolean' ? (
            <button
              onClick={() => updateParam(param.key, !selected.params[param.key])}
              className={`px-3 py-1 rounded text-xs font-medium transition ${
                selected.params[param.key]
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-400'
              }`}
            >
              {selected.params[param.key] ? 'Yes' : 'No'}
            </button>
          ) : param.type === 'select' ? (
            <select
              value={selected.params[param.key]}
              onChange={e => updateParam(param.key, e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500 w-40"
            >
              {param.options?.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              type="number"
              value={selected.params[param.key]}
              onChange={e => updateParam(param.key, parseFloat(e.target.value) || 0)}
              min={param.min}
              max={param.max}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500 w-32"
            />
          )}

          {param.type === 'number' && param.min !== undefined && param.max !== undefined && (
            <span className="text-[10px] text-gray-600">
              {param.min} ~ {param.max}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
