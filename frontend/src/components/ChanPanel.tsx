import { useState, useEffect, useMemo, useRef, useCallback } from 'react'

// ========== 类型（与后端 chan/types.ts 对应） ==========
export interface KLine {
  date: string; open: number; high: number; low: number; close: number; volume: number
}
export interface Fractal {
  type: 'top' | 'bottom'; idx: number; high: number; low: number; strength?: number
}
export interface Bi {
  direction: 'up' | 'down'; startIdx: number; endIdx: number
  startPrice: number; endPrice: number; high: number; low: number
}
export interface ZhongShu {
  zg: number; zd: number; gg: number; dd: number
  startIdx: number; endIdx: number; direction: string
}
export interface TradePoint {
  type: 'B1' | 'B2' | 'B3' | 'S1' | 'S2' | 'S3'
  idx: number; price: number; date: string; strength: number; note: string
}
export interface ChanAnalysis {
  code: string; name?: string; level: 'daily' | 'm30' | 'm60'
  klines: KLine[]; fractals: Fractal[]; bis: Bi[]; segments: any[]
  zhongshus: ZhongShu[]; tradePoints: TradePoint[]; divergences: any[]
  macd: { dif: number; dea: number; macd: number }[]
  trend: 'up' | 'down' | 'side'; lastPrice: number; lastDate: string
  summary: {
    biCount: number; segmentCount: number; zhongshuCount: number
    buyPoints: number; sellPoints: number; currentTrend: string; signals: string[]
  }
}

// ========== 工具函数 ==========
const fmt = (n: number, d = 2) => n.toFixed(d)
const TP_COLORS: Record<string, string> = {
  B1: '#ff4d4f', B2: '#ff7a45', B3: '#faad14',
  S1: '#52c41a', S2: '#73d13d', S3: '#b7eb8f',
}
const TP_LABEL: Record<string, string> = {
  B1: '一买', B2: '二买', B3: '三买', S1: '一卖', S2: '二卖', S3: '三卖',
}

// ========== 主组件 ==========
export default function ChanPanel({ onBack, initialCode }: { onBack?: () => void; initialCode?: string }) {
  const [code, setCode] = useState(initialCode || '600519')
  const [level, setLevel] = useState<'daily' | 'm30' | 'm60'>('daily')
  const [limit, setLimit] = useState(200)
  const [data, setData] = useState<ChanAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  // 视口缩放：显示最近 viewN 根（滚轮/按钮调整，不重新请求）
  const [viewN, setViewN] = useState(200)
  const svgRef = useRef<SVGSVGElement>(null)
  // 请求序号：防止快速切换级别/股票时旧响应覆盖新响应（竞态）
  const fetchSeq = useRef(0)

  const fetchData = useCallback(async () => {
    if (!code.trim()) return
    const seq = ++fetchSeq.current
    setLoading(true); setError(''); setData(null)
    try {
      const res = await fetch(`/api/chan/${code.trim()}?level=${level}&limit=${limit}`)
      const json = await res.json()
      if (seq !== fetchSeq.current) return // 过期响应丢弃
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setData(json)
      setViewN(json.klines?.length || 200)
    } catch (e: any) {
      if (seq !== fetchSeq.current) return
      setError(e.message || String(e))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [code, level, limit])

  useEffect(() => { fetchData() }, [fetchData])

  // 外部传入新股票代码时切换（点击选股结果跳转）
  useEffect(() => {
    if (initialCode && initialCode !== code) {
      setCode(initialCode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode])

  // 图表尺寸
  const W = 980, H = 620, MAIN_H = 400, MACD_H = 130, VOL_H = 0
  const padL = 60, padR = 20, padT = 30, gap = 28

  // 计算价格/指标映射
  const view = useMemo(() => {
    if (!data || data.klines.length === 0) return null
    const klines = data.klines.slice(-viewN)
    const n = klines.length
    const offset = data.klines.length - viewN
    const inView = (absIdx: number) => absIdx >= offset && absIdx < offset + viewN
    const inViewRange = (start: number, end: number) => end >= offset && start < offset + viewN
    let minP = Infinity, maxP = -Infinity
    for (const k of klines) {
      minP = Math.min(minP, k.low); maxP = Math.max(maxP, k.high)
    }
    // 只考虑视图内的中枢/买卖点——视图外的会撑大价格轴，导致中枢矩形"超过"K线范围
    for (const z of data.zhongshus) {
      if (!inViewRange(z.startIdx, z.endIdx)) continue
      minP = Math.min(minP, z.zd); maxP = Math.max(maxP, z.zg)
    }
    for (const tp of data.tradePoints) {
      if (!inView(tp.idx)) continue
      minP = Math.min(minP, tp.price); maxP = Math.max(maxP, tp.price)
    }
    const padP = (maxP - minP) * 0.08 || 1
    minP -= padP; maxP += padP

    const slotW = (W - padL - padR) / n
    // 注意：fractals/bis/zhongshus/tradePoints 的 idx 是后端返回的绝对索引（在完整 klines 中的位置）
    // 缩放(viewN<total)时局部索引从 offset 开始，x() 统一接收绝对索引并内部换算
    const x = (absIdx: number) => padL + (absIdx - offset) * slotW + slotW / 2
    const xLocal = (i: number) => x(i + offset) // K线/MACD/悬浮等使用局部索引的调用点
    const y = (p: number) => padT + MAIN_H - ((p - minP) / (maxP - minP)) * MAIN_H
    const bodyH = (o: number, c: number) => Math.max(1, Math.abs(y(o) - y(c)))

    // MACD 范围
    let minM = Infinity, maxM = -Infinity
    for (const m of data.macd) {
      minM = Math.min(minM, m.dif, m.dea, m.macd); maxM = Math.max(maxM, m.dif, m.dea, m.macd)
    }
    const padM = (maxM - minM) * 0.1 || 0.1
    minM -= padM; maxM += padM
    const macdTop = padT + MAIN_H + gap
    const my = (v: number) => macdTop + MACD_H - ((v - minM) / (maxM - minM)) * MACD_H

    // 成交量（0-80px）
    const maxV = Math.max(...klines.map(k => k.volume || 0))
    const volTop = padT + MAIN_H + gap + MACD_H + gap
    const volH = 70
    const vy = (v: number) => volTop + volH - (v / (maxV || 1)) * volH

    return { klines, n, x, xLocal, inView, inViewRange, y, bodyH, my, vy, slotW, minP, maxP, macdTop, volTop, volH, maxV, offset }
  }, [data, viewN])

  // 滚轮缩放 K 线（视口缩放，不重新请求；passive:false 以便 preventDefault）
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const total = data?.klines.length || 200
      setViewN(prev => {
        const next = e.deltaY < 0 ? Math.round(prev * 0.8) : Math.round(prev * 1.25)
        return Math.max(20, Math.min(total, next))
      })
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  }, [data])

  // 鼠标悬浮
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!view) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = e.clientX - rect.left
    const idx = Math.round((px - padL) / view.slotW)
    setHoverIdx(Math.max(0, Math.min(view.n - 1, idx)))
  }

  if (loading && !data) {
    return <div className="flex items-center justify-center h-full text-stock-text-secondary text-sm p-8"><span className="loading-dot">●</span> 缠论分析中...</div>
  }
  if (error && !data) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="text-red-300 text-sm bg-red-900/30 border border-red-800 rounded-lg p-4 mb-4">{error}</div>
        <SearchBar code={code} setCode={setCode} level={level} setLevel={setLevel} limit={limit} setLimit={setLimit} onFetch={fetchData} loading={loading} />
      </div>
    )
  }

  return (
    <div className="p-3 md:p-6 h-full overflow-y-auto">
      {/* 顶部控制栏 */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchBar code={code} setCode={setCode} level={level} setLevel={setLevel} limit={limit} setLimit={setLimit} onFetch={fetchData} loading={loading} />
        {onBack && (
          <button onClick={onBack} className="text-xs text-stock-text-secondary hover:text-bronze transition">← Back</button>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setViewN(prev => Math.max(20, Math.round(prev * 0.8)))} title="放大（滚轮 ↑）"
            className="text-xs text-stock-text-secondary hover:text-bronze border border-stock-border rounded w-6 h-6 leading-none cursor-pointer">＋</button>
          <span className="text-[10px] text-stock-text-secondary font-mono w-16 text-center">{viewN}根</span>
          <button onClick={() => setViewN(prev => Math.min(data?.klines.length || 200, Math.round(prev * 1.25)))} title="缩小（滚轮 ↓）"
            className="text-xs text-stock-text-secondary hover:text-bronze border border-stock-border rounded w-6 h-6 leading-none cursor-pointer">－</button>
        </div>
      </div>

      {error && <div className="text-red-300 text-sm bg-red-900/30 border border-red-800 rounded-lg p-3 mb-3">{error}</div>}

      {data && view && (
        <>
          {/* 摘要卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            <SummaryCard label="股票" value={`${data.name || data.code}`} sub={data.code} />
            <SummaryCard label="级别" value={level === 'daily' ? '日线' : level === 'm30' ? '30分钟' : '60分钟'} sub={`${data.klines.length}根K线`} />
            <SummaryCard label="当前趋势" value={data.summary.currentTrend} sub={data.trend} highlight={data.trend === 'up' ? '#ff4d4f' : data.trend === 'down' ? '#52c41a' : '#faad14'} />
            <SummaryCard label="买卖点" value={`${data.summary.buyPoints}买 / ${data.summary.sellPoints}卖`} sub={`${data.summary.zhongshuCount}中枢`} />
            <SummaryCard label="最新价" value={fmt(data.lastPrice)} sub={data.lastDate} />
          </div>

          {/* 信号列表 */}
          {data.summary.signals.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {data.summary.signals.map((s, i) => (
                <span key={i} className="text-xs bg-stock-hover text-stock-text-secondary px-2 py-1 rounded">{s}</span>
              ))}
            </div>
          )}

          {/* K线主图 + MACD */}
          <div className="bg-stock-card border border-stock-border rounded-lg overflow-x-auto">
            <svg ref={svgRef} width={W} height={H} className="block min-w-[980px]" onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>
              {/* 网格 + 价格轴 */}
              {Array.from({ length: 6 }).map((_, i) => {
                const yy = padT + (MAIN_H / 5) * i
                const p = view.maxP - ((view.maxP - view.minP) / 5) * i
                return (
                  <g key={i}>
                    <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="#2a2a3a" strokeWidth={0.5} strokeDasharray="3 3" />
                    <text x={padL - 8} y={yy + 4} textAnchor="end" fontSize={10} fill="#666">{fmt(p)}</text>
                  </g>
                )
              })}

              {/* 日期分隔线（30/60分钟级别）：每天两条竖线框起来，标注是哪天 */}
              {level !== 'daily' && (() => {
                const groups: { start: number; end: number; date: string }[] = []
                for (let i = 0; i < view.klines.length; i++) {
                  const d = view.klines[i].date.slice(0, 10)
                  const last = groups[groups.length - 1]
                  if (last && last.date === d) last.end = i
                  else groups.push({ start: i, end: i, date: d })
                }
                return groups.map((g, gi) => {
                  const xL = Math.max(view.xLocal(g.start) - view.slotW / 2, padL)
                  const xR = Math.min(view.xLocal(g.end) + view.slotW / 2, W - padR)
                  if (xR - xL < 1) return null
                  return (
                    <g key={gi}>
                      <line x1={xL} x2={xL} y1={padT} y2={padT + MAIN_H} stroke="#4a4a5a" strokeWidth={1} strokeDasharray="2 2" />
                      <line x1={xR} x2={xR} y1={padT} y2={padT + MAIN_H} stroke="#4a4a5a" strokeWidth={1} strokeDasharray="2 2" />
                      <text x={(xL + xR) / 2} y={padT - 8} textAnchor="middle" fontSize={9} fill="#888">{g.date.slice(5)}</text>
                    </g>
                  )
                })
              })()}

              {/* 中枢 */}
              {data.zhongshus.map((z, i) => {
                // 区间重叠判断：只要与视图有交集就渲染（横跨视图的中枢不消失、不顶边界）
                if (!view.inViewRange(z.startIdx, z.endIdx)) return null
                const x1 = Math.max(view.x(z.startIdx) - view.slotW / 2, padL)
                const x2 = Math.min(view.x(z.endIdx) + view.slotW / 2, W - padR)
                if (x2 < padL || x1 > W - padR) return null
                // y 方向 clamp 到主图区域，防止中枢超出 K 线图上下边界
                const y1 = Math.max(view.y(z.zg), padT)
                const y2 = Math.min(view.y(z.zd), padT + MAIN_H)
                if (y2 - y1 < 1) return null
                return (
                  <rect key={i} x={x1} y={y1} width={Math.max(2, x2 - x1)} height={Math.max(2, y2 - y1)}
                    fill="#faad14" fillOpacity={0.08} stroke="#faad14" strokeOpacity={0.5} strokeWidth={1} strokeDasharray="4 2" />
                )
              })}

              {/* K线 */}
              {view.klines.map((k, i) => {
                const cx = view.xLocal(i)
                const up = k.close >= k.open
                const color = up ? '#ff4d4f' : '#52c41a'
                const yOpen = view.y(k.open)
                const yClose = view.y(k.close)
                const yHigh = view.y(k.high)
                const yLow = view.y(k.low)
                return (
                  <g key={i}>
                    <line x1={cx} x2={cx} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} opacity={0.8} />
                    <rect x={cx - view.slotW * 0.28} y={Math.min(yOpen, yClose)} width={view.slotW * 0.56}
                      height={Math.max(1, Math.abs(yOpen - yClose))} fill={up ? color : color} fillOpacity={0.85} />
                  </g>
                )
              })}

              {/* 笔 */}
              {data.bis.map((b, i) => {
                if (!view.inView(b.startIdx) && !view.inView(b.endIdx)) return null
                const x1 = view.x(b.startIdx), x2 = view.x(b.endIdx)
                const y1 = view.y(b.startPrice), y2 = view.y(b.endPrice)
                return <line key={i} x1={x1} x2={x2} y1={y1} y2={y2} stroke={b.direction === 'up' ? '#ff7875' : '#95de64'} strokeWidth={1.5} opacity={0.7} />
              })}

              {/* 分型 */}
              {data.fractals.map((f, i) => {
                if (!view.inView(f.idx)) return null
                const cx = view.x(f.idx)
                const cy = view.y(f.type === 'top' ? f.high : f.low)
                return f.type === 'top' ? (
                  <g key={i} transform={`translate(${cx},${cy})`}>
                    <line x1={-4} x2={4} y1={4} y2={-4} stroke="#ff7875" strokeWidth={1.2} />
                    <line x1={-4} x2={4} y1={-4} y2={4} stroke="#ff7875" strokeWidth={1.2} />
                  </g>
                ) : (
                  <g key={i} transform={`translate(${cx},${cy})`}>
                    <line x1={-4} x2={4} y1={-4} y2={4} stroke="#95de64" strokeWidth={1.2} />
                    <line x1={-4} x2={4} y1={4} y2={-4} stroke="#95de64" strokeWidth={1.2} />
                  </g>
                )
              })}

              {/* 买卖点 */}
              {data.tradePoints.map((tp, i) => {
                if (!view.inView(tp.idx)) return null
                const cx = view.x(tp.idx)
                const cy = view.y(tp.price)
                const color = TP_COLORS[tp.type] || '#faad14'
                const label = TP_LABEL[tp.type] || tp.type
                const isBuy = tp.type.startsWith('B')
                return (
                  <g key={i}>
                    <circle cx={cx} cy={cy} r={8} fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.2} />
                    <text x={cx} y={cy + (isBuy ? 16 : -4)} textAnchor="middle" fontSize={10} fontWeight="bold" fill={color}>{label}</text>
                  </g>
                )
              })}

              {/* 中枢 ZG/ZD 价格标注（置顶，避免被 K 线/笔盖住） */}
              {data.zhongshus.map((z, i) => {
                if (!view.inViewRange(z.startIdx, z.endIdx)) return null
                const x1 = Math.max(view.x(z.startIdx) - view.slotW / 2, padL)
                const x2 = Math.min(view.x(z.endIdx) + view.slotW / 2, W - padR)
                if (x2 < padL || x1 > W - padR) return null
                const y1 = Math.max(view.y(z.zg), padT)
                const y2 = Math.min(view.y(z.zd), padT + MAIN_H)
                if (y2 - y1 < 1) return null
                const wide = x2 - x1 > 70
                return (
                  <g key={i} pointerEvents="none">
                    {/* ZG 标签（框左上内侧） */}
                    <rect x={x1 + 2} y={y1 - 1} width={72} height={12} rx={2} fill="#1a1a28" fillOpacity={0.75} />
                    <text x={x1 + 5} y={y1 + 9} fontSize={9} fontWeight="bold" fill="#faad14">ZG {fmt(z.zg)}</text>
                    {/* ZD 标签（框左下内侧） */}
                    <rect x={x1 + 2} y={y2 - 11} width={72} height={12} rx={2} fill="#1a1a28" fillOpacity={0.75} />
                    <text x={x1 + 5} y={y2 - 2} fontSize={9} fontWeight="bold" fill="#faad14">ZD {fmt(z.zd)}</text>
                    {wide && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + 4} textAnchor="middle" fontSize={10} fill="#faad14" fillOpacity={0.7}>ZS</text>}
                  </g>
                )
              })}

              {/* 十字线 + 悬浮信息 */}
              {hoverIdx !== null && view.klines[hoverIdx] && (
                <g>
                  <line x1={view.xLocal(hoverIdx)} x2={view.xLocal(hoverIdx)} y1={padT} y2={padT + MAIN_H + MACD_H + gap + view.volH + gap} stroke="#666" strokeWidth={0.5} strokeDasharray="3 3" />
                  <g transform={`translate(${Math.min(view.xLocal(hoverIdx) + 12, W - 220)},${padT + 8})`}>
                    <rect x={0} y={0} width={200} height={86} rx={6} fill="#1a1a28" fillOpacity={0.95} stroke="#3a3a4a" />
                    {(() => {
                      const k = view.klines[hoverIdx]
                      return (
                        <>
                          <text x={10} y={16} fontSize={11} fill="#ccc">{k.date}</text>
                          <text x={10} y={32} fontSize={11} fill="#ff7875">开 {fmt(k.open)}</text>
                          <text x={110} y={32} fontSize={11} fill="#95de64">收 {fmt(k.close)}</text>
                          <text x={10} y={48} fontSize={11} fill="#ff7875">高 {fmt(k.high)}</text>
                          <text x={110} y={48} fontSize={11} fill="#95de64">低 {fmt(k.low)}</text>
                          <text x={10} y={64} fontSize={11} fill="#aaa">量 {k.volume || 0}</text>
                          <text x={110} y={64} fontSize={11} fill={data.macd[hoverIdx]?.macd >= 0 ? '#ff7875' : '#95de64'}>MACD {fmt(data.macd[hoverIdx]?.macd || 0)}</text>
                          <text x={10} y={80} fontSize={11} fill="#aaa">DIF {fmt(data.macd[hoverIdx]?.dif || 0)}</text>
                          <text x={110} y={80} fontSize={11} fill="#aaa">DEA {fmt(data.macd[hoverIdx]?.dea || 0)}</text>
                        </>
                      )
                    })()}
                  </g>
                </g>
              )}

              {/* 分界线 */}
              <line x1={padL} x2={W - padR} y1={view.macdTop - 8} y2={view.macdTop - 8} stroke="#3a3a4a" strokeWidth={1} />

              {/* MACD 柱状图 */}
              {data.macd.map((m, i) => {
                const cx = view.xLocal(i)
                const y0 = view.my(0)
                const y1 = view.my(m.macd)
                return <line key={i} x1={cx} x2={cx} y1={y0} y2={y1} stroke={m.macd >= 0 ? '#ff4d4f' : '#52c41a'} strokeWidth={view.slotW * 0.6} opacity={0.7} />
              })}
              {/* DIF/DEA 线 */}
              <polyline points={data.macd.map((m, i) => `${view.xLocal(i)},${view.my(m.dif)}`).join(' ')} fill="none" stroke="#ffd666" strokeWidth={1.2} />
              <polyline points={data.macd.map((m, i) => `${view.xLocal(i)},${view.my(m.dea)}`).join(' ')} fill="none" stroke="#69c0ff" strokeWidth={1.2} />
              {/* MACD 零轴 */}
              <line x1={padL} x2={W - padR} y1={view.my(0)} y2={view.my(0)} stroke="#3a3a4a" strokeWidth={0.5} />
              <text x={padL - 8} y={view.my(0) + 4} textAnchor="end" fontSize={9} fill="#666">0</text>

              {/* MACD 时间轴 */}
              {Array.from({ length: 6 }).map((_, i) => {
                const idx = Math.floor((view.n - 1) / 5 * i)
                if (idx >= view.n) return null
                return <text key={i} x={view.xLocal(idx)} y={H - 6} textAnchor="middle" fontSize={9} fill="#666">{view.klines[idx].date.slice(0, 10)}</text>
              })}
            </svg>
          </div>

          {/* 买卖点列表 */}
          {data.tradePoints.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-stock-text mb-2">买卖点明细 ({data.tradePoints.length})</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-stock-text-secondary border-b border-stock-border">
                      <th className="text-left py-1.5 px-2">类型</th>
                      <th className="text-left py-1.5 px-2">日期</th>
                      <th className="text-right py-1.5 px-2">价格</th>
                      <th className="text-right py-1.5 px-2">强度</th>
                      <th className="text-left py-1.5 px-2">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tradePoints.slice().reverse().slice(0, 15).map((tp, i) => (
                      <tr key={i} className="border-b border-stock-border/40 hover:bg-stock-hover/40">
                        <td className="py-1.5 px-2"><span style={{ color: TP_COLORS[tp.type] }} className="font-semibold">{TP_LABEL[tp.type]}</span></td>
                        <td className="py-1.5 px-2 text-stock-text-secondary">{tp.date}</td>
                        <td className="py-1.5 px-2 text-right text-stock-text">{fmt(tp.price)}</td>
                        <td className="py-1.5 px-2 text-right">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${tp.strength >= 80 ? 'bg-green-900/40 text-green-300' : tp.strength >= 60 ? 'bg-yellow-900/40 text-yellow-300' : 'bg-stock-hover text-stock-text-secondary'}`}>{tp.strength}</span>
                        </td>
                        <td className="py-1.5 px-2 text-stock-text-secondary">{tp.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: string }) {
  return (
    <div className="bg-stock-card border border-stock-border rounded-lg px-4 py-2.5">
      <div className="text-xs text-stock-text-secondary mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-stock-text" style={highlight ? { color: highlight } : undefined}>{value}</div>
      {sub && <div className="text-[10px] text-stock-text-secondary/70 mt-0.5">{sub}</div>}
    </div>
  )
}

function SearchBar({ code, setCode, level, setLevel, limit, setLimit, onFetch, loading }: {
  code: string; setCode: (v: string) => void
  level: 'daily' | 'm30' | 'm60'; setLevel: (v: 'daily' | 'm30' | 'm60') => void
  limit: number; setLimit: (v: number) => void
  onFetch: () => void; loading: boolean
}) {
  const [input, setInput] = useState(code)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { setCode(input.trim()); onFetch() } }}
        placeholder="股票代码，如 600519"
        className="bg-stock-hover border border-stock-border rounded-lg px-3 py-1.5 text-sm text-stock-text w-40 focus:outline-none focus:border-bronze"
      />
      <div className="flex items-center gap-0.5 bg-stock-hover rounded-lg p-0.5">
        {([['daily', '日线'], ['m30', '30分'], ['m60', '60分']] as const).map(([v, label]) => (
          <button key={v} onClick={() => { setLevel(v); setCode(input.trim()) }}
            className={`px-2.5 py-1 text-xs rounded-md transition ${level === v ? 'bg-bronze-glow text-bronze-light' : 'text-stock-text-secondary hover:text-stock-text'}`}>
            {label}
          </button>
        ))}
      </div>
      <select
        value={limit}
        onChange={e => setLimit(Number(e.target.value))}
        className="bg-stock-hover border border-stock-border rounded-lg px-2 py-1.5 text-xs text-stock-text focus:outline-none"
      >
        {[100, 200, 300, 500].map(n => <option key={n} value={n}>{n}根</option>)}
      </select>
      <button onClick={() => { setCode(input.trim()); onFetch() }} disabled={loading}
        className="btn-bronze px-4 py-1.5 rounded-lg text-sm disabled:opacity-50">
        {loading ? '分析中...' : '🔍 分析'}
      </button>
    </div>
  )
}
