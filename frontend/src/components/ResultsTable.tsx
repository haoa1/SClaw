import { useState } from 'react'
import { FilterResult } from '../types'

const PAGE_SIZE = 50

interface Props {
  results: FilterResult[]
  stats: { totalStocks: number; matchedStocks: number; executionTime: number }
  loading: boolean
  onStockClick?: (code: string, name: string) => void
}

export default function ResultsTable({ results, stats, loading, onStockClick }: Props) {
  const [page, setPage] = useState(1)

  if (loading) {
    return (
      <div className="bg-stock-card rounded-xl border border-gray-800 p-12 text-center">
        <div className="text-5xl mb-4 animate-pulse">🔍</div>
        <p className="text-sm text-gray-400">Screening in progress, please wait...</p>
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div className="bg-stock-card rounded-xl border border-gray-800 p-12 text-center">
        <div className="text-5xl mb-4">📭</div>
        <h3 className="text-lg font-semibold text-gray-300 mb-2">No Results</h3>
        <p className="text-sm text-gray-500">Switch to the Strategy tab, select strategies, and run screening</p>
      </div>
    )
  }

  // Reset page when results change
  if (page > Math.ceil(results.length / PAGE_SIZE)) {
    setTimeout(() => setPage(1), 0)
  }

  // Determine metric keys from results
  const metricKeys = Object.keys(results[0]?.metrics || {})

  // Pagination
  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE))
  const startIdx = (page - 1) * PAGE_SIZE
  const pageResults = results.slice(startIdx, startIdx + PAGE_SIZE)

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Stats bar */}
      <div className="flex items-center gap-6 bg-stock-card rounded-xl border border-gray-800 px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Total Stocks</span>
          <span className="text-sm font-semibold text-gray-200">{stats.totalStocks.toLocaleString()}</span>
        </div>
        <div className="w-px h-6 bg-gray-800" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Matched</span>
          <span className="text-sm font-semibold text-bronze">{stats.matchedStocks.toLocaleString()}</span>
        </div>
        <div className="w-px h-6 bg-gray-800" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Hit Rate</span>
          <span className="text-sm font-semibold text-gray-200">
            {stats.totalStocks > 0
              ? ((stats.matchedStocks / stats.totalStocks) * 100).toFixed(2) + '%'
              : '-'}
          </span>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => {
            const csv = [
              ['Code', 'Name', 'Score', ...metricKeys, 'Signals'].join(','),
              ...results.map(r => [
                r.code, r.name, r.score,
                ...metricKeys.map(k => r.metrics[k] ?? ''),
                `"${r.signals.join('; ')}"`,
              ].join(',')),
            ].join('\n')
            const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `screening_results_${new Date().toISOString().slice(0, 10)}.csv`
            a.click()
            URL.revokeObjectURL(url)
          }}
          className="text-xs text-gray-500 hover:text-bronze transition"
        >
          📥 Export CSV
        </button>
      </div>

      {/* Results table */}
      <div className="bg-stock-card rounded-xl border border-gray-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-800/50 border-b border-gray-800">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 w-16">Rank</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Code</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Score</th>
                {metricKeys.map(key => (
                  <th key={key} className="px-4 py-3 text-right text-xs font-medium text-gray-500 whitespace-nowrap">
                    {key === 'pe' ? 'PE' : key === 'pb' ? 'PB' : key === 'price' ? 'Price' : key === 'changePercent' ? 'Chg%' : key === 'volume' ? 'Vol' : key === 'marketCap' ? 'Mkt Cap' : key === 'turnover' ? 'Turnover' : key}
                  </th>
                ))}
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Signals</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {pageResults.map((r, i) => (
                <tr key={`${r.code}-${i}`} className="hover:bg-stock-hover/30 transition cursor-pointer" onClick={() => onStockClick?.(r.code, r.name)} title={`查看 ${r.name} (${r.code}) 缠论分析`}>
                  <td className="px-4 py-2.5 text-xs text-gray-500">{startIdx + i + 1}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{r.code}</td>
                  <td className="px-4 py-2.5 text-sm font-medium text-gray-200">{r.name}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`text-xs font-bold ${
                      r.score >= 80 ? 'text-green-400' : r.score >= 50 ? 'text-yellow-400' : 'text-gray-400'
                    }`}>
                      {r.score}
                    </span>
                  </td>
                  {metricKeys.map(key => {
                    const val = r.metrics[key]
                    let display: string
                    let color = 'text-gray-300'

                    if (key === 'marketCap' && val) {
                      display = (val / 1e8).toFixed(0) + 'B'
                    } else if (key === 'volume' && val) {
                      display = (val / 10000).toFixed(0) + 'M'
                    } else if (key === 'changePercent') {
                      display = val?.toFixed(2) ?? '-'
                      if (val != null) color = val > 0 ? 'text-stock-up' : val < 0 ? 'text-stock-down' : 'text-gray-400'
                    } else if (typeof val === 'number') {
                      display = val.toFixed(3)
                    } else {
                      display = '-'
                    }

                    return (
                      <td key={key} className={`px-4 py-2.5 text-right text-xs ${color}`}>
                        {display}
                      </td>
                    )
                  })}
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
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800 text-xs text-gray-500">
            <span>Page {page}/{totalPages}, {results.length} results</span>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                className={`px-3 py-1 rounded border ${page <= 1 ? 'border-gray-800 text-gray-700 cursor-not-allowed' : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500'}`}
              >‹ Prev</button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                className={`px-3 py-1 rounded border ${page >= totalPages ? 'border-gray-800 text-gray-700 cursor-not-allowed' : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500'}`}
              >Next ›</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
