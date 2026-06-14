import { useState, useEffect, useRef, useMemo } from 'react'
import { api } from '../api'
import { PluginInfo, SelectedStrategy } from '../types'

interface BacktestConfig {
 startDate: string
 endDate: string
 strategies: Array<{
  pluginId: string
  strategyId: string
  params: Record<string, any>
 }>
 rebalanceFrequency: string
 initialCapital: number
 maxPositions: number
 commission: number
 benchmark: string
 stopLoss?: number
 takeProfit?: number
 slippageModel?: string
}

interface BacktestSummary {
 totalReturn: number
 annualizedReturn: number
 maxDrawdown: number
 sharpeRatio: number
 winRate: number
 volatility: number
 profitFactor: number
 totalTrades: number
 finalCapital: number
 benchmarkReturn: number | null
 excessReturn: number | null
 alpha: number | null
 beta: number | null
 calmarRatio: number | null
 informationRatio: number | null
 maxConsecutiveLosses: number | null
}

interface EquityPoint {
 date: string
 strategy: number
 benchmark: number | null
}

interface TradeRecord {
 date: string
 type: 'buy' | 'sell'
 code: string
 name: string
 price: number
 shares: number
 amount: number
 reason?: string
 // Computed fields (frontend-only, for display)
 pnl?: number
 pnlPct?: number
 heldDays?: number
}

interface BacktestResult {
 summary: BacktestSummary
 equityCurve: EquityPoint[]
 trades?: TradeRecord[]
 periods?: Array<{ date: string; return: number; benchmarkReturn?: number }>
 timeframeAnalysis?: {
  yearly: TimeframePeriod[]
  quarterly: TimeframePeriod[]
  monthly: TimeframePeriod[]
 }
 techTree?: {
  regimeHeatmap: RegimeHeatmap
  monthlySeasonality: MonthlySeasonality[]
 }
}

interface TimeframePeriod {
 label: string
 date: string
 return: number
 benchmarkReturn: number | null
 maxDrawdown: number
 volatility: number
}

interface RegimeCell {
 regimeLabel: string
 trendLabel: string
 volLabel: string
 return: number
 volatility: number
 maxDrawdown: number
 dayCount: number
 winRate: number
}

interface RegimeHeatmap {
 trendLabels: string[]
 volLabels: string[]
 cells: RegimeCell[][] // [volIndex][trendIndex]
}

interface MonthlySeasonality {
 month: number
 years: Array<{ year: number; return: number }>
 avgReturn: number
 winRate: number
}

const BENCHMARKS = [
 { label: '沪深300', code: '000300.SH' },
 { label: '上证指数', code: '000001.SH' },
 { label: '创业板指', code: '399006.SZ' },
 { label: '深证成指', code: '399001.SZ' },
]

const FREQUENCIES = ['monthly', 'weekly', 'daily', 'quarterly']

function formatPct(v: number | null | undefined): string {
 if (v === null || v === undefined) return '—'
 return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function formatFixed(v: number | null | undefined, digits = 2): string {
 if (v === null || v === undefined) return '—'
 return v.toFixed(digits)
}

function MetricCard({ label, value, color }: {
 label: string
 value: string
 color?: 'green' | 'red' | 'neutral'
}) {
 const cls = color === 'green' ? 'text-green-400'
  : color === 'red' ? 'text-red-400'
  : 'text-white'
 return (
  <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3">
   <div className="text-xs text-gray-500 mb-1">{label}</div>
   <div className={`text-lg font-semibold ${cls}`}>{value}</div>
  </div>
 )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
 return (
  <div className="bg-stock-card border border-gray-800 rounded-xl p-5">
   <h3 className="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider">{title}</h3>
   {children}
  </div>
 )
}

type ChartView = 'strategy' | 'benchmark' | 'both'

function TimeframeTable({ title, data }: { title: string; data: TimeframePeriod[] }) {
 if (data.length === 0) return null
 return (
  <div className="mb-4">
   <h4 className="text-xs text-gray-500 mb-2 uppercase tracking-wider">{title}</h4>
   <div className="overflow-x-auto">
    <table className="w-full text-sm">
     <thead>
      <tr className="text-left text-gray-500 text-xs uppercase">
       <th className="pb-2 pr-4">Period</th>
       <th className="pb-2 pr-4 text-right">Return</th>
       <th className="pb-2 pr-4 text-right">Benchmark</th>
       <th className="pb-2 pr-4 text-right">Excess</th>
       <th className="pb-2 pr-4 text-right">Max Drawdown</th>
       <th className="pb-2 text-right">Volatility</th>
      </tr>
     </thead>
     <tbody>
      {data.map((p, i) => {
       const excess = p.benchmarkReturn !== null ? p.return - p.benchmarkReturn : null
       return (
        <tr key={i} className="border-t border-gray-800/50">
         <td className="py-2 pr-4 text-gray-400 font-medium">{p.label}</td>
         <td className={`py-2 pr-4 text-right font-medium ${p.return >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {formatPct(p.return)}
         </td>
         <td className={`py-2 pr-4 text-right ${p.benchmarkReturn !== null ? (p.benchmarkReturn >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
          {p.benchmarkReturn !== null ? formatPct(p.benchmarkReturn) : '—'}
         </td>
         <td className={`py-2 pr-4 text-right ${excess !== null ? (excess >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
          {excess !== null ? formatPct(excess) : '—'}
         </td>
         <td className="py-2 pr-4 text-right text-red-400">{formatPct(p.maxDrawdown)}</td>
         <td className="py-2 text-right text-gray-300">{formatPct(p.volatility)}</td>
        </tr>
       )
      })}
     </tbody>
    </table>
   </div>
  </div>
 )
}

function RegimeCellView({ cell }: { cell: RegimeCell }) {
 // Color based on return value
 const intensity = Math.min(Math.abs(cell.return) * 20, 0.9)
 const bgColor = cell.dayCount === 0
  ? 'bg-gray-900'
  : cell.return > 0
   ? `rgba(34, 197, 94, ${intensity})`
   : `rgba(239, 68, 68, ${intensity})`

 return (
  <td
   className="px-3 py-2 text-center text-xs border border-gray-800"
   style={{ backgroundColor: bgColor, minWidth: 80 }}
   title={`${cell.regimeLabel}\nAvg Daily Return: ${formatPct(cell.return)}\nWin Rate: ${formatFixed(cell.winRate, 1)}%\nDays: ${cell.dayCount}`}
  >
   {cell.dayCount > 0 ? (
    <>
     <div className={`font-medium ${cell.return >= 0 ? 'text-green-300' : 'text-red-300'}`}>
      {formatPct(cell.return)}
     </div>
     <div className="text-gray-500 text-[10px]">{cell.dayCount}d</div>
    </>
   ) : (
    <div className="text-gray-700">—</div>
   )}
  </td>
 )
}

function RegimeHeatmapView({ heatmap }: { heatmap: RegimeHeatmap }) {
 if (heatmap.cells.length === 0) return null
 return (
  <div className="overflow-x-auto">
   <table className="w-full text-sm border-collapse">
    <thead>
     <tr>
      <th className="px-2 py-1 text-left text-gray-500 text-xs uppercase w-16" />
      {heatmap.trendLabels.map((label, i) => (
       <th key={i} className="px-3 py-1 text-center text-gray-400 text-xs uppercase">{label}</th>
      ))}
     </tr>
    </thead>
    <tbody>
     {heatmap.volLabels.map((volLabel, volIdx) => (
      <tr key={volIdx}>
       <td className="px-2 py-1 text-gray-500 text-xs uppercase font-medium">{volLabel}</td>
       {heatmap.cells[volIdx]?.map((cell, trendIdx) => (
        <RegimeCellView key={trendIdx} cell={cell} />
       ))}
      </tr>
     ))}
    </tbody>
   </table>
  </div>
 )
}

function MonthlySeasonalityView({ data }: { data: MonthlySeasonality[] }) {
 if (data.length === 0) return null
 const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', '1Jan', '1Feb']

 // Find min/max for color scaling
 const allAvgs = data.filter(d => d.years.length > 0).map(d => d.avgReturn)
 const maxAbs = Math.max(...allAvgs.map(Math.abs), 0.01)

 return (
  <div className="overflow-x-auto">
   <table className="w-full text-sm border-collapse">
    <thead>
     <tr>
      <th className="px-2 py-1 text-left text-gray-500 text-xs uppercase w-16" />
      {MONTHS.map((m, i) => (
       <th key={i} className="px-2 py-1 text-center text-gray-400 text-[10px] uppercase">{m}</th>
      ))}
     </tr>
    </thead>
    <tbody>
     <tr>
      <td className="px-2 py-1 text-gray-500 text-xs">Average</td>
      {data.map((m, i) => {
       const intensity = Math.abs(m.avgReturn) / (maxAbs || 1) * 0.8
       const bgColor = m.years.length === 0
        ? 'bg-gray-900'
        : m.avgReturn >= 0
         ? `rgba(34, 197, 94, ${intensity})`
         : `rgba(239, 68, 68, ${intensity})`
       return (
        <td
         key={i}
         className="px-2 py-2 text-center border border-gray-800"
         style={{ backgroundColor: bgColor, minWidth: 44 }}
         title={`${MONTHS[i]}\nAvg Daily Return: ${formatPct(m.avgReturn)}\nWin Rate: ${formatFixed(m.winRate, 1)}%`}
        >
         <span className={`text-xs font-medium ${m.avgReturn >= 0 ? 'text-green-300' : 'text-red-300'}`}>
          {formatPct(m.avgReturn)}
         </span>
        </td>
       )
      })}
     </tr>
     <tr>
      <td className="px-2 py-1 text-gray-500 text-xs">Win Rate</td>
      {data.map((m, i) => (
       <td key={i} className="px-2 py-1 text-center border border-gray-800">
        <span className="text-xs text-gray-400">{m.years.length > 0 ? `${formatFixed(m.winRate, 0)}%` : '—'}</span>
       </td>
      ))}
     </tr>
    </tbody>
   </table>
  </div>
 )
}

export default function BacktestPanel({ plugins }: { plugins: PluginInfo[] }) {
 const [config, setConfig] = useState<BacktestConfig>({
  startDate: '2025-01-01',
  endDate: '2025-04-01',
  strategies: [],
  rebalanceFrequency: 'monthly',
  initialCapital: 100000,
  maxPositions: 5,
  commission: 0.0003,
  benchmark: '000300.SH',
  stopLoss: -15,
  takeProfit: 50,
  slippageModel: 'fixed',
 })
 const [selectedPlugin, setSelectedPlugin] = useState('')
 const [selectedStrategy, setSelectedStrategy] = useState('')
 const [strategyParams, setStrategyParams] = useState<Record<string, any>>({})
 const [result, setResult] = useState<BacktestResult | null>(null)
 const [loading, setLoading] = useState(false)
 const [error, setError] = useState('')
 const [chartView, setChartView] = useState<ChartView>('both')
 const [tradeFilter, setTradeFilter] = useState<'all' | 'buy' | 'sell'>('all')
 const [tradeSort, setTradeSort] = useState<'date' | 'code'>('date')
 const [tradeSearch, setTradeSearch] = useState('')
 const resultRef = useRef<HTMLDivElement>(null)

 // Compute enhanced trades with PnL tracking
 const enhancedTrades = useMemo(() => {
  if (!result?.trades || result.trades.length === 0) return []
  
  const raw = result.trades as TradeRecord[]
  
  // Track buy positions for PnL calculation
  const buyMap = new Map<string, { price: number; date: string }>()
  const withPnL: TradeRecord[] = []
  
  for (const t of raw) {
   const enriched: TradeRecord = { ...t, type: t.type || 'buy', amount: t.amount || 0 }
   
   if (enriched.type === 'buy' && enriched.shares > 0) {
    buyMap.set(enriched.code, { price: enriched.price, date: enriched.date })
   } else if (enriched.type === 'sell' && enriched.shares > 0) {
    const buy = buyMap.get(enriched.code)
    if (buy) {
     enriched.pnl = enriched.amount - (buy.price * enriched.shares)
     enriched.pnlPct = buy.price > 0 ? ((enriched.price - buy.price) / buy.price) * 100 : 0
     // Estimate held days
     const buyDate = new Date(buy.date)
     const sellDate = new Date(enriched.date)
     enriched.heldDays = Math.round((sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24))
     buyMap.delete(enriched.code)
    }
   }
   withPnL.push(enriched)
  }
  
  return withPnL
 }, [result?.trades])

 // Filter and sort trades
 const filteredTrades = useMemo(() => {
  let filtered = [...enhancedTrades]
  
  if (tradeFilter !== 'all') {
   filtered = filtered.filter(t => t.type === tradeFilter)
  }
  
  if (tradeSearch.trim()) {
   const q = tradeSearch.trim().toLowerCase()
   filtered = filtered.filter(t => 
    t.code.toLowerCase().includes(q) || 
    (t.name || '').toLowerCase().includes(q)
   )
  }
  
  filtered.sort((a, b) => {
   if (tradeSort === 'code') {
    const cmp = a.code.localeCompare(b.code)
    if (cmp !== 0) return cmp
    return a.date.localeCompare(b.date)
   }
   return a.date.localeCompare(b.date)
  })
  
  return filtered
 }, [enhancedTrades, tradeFilter, tradeSort, tradeSearch])

 // Trade stats
 const tradeStats = useMemo(() => {
  const buys = enhancedTrades.filter(t => t.type === 'buy')
  const sells = enhancedTrades.filter(t => t.type === 'sell')
  const totalBuyAmount = buys.reduce((s, t) => s + (t.amount || 0), 0)
  const totalSellAmount = sells.reduce((s, t) => s + (t.amount || 0), 0)
  const totalPnL = sells.reduce((s, t) => s + (t.pnl || 0), 0)
  const winTrades = sells.filter(t => (t.pnl || 0) > 0).length
  const loseTrades = sells.filter(t => (t.pnl || 0) < 0).length
  return { buys: buys.length, sells: sells.length, totalBuyAmount, totalSellAmount, totalPnL, winTrades, loseTrades }
 }, [enhancedTrades])

 // Find available strategies for selected plugin
 // PluginInfo.id is the pluginId, not a field called pluginId
 const currentPlugin = plugins.find(p => p.id === selectedPlugin)
 const currentStrategy = currentPlugin?.strategies.find(s => s.id === selectedStrategy)

 // Set default params when strategy changes
 useEffect(() => {
  if (currentStrategy?.params) {
   const defaults: Record<string, any> = {}
   for (const p of currentStrategy.params) {
    defaults[p.key] = p.default
   }
   setStrategyParams(defaults)
  }
 }, [selectedStrategy, currentStrategy])

 const addStrategyToConfig = () => {
  if (!selectedPlugin || !selectedStrategy) return
  const exists = config.strategies.some(
   s => s.pluginId === selectedPlugin && s.strategyId === selectedStrategy
  )
  if (exists) return
  setConfig(prev => ({
   ...prev,
   strategies: [...prev.strategies, { pluginId: selectedPlugin, strategyId: selectedStrategy, params: { ...strategyParams } }],
  }))
 }

 const removeStrategyFromConfig = (idx: number) => {
  setConfig(prev => ({
   ...prev,
   strategies: prev.strategies.filter((_, i) => i !== idx),
  }))
 }

 const runBacktest = async () => {
  if (config.strategies.length === 0) {
   setError('Please add at least one strategy')
   return
  }
  setLoading(true)
  setError('')
  setResult(null)
  try {
   const res = await api.post<{ success: boolean; result: BacktestResult; error?: string }>('/backtest/run', config)
   if (res.success) {
    setResult(res.result)
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
   } else {
    setError(res.error || 'Backtest failed')
   }
  } catch (err: any) {
   setError(`Backtest failed: ${err.message}`)
  } finally {
   setLoading(false)
  }
 }

 // Build chart data
 const chartData = result?.equityCurve || []
 const showBenchmark = (chartView === 'both' || chartView === 'benchmark') && chartData.some(d => d.benchmark !== null)
 const showStrategy = chartView === 'both' || chartView === 'strategy'

 // Compute min/max for chart
 const allValues = chartData.flatMap(d => {
  const vals: number[] = []
  if (showStrategy) vals.push(d.strategy)
  if (showBenchmark && d.benchmark !== null) vals.push(d.benchmark)
  return vals
 })
 const yMin = allValues.length > 0 ? Math.min(...allValues) : 90
 const yMax = allValues.length > 0 ? Math.max(...allValues) : 110
 const yPadding = (yMax - yMin) * 0.1 || 10

 // Chart dimensions
 const chartW = 700
 const chartH = 300
 const padding = { top: 20, right: 20, bottom: 30, left: 60 }
 const plotW = chartW - padding.left - padding.right
 const plotH = chartH - padding.top - padding.bottom

 const xScale = (i: number) => padding.left + (i / Math.max(chartData.length - 1, 1)) * plotW
 const yScale = (v: number) => padding.top + plotH - ((v - yMin) / (yMax - yMin + yPadding)) * plotH

 const strategyPath = showStrategy ? chartData.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(d.strategy).toFixed(1)}`).join(' ') : ''
 const benchmarkPath = showBenchmark
  ? chartData.filter(d => d.benchmark !== null).map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(d.benchmark!).toFixed(1)}`).join(' ')
  : ''

 // Y axis ticks
 const yTicks: number[] = []
 const yStep = (yMax - yMin + yPadding) / 4
 for (let i = 0; i <= 4; i++) {
  yTicks.push(yMin + yStep * i)
 }

 // X axis ticks (show ~6 labels)
 const xTickInterval = Math.max(1, Math.floor(chartData.length / 6))
 const xTicks = chartData.filter((_, i) => i % xTickInterval === 0 || i === chartData.length - 1)

 // Helper to get plugin name from id
 const getPluginName = (pid: string) => plugins.find(p => p.id === pid)?.name || pid

 return (
  <div className="space-y-6">
   {/* Configuration Form */}
   <Section title="Backtest Config">
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
     {/* Left: Strategy selection */}
     <div className="space-y-3">
      <label className="block">
       <span className="text-xs text-gray-400">Select Strategy Plugin</span>
       <select
        value={selectedPlugin}
        onChange={e => { setSelectedPlugin(e.target.value); setSelectedStrategy('') }}
        className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
       >
        <option value="">— Select Plugin —</option>
        {plugins.map(p => (
         <option key={p.id} value={p.id}>{p.name}</option>
        ))}
       </select>
      </label>
      {currentPlugin && (
       <label className="block">
        <span className="text-xs text-gray-400">Select Strategy</span>
        <select
         value={selectedStrategy}
         onChange={e => setSelectedStrategy(e.target.value)}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
        >
         <option value="">— Select Strategy —</option>
         {currentPlugin.strategies.map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
         ))}
        </select>
       </label>
      )}
      {currentStrategy && currentStrategy.params && (
       <div className="space-y-2">
        {currentStrategy.params.map(p => (
         <label key={p.key} className="block">
          <span className="text-xs text-gray-400">{p.label} {p.key !== p.label && `(${p.key})`}</span>
          <input
           type="number"
           value={strategyParams[p.key] ?? p.default}
           onChange={e => setStrategyParams(sp => ({ ...sp, [p.key]: parseFloat(e.target.value) || p.default }))}
           className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
          />
         </label>
        ))}
       </div>
      )}
      <button
       onClick={addStrategyToConfig}
       disabled={!selectedPlugin || !selectedStrategy}
       className="btn-bronze disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-1.5 rounded-lg text-sm transition"
      >
       + Add to Strategy List
      </button>
     </div>

     {/* Right: Parameters */}
     <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
       <label className="block">
        <span className="text-xs text-gray-400">Start Date</span>
        <input
         type="date" value={config.startDate}
         onChange={e => setConfig(c => ({ ...c, startDate: e.target.value }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        />
       </label>
       <label className="block">
        <span className="text-xs text-gray-400">End Date</span>
        <input
         type="date" value={config.endDate}
         onChange={e => setConfig(c => ({ ...c, endDate: e.target.value }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        />
       </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
       <label className="block">
        <span className="text-xs text-gray-400">Initial Capital (¥)</span>
        <input
         type="number" value={config.initialCapital}
         onChange={e => setConfig(c => ({ ...c, initialCapital: parseInt(e.target.value) || 100000 }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        />
       </label>
       <label className="block">
        <span className="text-xs text-gray-400">Max Holdings</span>
        <input
         type="number" value={config.maxPositions}
         onChange={e => setConfig(c => ({ ...c, maxPositions: parseInt(e.target.value) || 5 }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        />
       </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
       <label className="block">
        <span className="text-xs text-gray-400">Rebalance Frequency</span>
        <select
         value={config.rebalanceFrequency}
         onChange={e => setConfig(c => ({ ...c, rebalanceFrequency: e.target.value }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        >
         {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
       </label>
       <label className="block">
        <span className="text-xs text-gray-400">Trading Commission</span>
        <input
         type="number" step="0.0001" value={config.commission}
         onChange={e => setConfig(c => ({ ...c, commission: parseFloat(e.target.value) || 0.0003 }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        />
       </label>
      </div>
      <label className="block">
       <span className="text-xs text-gray-400">Benchmark Index</span>
       <select
        value={config.benchmark}
        onChange={e => setConfig(c => ({ ...c, benchmark: e.target.value }))}
        className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
       >
        {BENCHMARKS.map(b => <option key={b.code} value={b.code}>{b.label} ({b.code})</option>)}
       </select>
      </label>

      {/* Advanced: stop-loss, take-profit, slippage */}
      <div className="border-t border-gray-700 pt-3 mt-2">
       <div className="text-xs text-gray-500 mb-2">Risk Control</div>
       <div className="grid grid-cols-2 gap-3">
        <label className="block">
         <span className="text-xs text-gray-400">Stop Loss (%)</span>
         <input
          type="number" value={config.stopLoss ?? ''}
          onChange={e => setConfig(c => ({ ...c, stopLoss: e.target.value ? parseFloat(e.target.value) : undefined }))}
          placeholder="-15"
          className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
         />
        </label>
        <label className="block">
         <span className="text-xs text-gray-400">Take Profit (%)</span>
         <input
          type="number" value={config.takeProfit ?? ''}
          onChange={e => setConfig(c => ({ ...c, takeProfit: e.target.value ? parseFloat(e.target.value) : undefined }))}
          placeholder="50"
          className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
         />
        </label>
       </div>
       <label className="block mt-2">
        <span className="text-xs text-gray-400">Slippage Model</span>
        <select
         value={config.slippageModel ?? 'fixed'}
         onChange={e => setConfig(c => ({ ...c, slippageModel: e.target.value }))}
         className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        >
         <option value="none">No Slippage (Ideal)</option>
         <option value="fixed">Fixed Slippage 0.1%</option>
         <option value="volume">Volume Proportional Slippage</option>
        </select>
       </label>
      </div>
     </div>
    </div>

    {/* Selected strategies list */}
    {config.strategies.length > 0 && (
     <div className="mt-4">
      <div className="text-xs text-gray-500 mb-2">Selected Strategies ({config.strategies.length})</div>
      <div className="flex flex-wrap gap-2">
       {config.strategies.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 bg-bronze-glow border border-bronze/50 px-2.5 py-1 rounded-full text-xs text-bronze-light">
         {getPluginName(s.pluginId)}/{s.strategyId}
         <button onClick={() => removeStrategyFromConfig(i)} className="text-bronze hover:text-red-400 ml-1">&times;</button>
        </span>
       ))}
      </div>
     </div>
    )}

    <div className="mt-4 flex items-center gap-3">
     <button
      onClick={runBacktest}
      disabled={loading || config.strategies.length === 0}
      className="bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-6 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2"
     >
      {loading ? '⏳ Backtesting...' : '📊 Start Backtest'}
     </button>
     {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
   </Section>

   {/* Results */}
   {result && (
    <div ref={resultRef} className="space-y-6">
     {/* Summary Metrics */}
     <Section title="Performance Metrics">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
       <MetricCard label="Total Return" value={formatPct(result.summary.totalReturn)} color={result.summary.totalReturn >= 0 ? 'green' : 'red'} />
       <MetricCard label="Annualized Return" value={formatPct(result.summary.annualizedReturn)} color={result.summary.annualizedReturn >= 0 ? 'green' : 'red'} />
       <MetricCard label="Max Drawdown" value={formatPct(result.summary.maxDrawdown)} color="red" />
       <MetricCard label="Sharpe Ratio" value={formatFixed(result.summary.sharpeRatio)} color={result.summary.sharpeRatio >= 1 ? 'green' : result.summary.sharpeRatio >= 0 ? 'neutral' : 'red'} />
       <MetricCard label="Volatility" value={formatPct(result.summary.volatility)} />
       <MetricCard label="Win Rate" value={formatPct(result.summary.winRate)} color={result.summary.winRate >= 50 ? 'green' : 'red'} />
       <MetricCard label="Profit Factor" value={formatFixed(result.summary.profitFactor)} color={result.summary.profitFactor >= 2 ? 'green' : result.summary.profitFactor >= 1 ? 'neutral' : 'red'} />
       <MetricCard label="Total Trades" value={String(result.summary.totalTrades)} />
       <MetricCard label="Final Equity" value={`¥${(result.summary.finalCapital ?? 0).toLocaleString()}`} color={result.summary.finalCapital >= 100000 ? 'green' : 'red'} />
      </div>
     </Section>

     {/* Benchmark Comparison */}
     <Section title="Benchmark Comparison">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
       <MetricCard label="Benchmark Return" value={formatPct(result.summary.benchmarkReturn)} color={result.summary.benchmarkReturn !== null && result.summary.benchmarkReturn >= 0 ? 'green' : 'red'} />
       <MetricCard label="ExcessReturn" value={formatPct(result.summary.excessReturn)} color={result.summary.excessReturn !== null && result.summary.excessReturn >= 0 ? 'green' : 'red'} />
       <MetricCard label="Alpha" value={formatFixed(result.summary.alpha)} color={result.summary.alpha !== null && result.summary.alpha > 0 ? 'green' : 'red'} />
       <MetricCard label="Beta" value={formatFixed(result.summary.beta)} />
       <MetricCard label="Calmar Ratio" value={formatFixed(result.summary.calmarRatio)} color={result.summary.calmarRatio !== null && result.summary.calmarRatio >= 2 ? 'green' : result.summary.calmarRatio !== null && result.summary.calmarRatio >= 0 ? 'neutral' : 'red'} />
       <MetricCard label="Information Ratio" value={formatFixed(result.summary.informationRatio)} color={result.summary.informationRatio !== null && result.summary.informationRatio >= 1 ? 'green' : result.summary.informationRatio !== null && result.summary.informationRatio >= 0 ? 'neutral' : 'red'} />
       <MetricCard label="Max Consecutive Loss" value={result.summary.maxConsecutiveLosses !== null ? `${result.summary.maxConsecutiveLosses} days` : '—'} color="red" />
      </div>
     </Section>

     {/* Equity Curve Chart */}
     {chartData.length > 0 && (
      <Section title="Equity Curve">
       {/* Chart controls */}
       <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-gray-500">Show: </span>
        {(['both', 'strategy', 'benchmark'] as const).map(v => (
         <button
          key={v}
          onClick={() => setChartView(v)}
          className={`text-xs px-2.5 py-1 rounded-full transition ${
           chartView === v ? 'bg-bronze text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
          }`}
         >
          {v === 'both' ? 'All' : v === 'strategy' ? 'Strategy' : 'Benchmark'}
         </button>
        ))}
       </div>
       <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full max-w-3xl" style={{ height: 'auto' }}>
        {/* Grid lines */}
        {yTicks.map((v, i) => (
         <g key={i}>
          <line x1={padding.left} y1={yScale(v)} x2={chartW - padding.right} y2={yScale(v)}
           stroke="#333" strokeWidth={0.5} />
          <text x={padding.left - 8} y={yScale(v) + 4} textAnchor="end" fill="#666" fontSize={10}>
           {v.toFixed(1)}
          </text>
         </g>
        ))}
        {/* X axis labels */}
        {xTicks.map((d, i) => {
         const idx = chartData.indexOf(d)
         return (
          <text key={i} x={xScale(idx)} y={chartH - 5} textAnchor="middle" fill="#666" fontSize={9}>
           {d.date.slice(5)}
          </text>
         )
        })}
        {/* Benchmark line */}
        {showBenchmark && benchmarkPath && (
         <path d={benchmarkPath} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
        )}
        {/* Strategy equity line */}
        {showStrategy && strategyPath && (
         <path d={strategyPath} fill="none" stroke="#22c55e" strokeWidth={2} />
        )}
        {/* Labels */}
        <line x1={chartW - 120} y1={10} x2={chartW - 100} y2={10} stroke="#22c55e" strokeWidth={2} />
        <text x={chartW - 95} y={14} fill="#22c55e" fontSize={11}>Strategy</text>
        {showBenchmark && (
         <>
          <line x1={chartW - 120} y1={25} x2={chartW - 100} y2={25} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
          <text x={chartW - 95} y={29} fill="#f59e0b" fontSize={11}>Benchmark</text>
         </>
        )}
       </svg>
      </Section>
     )}

     {/* Period Breakdown */}
     {result.periods && result.periods.length > 0 && (
      <Section title="Period Returns">
       <div className="overflow-x-auto">
        <table className="w-full text-sm">
         <thead>
          <tr className="text-left text-gray-500 text-xs uppercase">
           <th className="pb-2 pr-4">Date</th>
           <th className="pb-2 pr-4">StrategyReturn</th>
           <th className="pb-2 pr-4">BenchmarkReturn</th>
           <th className="pb-2">Excess</th>
          </tr>
         </thead>
         <tbody>
          {result.periods.map((p, i) => {
           const excess = p.benchmarkReturn !== undefined ? p.return - p.benchmarkReturn : null
           return (
            <tr key={i} className="border-t border-gray-800/50">
             <td className="py-2 pr-4 text-gray-400">{p.date}</td>
             <td className={`py-2 pr-4 font-medium ${p.return >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {formatPct(p.return)}
             </td>
             <td className={`py-2 pr-4 ${p.benchmarkReturn !== undefined ? (p.benchmarkReturn >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
              {p.benchmarkReturn !== undefined ? formatPct(p.benchmarkReturn) : '—'}
             </td>
             <td className={`py-2 ${excess !== null ? (excess >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
              {excess !== null ? formatPct(excess) : '—'}
             </td>
            </tr>
           )
          })}
         </tbody>
        </table>
       </div>
      </Section>
     )}

     {/* Multi-Timeframe Analysis */}
     {result.timeframeAnalysis && (
      <Section title="Multi-Timeframe Analysis">
       <TimeframeTable title="Yearly" data={result.timeframeAnalysis.yearly} />
       <TimeframeTable title="Quarterly" data={result.timeframeAnalysis.quarterly} />
       <TimeframeTable title="Monthly" data={result.timeframeAnalysis.monthly} />
      </Section>
     )}

     {/* Tech Tree: Regime Heatmap + Monthly Seasonality */}
     {result.techTree && (
      <Section title="Tech Tree Analysis">
       <div className="mb-6">
        <h4 className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Market Regime Heatmap</h4>
        <RegimeHeatmapView heatmap={result.techTree.regimeHeatmap} />
        <p className="text-[10px] text-gray-600 mt-2">
         X-Axis: Trend(Strong Bear→Weak Bear→Consolidate→Weak Bull→Strong Bull
         · Y-Axis: Volatility(Low Vol→Mid Vol→High Vol
         · Darker colors = Avg Daily Returnhigher(Green up, Red down
        </p>
       </div>
       <div>
        <h4 className="text-xs text-gray-500 mb-3 uppercase tracking-wider">MonthlySeasonality</h4>
        <MonthlySeasonalityView data={result.techTree.monthlySeasonality} />
        <p className="text-[10px] text-gray-600 mt-2">
         Each cell showsAvg Daily Return · 2nd row: historicalMonthlyWin Rate · Darker colors = higher absolute value
        </p>
       </div>
      </Section>
     )}

     {/* Trade Detail Table */}
     {filteredTrades.length > 0 && (
      <Section title={`Trade Detail (${enhancedTrades.length})`}>
       {/* Trade Stats Bar */}
       <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Buy Orders" value={`${tradeStats.buys}`} color="neutral" />
        <MetricCard label="Sell Orders" value={`${tradeStats.sells}`} color="neutral" />
        <MetricCard label="Total Buy Amount" value={`¥${tradeStats.totalBuyAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color="neutral" />
        <MetricCard
         label="Trade PTrade PnLL"
         value={`${tradeStats.totalPnL >= 0 ? '+' : ''}¥${tradeStats.totalPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
         color={tradeStats.totalPnL >= 0 ? 'green' : 'red'}
        />
       </div>
       {tradeStats.winTrades + tradeStats.loseTrades > 0 && (
        <div className="flex items-center gap-2 mb-4 text-xs text-gray-500">
         <span>Win: <span className="text-green-400">{tradeStats.winTrades}</span></span>
         <span>Loss: <span className="text-red-400">{tradeStats.loseTrades}</span></span>
         <span>Win Rate: <span className={`${tradeStats.winTrades >= tradeStats.loseTrades ? 'text-green-400' : 'text-red-400'}`}>
          {((tradeStats.winTrades / (tradeStats.winTrades + tradeStats.loseTrades)) * 100).toFixed(1)}%
         </span></span>
        </div>
       )}

       {/* Filter/Sort Controls */}
       <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex items-center gap-1 bg-gray-800/60 rounded-lg p-0.5 border border-gray-700">
         {(['all', 'buy', 'sell'] as const).map(f => (
          <button
           key={f}
           onClick={() => setTradeFilter(f)}
           className={`px-3 py-1 text-xs rounded-md transition ${
            tradeFilter === f
             ? 'bg-bronze text-white'
             : 'text-gray-400 hover:text-gray-200'
           }`}
          >
           {f === 'all' ? 'All' : f === 'buy' ? 'Buy' : 'Sell'}
          </button>
         ))}
        </div>
        <div className="flex items-center gap-1 bg-gray-800/60 rounded-lg p-0.5 border border-gray-700">
         {(['date', 'code'] as const).map(s => (
          <button
           key={s}
           onClick={() => setTradeSort(s)}
           className={`px-3 py-1 text-xs rounded-md transition ${
            tradeSort === s
             ? 'bg-bronze text-white'
             : 'text-gray-400 hover:text-gray-200'
           }`}
          >
           {s === 'date' ? 'Date' : 'Code'}
          </button>
         ))}
        </div>
        <input
         type="text"
         value={tradeSearch}
         onChange={e => setTradeSearch(e.target.value)}
         placeholder="SearchCode/Name..."
         className="flex-1 min-w-[120px] bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600"
        />
        <span className="text-xs text-gray-600">{filteredTrades.length} items</span>
       </div>

       {/* Trade Table */}
       <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
         <thead className="text-gray-500 border-b border-gray-700 sticky top-0 bg-stock-card z-10">
          <tr>
           <th className="pb-2 pr-2 text-left">Date</th>
           <th className="pb-2 pr-2 text-left">Operation</th>
           <th className="pb-2 pr-2 text-left">Code</th>
           <th className="pb-2 pr-2 text-left">Name</th>
           <th className="pb-2 pr-2 text-right">Price</th>
           <th className="pb-2 pr-2 text-right">Qty</th>
           <th className="pb-2 pr-2 text-right">Amount</th>
           <th className="pb-2 pr-2 text-right">PnL</th>
           <th className="pb-2 pr-2 text-right">ReturnRate</th>
           <th className="pb-2 text-right">Hold</th>
          </tr>
         </thead>
         <tbody>
          {filteredTrades.map((t, i) => (
           <tr key={i} className="border-t border-gray-800/50 hover:bg-gray-800/40">
            <td className="py-1.5 pr-2 text-gray-400 whitespace-nowrap">{t.date}</td>
            <td className={`py-1.5 pr-2 font-medium whitespace-nowrap ${
             t.type === 'buy' ? 'text-green-400' : 'text-red-400'
            }`}>
             {t.type === 'buy' ? 'Buy' : 'Sell'}
            </td>
            <td className="py-1.5 pr-2 text-gray-300 whitespace-nowrap">{t.code}</td>
            <td className="py-1.5 pr-2 text-gray-300 max-w-[100px] truncate" title={t.name}>
             {t.name || '—'}
            </td>
            <td className="py-1.5 pr-2 text-right text-gray-300 whitespace-nowrap">
             ¥{t.price.toFixed(2)}
            </td>
            <td className="py-1.5 pr-2 text-right text-gray-300 whitespace-nowrap">
             {t.shares.toLocaleString()}
            </td>
            <td className="py-1.5 pr-2 text-right text-gray-300 whitespace-nowrap">
             ¥{(t.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </td>
            <td className={`py-1.5 pr-2 text-right whitespace-nowrap ${
             t.pnl !== undefined
              ? t.pnl >= 0 ? 'text-green-400' : 'text-red-400'
              : 'text-gray-600'
            }`}>
             {t.pnl !== undefined
              ? `${t.pnl >= 0 ? '+' : ''}¥${t.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : '—'}
            </td>
            <td className={`py-1.5 pr-2 text-right whitespace-nowrap ${
             t.pnlPct !== undefined
              ? t.pnlPct >= 0 ? 'text-green-400' : 'text-red-400'
              : 'text-gray-600'
            }`}>
             {t.pnlPct !== undefined ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%` : '—'}
            </td>
            <td className="py-1.5 text-right text-gray-500 whitespace-nowrap">
             {t.heldDays !== undefined ? `${t.heldDays}d` : '—'}
            </td>
           </tr>
          ))}
         </tbody>
        </table>
       </div>
       {filteredTrades.filter(t => t.reason).length > 0 && (
        <div className="mt-2 text-[10px] text-gray-600">
         {filteredTrades.filter(t => t.reason).slice(0, 5).map((t, i) => (
          <div key={i} className="truncate">
           {t.date} {t.code}: {t.reason}
          </div>
         ))}
         {filteredTrades.filter(t => t.reason).length > 5 && (
          <div className="text-gray-700">...also {filteredTrades.filter(t => t.reason).length - 5} itemsNotes</div>
         )}
        </div>
       )}
      </Section>
     )}
    </div>
   )}
  </div>
 )
}
