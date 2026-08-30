import { useState } from 'react'

export interface AiStock {
  code: string
  name: string
  score: number
  signals?: string[]
}

interface ChatStockListProps {
  stocks: AiStock[]
  open: boolean
  onToggle: () => void
  onSelect: (stock: AiStock) => void
  onDiscuss: (stock: AiStock) => void
  onClear: () => void
}

/**
 * 左侧股票列表 — AI 在聊天中选出的股票显示在这里，点击可查看缠论分析
 * 深色主题，风格与 ChatPanel 一致；可折叠为窄条
 */
export default function ChatStockList({ stocks, open, onToggle, onSelect, onDiscuss, onClear }: ChatStockListProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  return (
    <div
      className={`flex flex-col border-r border-gray-800 bg-black transition-all duration-200 overflow-hidden ${
        open ? 'w-44 shrink-0' : 'w-7 shrink-0'
      }`}
    >
      {/* 头部：折叠开关 + 标题 */}
      <div className="flex items-center gap-1 px-1.5 py-2 border-b border-gray-800">
        <button
          onClick={onToggle}
          className="text-gray-500 hover:text-bronze text-[10px] font-mono cursor-pointer transition-colors"
          title={open ? '收起股票列表' : '展开股票列表'}
        >
          {open ? '◀' : '▶'}
        </button>
        {open && (
          <span className="text-[10px] text-gray-500 font-mono truncate flex-1">
            📋 AI选股 <span className="text-bronze">({stocks.length})</span>
          </span>
        )}
      </div>

      {open && (
        <>
          {stocks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center px-2">
              <span className="text-[10px] text-gray-700 font-mono text-center leading-relaxed">
                让 AI 选股后
                <br />
                结果会列在这里
                <br />
                <span className="text-gray-800">点击查看缠论</span>
              </span>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto py-1">
              {stocks.map(s => (
                <button
                  key={s.code}
                  onClick={() => onSelect(s)}
                  onMouseEnter={() => setHovered(s.code)}
                  onMouseLeave={() => setHovered(null)}
                  className={`w-full text-left px-2 py-1.5 border-l-2 transition-colors cursor-pointer ${
                    hovered === s.code
                      ? 'bg-bronze/10 border-bronze'
                      : 'border-transparent hover:bg-bronze/10 hover:border-bronze'
                  }`}
                  title={`查看 ${s.name} (${s.code}) 缠论分析`}
                >
                  <div className="flex items-baseline gap-1">
                    <span className="text-[10px] font-mono text-gray-400">{s.code}</span>
                    <span className="text-xs font-medium text-gray-200 truncate flex-1">{s.name}</span>
                    <span
                      className={`text-[10px] font-mono ${
                        s.score >= 80 ? 'text-green-400' : s.score >= 50 ? 'text-yellow-400' : 'text-gray-500'
                      }`}
                    >
                      {s.score}
                    </span>
                  </div>
                  {hovered === s.code && (
                    <div className="flex items-center gap-2 text-[9px] font-mono mt-0.5">
                      <span className="text-bronze">→ 查看缠论</span>
                      <span
                        onClick={e => { e.stopPropagation(); onDiscuss(s) }}
                        className="text-sky-400 hover:text-sky-300 cursor-pointer"
                        title={`在聊天中讨论 ${s.name} (${s.code})`}
                      >💬 讨论</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="border-t border-gray-800 p-1">
            <button
              onClick={onClear}
              disabled={stocks.length === 0}
              className="w-full text-[10px] text-gray-600 hover:text-red-400 disabled:opacity-30 font-mono py-1 cursor-pointer transition-colors"
            >
              ✕ 清除列表
            </button>
          </div>
        </>
      )}
    </div>
  )
}
