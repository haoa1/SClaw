import { useState, useEffect } from 'react'

interface PromptDump {
  fileName: string
  filePath: string
  size: number
  modifiedAt: string
  timestamp: string
  turn: number
  model: string
  messageCount: number
  totalTokens: number
  messages: Array<{ role: string; content: string; reasoning_content?: string; tool_calls?: Array<{ name: string; arguments: any }> }>
  tools: Array<{ name: string; description: string }>
}

interface DebugResponse {
  prompts: PromptDump[]
}

function getAuthToken(): string | null {
  try { return localStorage.getItem('auth-token') } catch { return null }
}

function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = getAuthToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(url, { ...options, headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) } })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return iso }
}

function roleBadge(role: string): { bg: string; text: string; label: string } {
  switch (role) {
    case 'user': return { bg: 'bg-blue-900/50', text: 'text-blue-200', label: 'User' }
    case 'assistant': return { bg: 'bg-green-900/50', text: 'text-green-200', label: 'AI' }
    case 'system': return { bg: 'bg-purple-900/50', text: 'text-purple-200', label: 'System' }
    case 'tool': return { bg: 'bg-yellow-900/50', text: 'text-yellow-200', label: 'Tool' }
    default: return { bg: 'bg-gray-900/50', text: 'text-gray-200', label: role }
  }
}

function MsgView({ msg, index }: { msg: any; index: number }) {
  const badge = roleBadge(msg.role)
  const [expanded, setExpanded] = useState(false)
  const isLong = msg.content && msg.content.length > 500
  const displayContent = isLong && !expanded ? msg.content.slice(0, 500) + '\n...' : msg.content

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div className={`flex items-center gap-2 px-3 py-1.5 ${badge.bg} border-b border-gray-800`}>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badge.bg} ${badge.text}`}>{badge.label}</span>
        <span className="text-gray-500 text-[10px]">#{index + 1}</span>
        {msg.tool_calls && msg.tool_calls.length > 0 && (
          <span className="text-gray-500 text-[10px]">🔧 {msg.tool_calls.length} tool calls</span>
        )}
        {msg.reasoning_content && (
          <span className="text-gray-500 text-[10px]">🤔 has reasoning</span>
        )}
      </div>
      <div className="px-3 py-2">
        {/* Tool calls */}
        {msg.tool_calls && msg.tool_calls.length > 0 && (
          <div className="mb-2 space-y-1">
            {msg.tool_calls.map((tc: any, i: number) => (
              <div key={i} className="text-[10px] font-mono bg-gray-900/60 rounded px-2 py-1">
                <span className="text-cyan-400">🔧 {tc.name}</span>
                <pre className="text-gray-500 mt-0.5 whitespace-pre-wrap">{typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}</pre>
              </div>
            ))}
          </div>
        )}
        {/* Content */}
        {msg.content && (
          <pre className="text-gray-300 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
            {displayContent}
          </pre>
        )}
        {isLong && (
          <button onClick={() => setExpanded(!expanded)} className="text-gray-600 hover:text-gray-400 text-[10px] mt-1 outline-none cursor-pointer">
            {expanded ? '▲ Collapse' : '▼ Expand (' + (msg.content.length / 1000).toFixed(1) + 'K)'}
          </button>
        )}
        {!msg.content && !msg.tool_calls && (
          <span className="text-gray-600 text-[10px] italic">(empty)</span>
        )}
      </div>
    </div>
  )
}

function PromptCard({ dump }: { dump: PromptDump }) {
  const [expanded, setExpanded] = useState(false)
  const [toolsExpanded, setToolsExpanded] = useState(false)

  return (
    <div className="bg-stock-card border border-gray-800 rounded-xl overflow-hidden">
      {/* Header bar — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left cursor-pointer outline-none hover:bg-gray-800/30 transition-colors"
      >
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-gray-400 text-lg">{expanded ? '▼' : '▶'}</span>
            <div className="min-w-0">
              <div className="text-gray-200 text-sm font-medium truncate">{dump.fileName}</div>
              <div className="text-gray-500 text-[10px] mt-0.5">{formatTime(dump.timestamp)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-gray-500 text-[10px] bg-gray-800/80 px-1.5 py-0.5 rounded">#{dump.turn}</span>
            <span className="text-gray-500 text-[10px] bg-gray-800/80 px-1.5 py-0.5 rounded">{dump.model}</span>
            <span className="text-gray-500 text-[10px]">{dump.messageCount} msgs</span>
            <span className="text-gray-500 text-[10px]">{dump.totalTokens} tok</span>
            <span className="text-gray-500 text-[10px]">{formatBytes(dump.size)}</span>
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 space-y-3">
          {/* Tool definitions */}
          {dump.tools && dump.tools.length > 0 && (
            <div>
              <button
                onClick={() => setToolsExpanded(!toolsExpanded)}
                className="text-gray-500 hover:text-gray-300 text-xs font-mono cursor-pointer outline-none"
              >
                {toolsExpanded ? '▼' : '▶'} Tools ({dump.tools.length})
              </button>
              {toolsExpanded && (
                <div className="mt-2 space-y-1">
                  {dump.tools.map((t: any, i: number) => (
                    <div key={i} className="bg-gray-900/40 rounded-lg px-3 py-2 text-xs">
                      <div className="text-cyan-400 font-mono font-medium">{t.name || t.function?.name || 'unnamed'}</div>
                      <div className="text-gray-500 mt-0.5 text-[10px] truncate">{t.description || t.function?.description || ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          <div className="space-y-2">
            <div className="text-gray-500 text-xs font-mono">Messages ({dump.messages.length})</div>
            {dump.messages.map((msg: any, i: number) => (
              <MsgView key={i} msg={msg} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface DebugPanelProps {
  onBack?: () => void
}

export default function DebugPanel({ onBack }: DebugPanelProps) {
  const [prompts, setPrompts] = useState<PromptDump[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    authFetch('/api/debug/prompts')
      .then(res => res.json())
      .then((data: DebugResponse) => {
        setPrompts(data.prompts || [])
      })
      .catch(err => setError(err.message || 'Failed to load debug data'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = search
    ? prompts.filter(p =>
        p.fileName.toLowerCase().includes(search.toLowerCase()) ||
        p.model.toLowerCase().includes(search.toLowerCase()) ||
        String(p.turn).includes(search) ||
        String(p.messageCount).includes(search) ||
        String(p.totalTokens).includes(search)
      )
    : prompts

  return (
    <div className="min-h-screen bg-stock-bg">
      {/* Header */}
      <header className="border-b border-gray-800 bg-stock-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🐛</span>
            <h1 className="text-xl font-bold text-white">Prompt Debug</h1>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
              {prompts.length} dumps
            </span>
          </div>
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="text-gray-500 hover:text-white text-xs font-mono px-3 py-1.5 border border-gray-700 rounded-lg transition-colors cursor-pointer"
              >
                ← Back
              </button>
            )}
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search dumps..."
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-300 text-xs font-mono outline-none focus:border-amber-500 w-48"
            />
            <button
              onClick={() => authFetch('/api/debug/prompts').then(r => r.json()).then((d: DebugResponse) => setPrompts(d.prompts || [])).catch(() => {})}
              className="text-gray-500 hover:text-amber-400 text-xs font-mono px-3 py-1.5 border border-gray-700 rounded-lg transition-colors cursor-pointer"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-5xl mx-auto p-6">
        {loading && (
          <div className="text-center text-gray-500 py-12 text-sm">
            Loading prompt dumps...
          </div>
        )}

        {error && (
          <div className="bg-red-900/50 border border-red-800 text-red-200 text-sm px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">📭</div>
            <div className="text-gray-500 text-sm">
              {search ? 'No dumps match your search' : 'No prompt dumps yet'}
            </div>
            <div className="text-gray-600 text-xs mt-2">
              {!search && 'Send a message with ?debug=true to start collecting prompt dumps'}
            </div>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((dump, i) => (
              <PromptCard key={i} dump={dump} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
