import { useState, useEffect, useCallback, useRef } from 'react'
import { api, LoginResponse, ScreenRecord, LogEntry } from './api'
import { PluginInfo, FilterResult, SelectedStrategy } from './types'
import PluginPanel from './components/PluginPanel'
import StrategyConfig from './components/StrategyConfig'
import ResultsTable from './components/ResultsTable'
import LoadingSpinner from './components/LoadingSpinner'
import ChatPanel from './components/ChatPanel'
import ResultsModal from './components/ResultsModal'
import BacktestPanel from './components/BacktestPanel'
import DebugPanel from './components/DebugPanel'
import GarudaTerminal from './components/GarudaTerminal'

type Tab = 'config' | 'results' | 'history' | 'logs' | 'backtest' | 'debug' | 'garuda'

const RESULTS_KEY = 'stock-screen-results'
const TAB_KEY = 'stock-screen-tab'

function loadJson<T>(key: string, fallback: T): T {
  try { const saved = localStorage.getItem(key); if (saved) return JSON.parse(saved) } catch {}
  return fallback
}
function saveJson(key: string, value: any) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

export default function App() {
  // Auth
  const [user, setUser] = useState<LoginResponse['user'] | null>(null)
  const [token, setToken] = useState<string | null>(() => { try { return localStorage.getItem('auth-token') } catch { return null } })
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [loginError, setLoginError] = useState('')

  // Data
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [selected, setSelected] = useState<SelectedStrategy[]>([])
  const [results, setResults] = useState<FilterResult[]>(() => loadJson(RESULTS_KEY, []))
  const [stats, setStats] = useState(() => loadJson('stock-screen-stats', { totalStocks: 0, matchedStocks: 0, executionTime: 0 }))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>(() => loadJson(TAB_KEY, 'config'))
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking')
  const [agentHighlight, setAgentHighlight] = useState<string | null>(null)
  const highlightTimeout = useRef<ReturnType<typeof setTimeout>>()

  // Modal for AI screen results
  const [modalData, setModalData] = useState<{
    results: FilterResult[]
    stats: { totalStocks: number; matchedStocks: number; executionTime: number }
    strategyLabels: string
  } | null>(null)

  // History & logs
  const [screens, setScreens] = useState<ScreenRecord[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [expandedScreen, setExpandedScreen] = useState<string | null>(null)

  // ===== Auth =====
  // Try to restore session on mount
  useEffect(() => {
    if (!token) { setBackendStatus('online'); return }
    api.me().then(res => {
      setUser(res.user)
    }).catch(() => {
      localStorage.removeItem('auth-token')
      setToken(null)
    })
  }, [token])

  // Check backend health
  useEffect(() => {
    api.health()
      .then(() => setBackendStatus('online'))
      .catch(() => setBackendStatus('offline'))
  }, [])

  // Load plugins (only when logged in)
  useEffect(() => {
    if (backendStatus !== 'online' || !user) return
    api.getPlugins()
      .then(res => setPlugins(res.plugins))
      .catch(err => setError(`Failed to load plugins: ${err.message}`))
  }, [backendStatus, user])

  // Load user config from server on login
  useEffect(() => {
    if (!user) return
    api.getUserConfig()
      .then(config => {
        if (config.selectedStrategies.length > 0) {
          // Map server config (missing pluginName/paramsDef) to SelectedStrategy
          const mapped: SelectedStrategy[] = config.selectedStrategies.map(cfg => {
            // Find matching plugin+strategy for paramsDef
            for (const p of plugins) {
              for (const s of p.strategies) {
                if (s.pluginId === cfg.pluginId && s.id === cfg.strategyId) {
                  return {
                    pluginId: cfg.pluginId,
                    strategyId: cfg.strategyId,
                    pluginName: p.name,
                    strategyName: cfg.strategyName || s.name,
                    params: cfg.params,
                    paramsDef: s.params,
                  }
                }
              }
            }
            // Fallback: use config as-is
            return {
              pluginId: cfg.pluginId,
              strategyId: cfg.strategyId,
              pluginName: '',
              strategyName: cfg.strategyName || cfg.strategyId,
              params: cfg.params,
              paramsDef: [],
            }
          })
          setSelected(mapped)
        }
      })
      .catch(() => {})
  }, [user, plugins])

  // Save config to server when selected strategies change
  const configSaveTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (!user || selected.length === 0) return
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current)
    configSaveTimer.current = setTimeout(() => {
      // Strip frontend-only fields before saving to server
      const serverConfig = selected.map(s => ({
        pluginId: s.pluginId,
        strategyId: s.strategyId,
        strategyName: s.strategyName,
        params: s.params,
      }))
      api.saveUserConfig({ selectedStrategies: serverConfig, preferences: {} }).catch(() => {})
    }, 1000)
  }, [selected, user])

  // Persist results to localStorage
  useEffect(() => { saveJson(RESULTS_KEY, results) }, [results])
  useEffect(() => { saveJson('stock-screen-stats', stats) }, [stats])
  useEffect(() => { saveJson(TAB_KEY, tab) }, [tab])

  // Load history/logs when tab changes to them
  useEffect(() => {
    if (!user) return
    if (tab === 'history') {
      api.getScreens(20).then(r => setScreens(r.screens)).catch(() => {})
    }
    if (tab === 'logs') {
      api.getLogs(50).then(r => setLogs(r.logs)).catch(() => {})
    }
  }, [tab, user])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError('')
    try {
      const res = await api.login(loginForm.username, loginForm.password)
      localStorage.setItem('auth-token', res.token)
      setToken(res.token)
      setUser(res.user)
      setLoginForm({ username: '', password: '' })
    } catch (err: any) {
      setLoginError(err.message || 'Login failed')
    }
  }

  const handleLogout = async () => {
    if (token) {
      try { await api.logout(token) } catch {}
    }
    localStorage.removeItem('auth-token')
    setToken(null)
    setUser(null)
    setSelected([])
    setResults([])
    setScreens([])
    setLogs([])
  }

  const addStrategy = useCallback((item: SelectedStrategy) => {
    setSelected(prev => [...prev, item])
  }, [])

  const removeStrategy = useCallback((index: number) => {
    setSelected(prev => prev.filter((_, i) => i !== index))
  }, [])

  const updateParams = useCallback((index: number, params: Record<string, any>) => {
    setSelected(prev => prev.map((s, i) => i === index ? { ...s, params } : s))
  }, [])

  const runScreen = useCallback(async () => {
    if (selected.length === 0) {
      setError('Please select at least one strategy')
      return
    }
    setLoading(true)
    setError('')
    setTab('results')

    try {
      const res = await api.screen({
        strategies: selected.map(s => ({
          pluginId: s.pluginId,
          strategyId: s.strategyId,
          params: s.params,
        })),
      })
      setResults(res.results)
      setStats(res.stats)
    } catch (err: any) {
      setError(`Screening failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [selected])

  const handleAgentAction = useCallback((action: string, payload: any) => {
    switch (action) {
      case 'switch_tab':
        if (payload.tab === 'config' || payload.tab === 'results') {
          setTab(payload.tab)
        }
        break
      case 'run_screen':
        setError('')
        if (payload.results && payload.stats) {
          // Use results from backend (AI's run_screen tool)
          setResults(payload.results)
          setStats(payload.stats)
          // Show popup modal with stock data + East Money links
          const labels = (payload.strategies || []).map((s: any) => s.strategyName || s.strategyId).join(', ')
          setModalData({
            results: payload.results,
            stats: payload.stats,
            strategyLabels: labels || 'AI Screening',
          })
          setTab('results')
        } else if (payload.strategies && payload.strategies.length > 0) {
          // Legacy: no results in payload, call API again
          setLoading(true)
          setTab('results')
          const newSelected = payload.strategies.map((s: any) => ({
            pluginId: s.pluginId,
            strategyId: s.strategyId,
            strategyName: s.strategyName || s.strategyId,
            params: s.params || {},
          }))
          setSelected(newSelected)
          api.screen({
            strategies: newSelected.map((s: any) => ({
              pluginId: s.pluginId,
              strategyId: s.strategyId,
              params: s.params || {},
            })),
          }).then(res => {
            setResults(res.results)
            setStats(res.stats)
          }).catch((err: any) => {
            setError(`Screening failed: ${err.message}`)
          }).finally(() => {
            setLoading(false)
          })
        } else {
          runScreen()
        }
        break
      case 'set_highlight':
        setAgentHighlight(payload.message || 'AI Action')
        if (highlightTimeout.current) clearTimeout(highlightTimeout.current)
        highlightTimeout.current = setTimeout(() => setAgentHighlight(null), 3000)
        break
    }
  }, [runScreen])

  // ===== Login / Offline / Checking screens =====
  if (backendStatus === 'offline') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center text-gray-400">
          <div className="text-6xl mb-4">🔌</div>
          <div className="text-xl font-semibold mb-2">Backend Offline</div>
          <div className="text-sm">Please check if backend service is running</div>
        </div>
      </div>
    )
  }

  if (backendStatus === 'checking') {
    return <LoadingSpinner message="Connecting to backend..." />
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stock-bg">
        <form onSubmit={handleLogin} className="bg-stock-card border border-gray-800 rounded-xl p-8 w-full max-w-md">
          <div className="text-center mb-6">
            <span className="text-5xl block mb-2">📈</span>
            <h1 className="text-2xl font-bold text-white">Stock Navigator</h1>
            <p className="text-gray-500 text-sm mt-1">Login to continue</p>
          </div>
          {loginError && (
            <div className="bg-red-900/50 border border-red-800 text-red-200 text-sm px-4 py-2 rounded-lg mb-4">{loginError}</div>
          )}
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Username</label>
              <input
                type="text"
                value={loginForm.username}
                onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-200 text-sm outline-none focus:border-blue-500"
                placeholder="Enter username"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={loginForm.password}
                onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-200 text-sm outline-none focus:border-blue-500"
                placeholder="Enter password"
              />
            </div>
            <button
              type="submit"
              disabled={!loginForm.username || !loginForm.password}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2.5 rounded-lg font-medium text-sm transition"
            >
              Login
            </button>
          </div>
        </form>
      </div>
    )
  }

  // ===== Main App =====
  return (
    <div className="min-h-screen bg-stock-bg">
      {/* Header */}
      <header className="border-b border-gray-800 bg-stock-card px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">📈</span>
            <h1 className="text-xl font-bold text-white">SClaw</h1>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
              Plugin · {plugins.length} plugins
            </span>
          </div>
          <div className="flex items-center gap-4">
            {/* Tabs */}
            <div className="flex bg-gray-800 rounded-lg overflow-hidden">
              <button onClick={() => setTab('config')}
                className={`px-3 py-2 text-sm font-medium transition ${tab === 'config' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                Strategy
              </button>
              <button onClick={() => setTab('results')}
                className={`px-3 py-2 text-sm font-medium transition ${tab === 'results' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                Results{results.length > 0 && <span className="ml-1.5 text-xs bg-gray-700 px-1.5 py-0.5 rounded">{results.length}</span>}
              </button>
              <button onClick={() => setTab('history')}
                className={`px-3 py-2 text-sm font-medium transition ${tab === 'history' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                History
              </button>
              <button onClick={() => setTab('logs')}
                className={`px-3 py-2 text-sm font-medium transition ${tab === 'logs' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                Logs
              </button>
              <button onClick={() => setTab('backtest')}
                className={`px-3 py-2 text-sm font-medium transition ${tab === 'backtest' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                📊 Backtest
              </button>
              {user.role === 'admin' && (
                <button onClick={() => setTab('debug')}
                  className={`px-3 py-2 text-sm font-medium transition ${tab === 'debug' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                  🐛 Debug
                </button>
              )}
              {user.role === 'admin' && (
                <button onClick={() => setTab('garuda')}
                  className={`px-3 py-2 text-sm font-medium transition ${tab === 'garuda' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                  🔌 Garuda
                </button>
              )}
            </div>

            {/* User info */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">{user.displayName}</span>
              <span className="text-xs text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{user.role}</span>
              <button onClick={handleLogout} className="text-xs text-gray-500 hover:text-red-400 transition">Logout</button>
            </div>

            {/* AI indicator */}
            <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-all duration-500 ${
              agentHighlight
                ? 'bg-green-600/30 text-green-300 border border-green-500/50'
                : 'bg-gray-800 text-gray-400 border border-gray-700'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${agentHighlight ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
              <span>🧠 AI Assistant</span>
            </div>

            <button
              onClick={runScreen}
              disabled={loading || selected.length === 0}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-6 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2"
            >
              {loading ? <><span className="loading-dot">●</span><span className="loading-dot">●</span><span className="loading-dot">●</span></> : '🚀 Run Screening'}
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      {tab === 'debug' && user.role === 'admin' ? (
        <div className="h-[calc(100vh-73px)] overflow-y-auto">
          <DebugPanel onBack={() => setTab('config')} />
        </div>
      ) : tab === 'garuda' && user.role === 'admin' ? (
        <div className="h-[calc(100vh-73px)] overflow-hidden">
          <GarudaTerminal onBack={() => setTab('config')} />
        </div>
      ) : (
      <div className="flex h-[calc(100vh-73px)] overflow-hidden">
        <div className={`flex-1 overflow-y-auto p-6 transition-all duration-300 ${agentHighlight ? 'ring-2 ring-green-500/40 ring-inset' : ''}`}>
          {error && (
            <div className="bg-red-900/50 border border-red-800 px-4 py-3 text-sm text-red-200 text-center rounded-lg mb-4 flex items-center justify-center gap-2">
              <span>{error}</span>
              <button onClick={() => setError('')} className="text-red-400 hover:text-white">✕</button>
            </div>
          )}

          {tab === 'config' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1">
                <PluginPanel plugins={plugins} selected={selected} onAdd={addStrategy} onRemove={removeStrategy} />
              </div>
              <div className="lg:col-span-2">
                <StrategyConfig selected={selected} onUpdateParams={updateParams} onRemove={removeStrategy} onRun={runScreen} loading={loading} />
              </div>
            </div>
          )}

          {tab === 'results' && (
            <ResultsTable results={results} stats={stats} loading={loading} />
          )}

          {tab === 'history' && (
            <div className="max-w-4xl mx-auto space-y-3">
              <h2 className="text-lg font-semibold text-white mb-4">Screening History</h2>
              {screens.length === 0 ? (
                <div className="text-center text-gray-500 py-12">No screening history yet</div>
              ) : (
                screens.map(s => (
                  <div key={s.id} className="bg-stock-card border border-gray-800 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm text-gray-300">
                        <span className="font-medium">{new Date(s.timestamp).toLocaleString('en-US')}</span>
                      </div>
                      <div className="flex gap-3 text-xs text-gray-500">
                        <span>{s.strategies.length} strategies</span>
                        <span>Matched {s.stats.matchedStocks}</span>
                        <span>{s.stats.executionTime}ms</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {s.strategies.map((st, i) => (
                        <span key={i} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">{st.strategyId}</span>
                      ))}
                    </div>
                    {s.topResults.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {s.topResults.slice(0, 5).map(r => (
                          <span key={r.code} className="text-xs bg-blue-900/30 text-blue-300 px-2 py-0.5 rounded">{r.code} {r.name}</span>
                        ))}
                        {s.resultCount > 5 && <span className="text-xs text-gray-600 px-1 py-0.5">+{s.resultCount - 5}</span>}
                      </div>
                    )}
                    <button
                      onClick={() => setExpandedScreen(expandedScreen === s.id ? null : s.id)}
                      className="text-xs text-blue-400 hover:text-blue-300 mt-2"
                    >
                      {expandedScreen === s.id ? 'Collapse' : 'Show all results'}
                    </button>
                    {expandedScreen === s.id && s.topResults.length > 0 && (
                      <div className="mt-2 space-y-1 border-t border-gray-800 pt-2">
                        {s.topResults.map(r => (
                          <div key={r.code} className="text-xs text-gray-400 flex gap-2">
                            <span className="text-blue-300 w-20">{r.code}</span>
                            <span className="w-20">{r.name}</span>
                            <span className="text-yellow-400 w-10">Score:{r.score}</span>
                            <span className="text-gray-500">{r.signals.slice(0, 3).join(', ')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'logs' && (
            <div className="max-w-4xl mx-auto">
              <h2 className="text-lg font-semibold text-white mb-4">Activity Logs</h2>
              {logs.length === 0 ? (
                <div className="text-center text-gray-500 py-12">No activity logs yet</div>
              ) : (
                <div className="space-y-1">
                  {logs.map(l => (
                    <div key={l.id} className="flex items-start gap-3 text-sm px-3 py-2 hover:bg-gray-800/50 rounded">
                      <span className="text-xs text-gray-600 w-16 shrink-0 pt-0.5">
                        {new Date(l.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className={`text-xs w-10 shrink-0 pt-0.5 ${
                        l.type === 'screen' ? 'text-green-400' :
                        l.type === 'chat' ? 'text-blue-400' :
                        l.type === 'strategy' ? 'text-yellow-400' :
                        l.type === 'auth' ? 'text-purple-400' : 'text-gray-500'
                      }`}>{l.type}</span>
                      <span className="text-gray-300 w-20 shrink-0">{l.action}</span>
                      <span className="text-gray-500 truncate">{l.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'backtest' && (
            <div className="max-w-5xl mx-auto">
              <BacktestPanel plugins={plugins} />
            </div>
          )}
        </div>

        {/* Right: AI Chat */}
        <div className="w-[420px] min-w-[350px] border-l border-gray-800 flex flex-col min-h-0">
          <ChatPanel
            onHighlight={setAgentHighlight}
            highlightTimeout={highlightTimeout}
            onAction={handleAgentAction}
            context={{
              currentTab: tab,
              selectedStrategies: selected.map(s => ({
                pluginId: s.pluginId,
                strategyId: s.strategyId,
                strategyName: s.strategyName,
                params: s.params,
              })),
              resultsCount: results.length,
              matchedStocks: stats.matchedStocks,
            }}
          />
        </div>
      </div>
      )}

      {/* AI Results Popup Modal */}
      {modalData && (
        <ResultsModal
          results={modalData.results}
          stats={modalData.stats}
          strategyLabels={modalData.strategyLabels}
          onClose={() => setModalData(null)}
        />
      )}
    </div>
  )
}
