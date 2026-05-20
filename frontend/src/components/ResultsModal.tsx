import { FilterResult } from '../types'

interface Props {
  results: FilterResult[]
  stats: { totalStocks: number; matchedStocks: number; executionTime: number }
  strategyLabels: string
  onClose: () => void
}

/** Determine East Money market prefix from stock code */
function getEastMoneyUrl(code: string): string {
  const prefix = code.startsWith('6') ? 'sh' : code.startsWith('0') || code.startsWith('3') ? 'sz' : 'bj'
  return `https://quote.eastmoney.com/${prefix}${code}.html`
}

export default function ResultsModal({ results, stats, strategyLabels, onClose }: Props) {
  const top50 = results.slice(0, 50)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-stock-card border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              📊 AI 选股结果
            </h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
              <span>{strategyLabels}</span>
              <span className="w-px h-3 bg-gray-700" />
              <span>扫描 {stats.totalStocks.toLocaleString()} 只</span>
              <span className="text-blue-400">命中 {stats.matchedStocks} 只</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition text-xl leading-none px-2 py-1 rounded hover:bg-gray-700"
          >
            ✕
          </button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-800 z-10">
              <tr className="border-b border-gray-700">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 w-14">排名</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">代码</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">名称</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">评分</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">信号</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {top50.map((r, i) => (
                <tr key={`${r.code}-${i}`} className="hover:bg-stock-hover/30 transition">
                  <td className="px-4 py-2.5 text-xs text-gray-500">{i + 1}</td>
                  <td className="px-4 py-2.5">
                    <a
                      href={getEastMoneyUrl(r.code)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 transition"
                    >
                      {r.code} ↗
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-sm font-medium text-gray-200">{r.name}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`text-xs font-bold ${
                      r.score >= 80 ? 'text-green-400' : r.score >= 50 ? 'text-yellow-400' : 'text-gray-400'
                    }`}>
                      {r.score}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 flex-wrap">
                      {r.signals.map((s, j) => (
                        <span key={j} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {results.length > 50 && (
            <div className="text-center text-xs text-gray-500 py-3 border-t border-gray-800">
              仅显示前 50 只，共 {results.length} 只匹配 — 详情见「选股结果」Tab
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-gray-700 shrink-0">
          <div className="flex gap-2 flex-wrap">
            {results.slice(0, 5).map(r => (
              <a
                key={r.code}
                href={getEastMoneyUrl(r.code)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs bg-blue-900/30 text-blue-300 px-2 py-0.5 rounded hover:bg-blue-800/40 transition"
              >
                {r.code} ↗
              </a>
            ))}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
