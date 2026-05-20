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
  cells: RegimeCell[][]  // [volIndex][trendIndex]
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
              <th className="pb-2 pr-4">区间</th>
              <th className="pb-2 pr-4 text-right">收益</th>
              <th className="pb-2 pr-4 text-right">基准</th>
              <th className="pb-2 pr-4 text-right">超额</th>
              <th className="pb-2 pr-4 text-right">最大回撤</th>
              <th className="pb-2 text-right">波动率</th>
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
      title={`${cell.regimeLabel}\n日均收益: ${formatPct(cell.return)}\n胜率: ${formatFixed(cell.winRate, 1)}%\n天数: ${cell.dayCount}`}
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
  const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

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
            <td className="px-2 py-1 text-gray-500 text-xs">平均</td>
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
                  title={`${MONTHS[i]}\n日均收益: ${formatPct(m.avgReturn)}\n胜率: ${formatFixed(m.winRate, 1)}%`}
                >
                  <span className={`text-xs font-medium ${m.avgReturn >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                    {formatPct(m.avgReturn)}
                  </span>
                </td>
              )
            })}
          </tr>
          <tr>
            <td className="px-2 py-1 text-gray-500 text-xs">胜率</td>
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
      setError('请至少添加一个策略')
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
        setError(res.error || '回测失败')
      }
    } catch (err: any) {
      setError(`回测失败: ${err.message}`)
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
      <Section title="回测配置">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left: Strategy selection */}
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-gray-400">选择策略插件</span>
              <select
                value={selectedPlugin}
                onChange={e => { setSelectedPlugin(e.target.value); setSelectedStrategy('') }}
                className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
              >
                <option value="">— 选择插件 —</option>
                {plugins.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            {currentPlugin && (
              <label className="block">
                <span className="text-xs text-gray-400">选择策略</span>
                <select
                  value={selectedStrategy}
                  onChange={e => setSelectedStrategy(e.target.value)}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
                >
                  <option value="">— 选择策略 —</option>
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
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-1.5 rounded-lg text-sm transition"
            >
              + 添加到策略列表
            </button>
          </div>

          {/* Right: Parameters */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-gray-400">开始日期</span>
                <input
                  type="date" value={config.startDate}
                  onChange={e => setConfig(c => ({ ...c, startDate: e.target.value }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">结束日期</span>
                <input
                  type="date" value={config.endDate}
                  onChange={e => setConfig(c => ({ ...c, endDate: e.target.value }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-gray-400">初始资金 (¥)</span>
                <input
                  type="number" value={config.initialCapital}
                  onChange={e => setConfig(c => ({ ...c, initialCapital: parseInt(e.target.value) || 100000 }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">最大持仓数</span>
                <input
                  type="number" value={config.maxPositions}
                  onChange={e => setConfig(c => ({ ...c, maxPositions: parseInt(e.target.value) || 5 }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-gray-400">再平衡频率</span>
                <select
                  value={config.rebalanceFrequency}
                  onChange={e => setConfig(c => ({ ...c, rebalanceFrequency: e.target.value }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                >
                  {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">交易佣金</span>
                <input
                  type="number" step="0.0001" value={config.commission}
                  onChange={e => setConfig(c => ({ ...c, commission: parseFloat(e.target.value) || 0.0003 }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-gray-400">基准指数</span>
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
              <div className="text-xs text-gray-500 mb-2">风控设置</div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-gray-400">止损线 (%)</span>
                  <input
                    type="number" value={config.stopLoss ?? ''}
                    onChange={e => setConfig(c => ({ ...c, stopLoss: e.target.value ? parseFloat(e.target.value) : undefined }))}
                    placeholder="-15"
                    className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">止盈线 (%)</span>
                  <input
                    type="number" value={config.takeProfit ?? ''}
                    onChange={e => setConfig(c => ({ ...c, takeProfit: e.target.value ? parseFloat(e.target.value) : undefined }))}
                    placeholder="50"
                    className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                  />
                </label>
              </div>
              <label className="block mt-2">
                <span className="text-xs text-gray-400">滑点模型</span>
                <select
                  value={config.slippageModel ?? 'fixed'}
                  onChange={e => setConfig(c => ({ ...c, slippageModel: e.target.value }))}
                  className="w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
                >
                  <option value="none">无滑点（理想化）</option>
                  <option value="fixed">固定滑点 0.1%</option>
                  <option value="volume">成交量比例滑点</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        {/* Selected strategies list */}
        {config.strategies.length > 0 && (
          <div className="mt-4">
            <div className="text-xs text-gray-500 mb-2">已选策略 ({config.strategies.length})</div>
            <div className="flex flex-wrap gap-2">
              {config.strategies.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 bg-blue-900/30 border border-blue-700/50 px-2.5 py-1 rounded-full text-xs text-blue-300">
                  {getPluginName(s.pluginId)}/{s.strategyId}
                  <button onClick={() => removeStrategyFromConfig(i)} className="text-blue-400 hover:text-red-400 ml-1">&times;</button>
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
            {loading ? '⏳ 回测中...' : '📊 开始回测'}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </Section>

      {/* Results */}
      {result && (
        <div ref={resultRef} className="space-y-6">
          {/* Summary Metrics */}
          <Section title="绩效指标">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <MetricCard label="总收益率" value={formatPct(result.summary.totalReturn)} color={result.summary.totalReturn >= 0 ? 'green' : 'red'} />
              <MetricCard label="年化收益率" value={formatPct(result.summary.annualizedReturn)} color={result.summary.annualizedReturn >= 0 ? 'green' : 'red'} />
              <MetricCard label="最大回撤" value={formatPct(result.summary.maxDrawdown)} color="red" />
              <MetricCard label="夏普比率" value={formatFixed(result.summary.sharpeRatio)} color={result.summary.sharpeRatio >= 1 ? 'green' : result.summary.sharpeRatio >= 0 ? 'neutral' : 'red'} />
              <MetricCard label="波动率" value={formatPct(result.summary.volatility)} />
              <MetricCard label="胜率" value={formatPct(result.summary.winRate)} color={result.summary.winRate >= 50 ? 'green' : 'red'} />
              <MetricCard label="盈亏比" value={formatFixed(result.summary.profitFactor)} color={result.summary.profitFactor >= 2 ? 'green' : result.summary.profitFactor >= 1 ? 'neutral' : 'red'} />
              <MetricCard label="交易次数" value={String(result.summary.totalTrades)} />
              <MetricCard label="最终权益" value={`¥${(result.summary.finalCapital ?? 0).toLocaleString()}`} color={result.summary.finalCapital >= 100000 ? 'green' : 'red'} />
            </div>
          </Section>

          {/* Benchmark Comparison */}
          <Section title="基准对比">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="基准收益率" value={formatPct(result.summary.benchmarkReturn)} color={result.summary.benchmarkReturn !== null && result.summary.benchmarkReturn >= 0 ? 'green' : 'red'} />
              <MetricCard label="超额收益" value={formatPct(result.summary.excessReturn)} color={result.summary.excessReturn !== null && result.summary.excessReturn >= 0 ? 'green' : 'red'} />
              <MetricCard label="Alpha" value={formatFixed(result.summary.alpha)} color={result.summary.alpha !== null && result.summary.alpha > 0 ? 'green' : 'red'} />
              <MetricCard label="Beta" value={formatFixed(result.summary.beta)} />
              <MetricCard label="Calmar 比率" value={formatFixed(result.summary.calmarRatio)} color={result.summary.calmarRatio !== null && result.summary.calmarRatio >= 2 ? 'green' : result.summary.calmarRatio !== null && result.summary.calmarRatio >= 0 ? 'neutral' : 'red'} />
              <MetricCard label="信息比率" value={formatFixed(result.summary.informationRatio)} color={result.summary.informationRatio !== null && result.summary.informationRatio >= 1 ? 'green' : result.summary.informationRatio !== null && result.summary.informationRatio >= 0 ? 'neutral' : 'red'} />
              <MetricCard label="最大连续亏损" value={result.summary.maxConsecutiveLosses !== null ? `${result.summary.maxConsecutiveLosses} 天` : '—'} color="red" />
            </div>
          </Section>

          {/* Equity Curve Chart */}
          {chartData.length > 0 && (
            <Section title="净值曲线">
              {/* Chart controls */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-gray-500">显示：</span>
                {(['both', 'strategy', 'benchmark'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setChartView(v)}
                    className={`text-xs px-2.5 py-1 rounded-full transition ${
                      chartView === v ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {v === 'both' ? '全部' : v === 'strategy' ? '策略' : '基准'}
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
                <text x={chartW - 95} y={14} fill="#22c55e" fontSize={11}>策略</text>
                {showBenchmark && (
                  <>
                    <line x1={chartW - 120} y1={25} x2={chartW - 100} y2={25} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
                    <text x={chartW - 95} y={29} fill="#f59e0b" fontSize={11}>基准</text>
                  </>
                )}
              </svg>
            </Section>
          )}

          {/* Period Breakdown */}
          {result.periods && result.periods.length > 0 && (
            <Section title="各期收益">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 text-xs uppercase">
                      <th className="pb-2 pr-4">日期</th>
                      <th className="pb-2 pr-4">策略收益</th>
                      <th className="pb-2 pr-4">基准收益</th>
                      <th className="pb-2">超额</th>
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
            <Section title="多时间维度分析">
              <TimeframeTable title="年度" data={result.timeframeAnalysis.yearly} />
              <TimeframeTable title="季度" data={result.timeframeAnalysis.quarterly} />
              <TimeframeTable title="月度" data={result.timeframeAnalysis.monthly} />
            </Section>
          )}

          {/* Tech Tree: Regime Heatmap + Monthly Seasonality */}
          {result.techTree && (
            <Section title="技术树分析">
              <div className="mb-6">
                <h4 className="text-xs text-gray-500 mb-3 uppercase tracking-wider">市场状态热力图</h4>
                <RegimeHeatmapView heatmap={result.techTree.regimeHeatmap} />
                <p className="text-[10px] text-gray-600 mt-2">
                  横轴：趋势（强熊→弱熊→震荡→弱牛→强牛）
                  · 纵轴：波动（低波→中波→高波）
                  · 颜色越深，日均收益越大（绿涨红跌）
                </p>
              </div>
              <div>
                <h4 className="text-xs text-gray-500 mb-3 uppercase tracking-wider">月度效应</h4>
                <MonthlySeasonalityView data={result.techTree.monthlySeasonality} />
                <p className="text-[10px] text-gray-600 mt-2">
                  每格显示该月日均收益 · 第二行为历史月度胜率 · 颜色越深，绝对值越大
                </p>
              </div>
            </Section>
          )}

          {/* Trade Detail Table */}
          {filteredTrades.length > 0 && (
            <Section title={`交易明细 (${enhancedTrades.length})`}>
              {/* Trade Stats Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <MetricCard label="买入笔数" value={`${tradeStats.buys}`} color="neutral" />
                <MetricCard label="卖出笔数" value={`${tradeStats.sells}`} color="neutral" />
                <MetricCard label="总买入额" value={`¥${tradeStats.totalBuyAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color="neutral" />
                <MetricCard
                  label="交易盈亏"
                  value={`${tradeStats.totalPnL >= 0 ? '+' : ''}¥${tradeStats.totalPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  color={tradeStats.totalPnL >= 0 ? 'green' : 'red'}
                />
              </div>
              {tradeStats.winTrades + tradeStats.loseTrades > 0 && (
                <div className="flex items-center gap-2 mb-4 text-xs text-gray-500">
                  <span>胜: <span className="text-green-400">{tradeStats.winTrades}</span></span>
                  <span>负: <span className="text-red-400">{tradeStats.loseTrades}</span></span>
                  <span>胜率: <span className={`${tradeStats.winTrades >= tradeStats.loseTrades ? 'text-green-400' : 'text-red-400'}`}>
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
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {f === 'all' ? '全部' : f === 'buy' ? '买入' : '卖出'}
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
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {s === 'date' ? '日期' : '代码'}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={tradeSearch}
                  onChange={e => setTradeSearch(e.target.value)}
                  placeholder="搜索代码/名称..."
                  className="flex-1 min-w-[120px] bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600"
                />
                <span className="text-xs text-gray-600">{filteredTrades.length} 条</span>
              </div>

              {/* Trade Table */}
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500 border-b border-gray-700 sticky top-0 bg-stock-card z-10">
                    <tr>
                      <th className="pb-2 pr-2 text-left">日期</th>
                      <th className="pb-2 pr-2 text-left">操作</th>
                      <th className="pb-2 pr-2 text-left">代码</th>
                      <th className="pb-2 pr-2 text-left">名称</th>
                      <th className="pb-2 pr-2 text-right">价格</th>
                      <th className="pb-2 pr-2 text-right">数量</th>
                      <th className="pb-2 pr-2 text-right">金额</th>
                      <th className="pb-2 pr-2 text-right">盈亏</th>
                      <th className="pb-2 pr-2 text-right">收益率</th>
                      <th className="pb-2 text-right">持有</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.map((t, i) => (
                      <tr key={i} className="border-t border-gray-800/50 hover:bg-gray-800/40">
                        <td className="py-1.5 pr-2 text-gray-400 whitespace-nowrap">{t.date}</td>
                        <td className={`py-1.5 pr-2 font-medium whitespace-nowrap ${
                          t.type === 'buy' ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {t.type === 'buy' ? '买入' : '卖出'}
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
                    <div className="text-gray-700">...还有 {filteredTrades.filter(t => t.reason).length - 5} 条备注</div>
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
