import { useState, useRef, useEffect, useMemo, useCallback, lazy, Suspense } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ChatStockList, { AiStock } from './ChatStockList'

interface ToolCallInfo {
  id: string
  name: string
  arguments: string
}

interface Segment {
  type: 'reasoning' | 'content' | 'tool_call' | 'tool_result'
  data: string  // for tool_call: JSON of ToolCallInfo; for others: plain text
}

interface Message {
  role: 'user' | 'assistant'
  content?: string   // backward compat (old messages without segments)
  toolCalls?: ToolCallInfo[]  // backward compat
  reasoningContent?: string   // backward compat
  segments?: Segment[]
}

interface ChatPanelProps {
  onHighlight?: (msg: string | null) => void
  highlightTimeout?: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>
  onAction?: (action: string, payload: any) => void
  context?: {
    currentTab: string
    selectedStrategies: Array<{ pluginId: string; strategyId: string; strategyName: string; params: Record<string, any> }>
    resultsCount: number
    matchedStocks: number
  }
}

const STORAGE_KEY = 'stock-chat-messages'

function getAuthToken(): string | null {
  try { return localStorage.getItem('auth-token') } catch { return null }
}

function authFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = getAuthToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  // cache: 'no-cache' forces Chrome to always go to the network — no disk cache, no memory cache
  // Combined with Cache-Control headers on the server, this is bulletproof
  return fetch(url, { ...options, cache: 'no-cache', headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) } })
}

/** Convert old flat message format to new segments format */
function convertToSegments(msg: any): Message {
  if (msg.segments && msg.segments.length > 0) return msg as Message
  const segments: Segment[] = []
  // 1. reasoning (if any)
  if (msg.reasoningContent) {
    segments.push({ type: 'reasoning', data: msg.reasoningContent })
  }
  // 2. content before tool_calls (if any)
  if (msg.content && msg.toolCalls?.length) {
    segments.push({ type: 'content', data: msg.content })
  }
  // 3. tool calls (if any)
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      segments.push({ type: 'tool_call', data: JSON.stringify(tc) })
    }
  }
  // 4. content without tool_calls → final answer
  if (msg.content && (!msg.toolCalls || msg.toolCalls.length === 0)) {
    segments.push({ type: 'content', data: msg.content })
  }
  return { role: msg.role, segments }
}

async function loadMessagesFromServer(): Promise<Message[]> {
  try {
    // Cache-busting: _t param ensures Ctrl+R always hits the server, not browser cache
    const res = await authFetch('/api/messages?_t=' + Date.now())
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data.messages) && data.messages.length > 0)
        return data.messages.map(convertToSegments)
    }
  } catch {}
  return [{ role: 'assistant' as const, segments: [{ type: 'content' as const, data: '🦀 SClaw ready — fire a command to hunt' }] }]
}

async function saveMessagesToServer(messages: Message[]) {
  try {
    const safeMsgs = JSON.parse(JSON.stringify(messages))
    await authFetch('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: safeMsgs }),
    })
  } catch {}
}

function loadMessages(): Message[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(convertToSegments)
    }
  } catch {}
  return [{ role: 'assistant', segments: [{ type: 'content', data: '🦀 SClaw ready — fire a command to hunt' }] }]
}

function saveMessages(messages: Message[]) {
  try {
    const safeMsgs = JSON.parse(JSON.stringify(messages))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeMsgs))
  } catch {}
}

export default function ChatPanel({ onHighlight, highlightTimeout, onAction, context }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [loaded, setLoaded] = useState(false)

  // AI 选股结果 — 左侧股票列表（来自 run_screen action）
  const [aiStocks, setAiStocks] = useState<AiStock[]>([])
  const [stockPanelOpen, setStockPanelOpen] = useState(true)
  const [viewingStock, setViewingStock] = useState<AiStock | null>(null)
  const ChanPanel = lazy(() => import('./ChanPanel'))

  // Model switching state
  const [currentModel, setCurrentModel] = useState<string>('deepseek-v4-flash')
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([])
  const [modelSwitchMsg, setModelSwitchMsg] = useState<string | null>(null)

  // Fetch model info on mount
  useEffect(() => {
    authFetch('/api/model/list')
      .then(r => r.json())
      .then(data => {
        if (data.models) setAvailableModels(data.models.map((m: any) => ({ id: m.id, name: m.name })))
      })
      .catch(() => {})
    authFetch('/api/model')
      .then(r => r.json())
      .then(data => {
        if (data.model) setCurrentModel(data.model)
      })
      .catch(() => {})
  }, [])

  const handleModelSwitch = async (modelId: string) => {
    if (modelId === currentModel) return
    try {
      const res = await authFetch('/api/model', {
        method: 'POST',
        body: JSON.stringify({ model: modelId }),
      })
      const data = await res.json()
      if (data.success) {
        setCurrentModel(modelId)
        setModelSwitchMsg(`Switched to ${modelId}`)
        setTimeout(() => setModelSwitchMsg(null), 2500)
      }
    } catch {}
  }

  // Recall/Edit state
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  // Input history (up/down arrow)
  const inputHistory = useRef<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  // Throttle auto-scrolls during streaming — avoid layout thrashing on every token
  const lastScrollTime = useRef(0)
  const SCROLL_THROTTLE_MS = 100

  // Streaming state: ordered segments list + accumulator for reasoning/content fragments
  const streamingSegments = useRef<Segment[]>([])
  const segmentAccum = useRef<{ type: 'reasoning' | 'content'; data: string } | null>(null)

  // Debug prompt state
  const debugPrompts = useRef<Array<{filePath: string; messageCount: number; totalTokens: number; timestamp: string}>>([])
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugCount, setDebugCount] = useState(0)

  function flushSegment() {
    if (segmentAccum.current) {
      streamingSegments.current.push({ ...segmentAccum.current })
      segmentAccum.current = null
    }
  }

  function appendToSegment(type: 'reasoning' | 'content', text: string) {
    if (segmentAccum.current?.type === type) {
      segmentAccum.current.data += text
    } else {
      flushSegment()
      segmentAccum.current = { type, data: text }
    }
  }

  useEffect(() => {
    loadMessagesFromServer().then(serverMessages => {
      if (serverMessages.length > 1 ||
          (serverMessages.length === 1 && serverMessages[0].segments?.[0]?.data !== '🦀 SClaw ready — fire a command to hunt')) {
        // Server has data — use it and sync to localStorage
        setMessages(serverMessages)
        saveMessages(serverMessages)
      } else {
        // Server empty — clear localStorage and show welcome screen
        localStorage.removeItem(STORAGE_KEY)
        setMessages(serverMessages)  // show "Connected, enter command..."
      }
      setLoaded(true)
    })
  }, [])

  // Save to localStorage only (for resilience across refreshes).
  // Don't POST to server — backend already saves compacted history after each agent run.
  // Frontend overwriting server data would undo backend's compact.
  useEffect(() => {
    if (loaded) {
      saveMessages(messages)
    }
  }, [messages, loaded])

  // Track if user has scrolled up (to show/hide scroll-to-bottom button)
  const [isNearBottom, setIsNearBottom] = useState(true)
  // Ref mirror of isNearBottom — lets queued setTimeout scroll callbacks read the LATEST
  // value instead of the stale one captured when the effect ran.
  const isNearBottomRef = useRef(true)
  const setNearBottom = useCallback((v: boolean) => {
    isNearBottomRef.current = v
    setIsNearBottom(v)
  }, [])

  // Auto-scroll to bottom, throttled during streaming to avoid layout thrashing
  useEffect(() => {
    if (!chatRef.current) return
    if (!isNearBottomRef.current) return  // Don't auto-scroll if user scrolled up
    const now = Date.now()
    // Throttle: skip scroll if we just scrolled <200ms ago AND still streaming
    if (streaming && now - lastScrollTime.current < SCROLL_THROTTLE_MS) return
    lastScrollTime.current = now
    // Use setTimeout(0) instead of requestAnimationFrame to ensure DOM is committed.
    // Re-check isNearBottomRef INSIDE the callback: if the user pressed mouse / double-clicked
    // to select text after this effect queued, the pending scroll must be cancelled — otherwise
    // the viewport yanks to bottom mid-selection and breaks copy.
    setTimeout(() => {
      if (chatRef.current && isNearBottomRef.current) {
        chatRef.current.scrollTop = chatRef.current.scrollHeight
      }
    }, 0)
    // Also depend on streaming: when streaming ends (false), always scroll final content
  }, [messages, streaming, isNearBottom])

  // Detect if user scrolls away from bottom
  const handleChatScroll = useCallback(() => {
    if (!chatRef.current) return
    const el = chatRef.current
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setNearBottom(nearBottom)
  }, [setNearBottom])

  // Scroll to bottom and re-enable auto-scroll
  const scrollToBottom = useCallback(() => {
    if (!chatRef.current) return
    chatRef.current.scrollTop = chatRef.current.scrollHeight
    setNearBottom(true)
  }, [setNearBottom])

  // Freeze auto-scroll as soon as the mouse goes DOWN in the message area (left button).
  // Covers single-click, double-click word selection and drag selection. Freezing on
  // mouseup alone is too late: a queued streaming scroll can fire between the two clicks
  // and yank the viewport to bottom mid-selection.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return  // left button only; ignore right/middle clicks
    setNearBottom(false)
  }, [setNearBottom])

  // Belt-and-braces: if selection appears after mouseup (some browsers select late),
  // freeze too. Double-clicking text will hit this path.
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (sel && sel.toString().trim().length > 0) {
      setNearBottom(false)
    }
  }, [setNearBottom])

  useEffect(() => {
    if (!streaming && inputRef.current) {
      inputRef.current.focus()
    }
  }, [streaming])

  // Throttle setMessages during streaming — avoid layout thrashing on every token
  const lastRenderTime = useRef(0)
  const RENDER_THROTTLE_MS = 50  // 20fps max update rate

  const updatePending = () => {
    // During streaming, throttle React re-renders to 20fps
    // Accumulation in refs (segmentAccum/streamingSegments) is always instant — only the React paint is throttled
    if (streaming) {
      const now = Date.now()
      if (now - lastRenderTime.current < RENDER_THROTTLE_MS) return
      lastRenderTime.current = now
    }
    setMessages(prev => {
      const idx = prev.length - 1
      if (idx < 0) return prev
      // Include the in-progress accumulator segment so tokens render as they arrive
      const snap = segmentAccum.current
        ? [...streamingSegments.current, { ...segmentAccum.current }]
        : [...streamingSegments.current]
      return prev.map((m, i) =>
        i === idx ? { ...m, segments: snap } : m
      )
    })
  }

  /** Clear all chat history (server + localStorage) */
  const handleClear = async () => {
    try {
      await authFetch('/api/clear', { method: 'POST' })
    } catch { /* ignore */ }
    localStorage.removeItem(STORAGE_KEY)
    setMessages([{ role: 'assistant', segments: [{ type: 'content', data: '🦀 SClaw ready — fire a command to hunt' }] }])
  }

  const send = async (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    if (!text || streaming) return

    // Save to input history (avoid dupes, cap at 50)
    inputHistory.current = inputHistory.current.filter(h => h !== text)
    inputHistory.current.push(text)
    if (inputHistory.current.length > 50) inputHistory.current.shift()
    setHistoryIndex(-1)

    setInput('')
    setStreaming(true)

    // Reset streaming state
    streamingSegments.current = []
    segmentAccum.current = null

    if (onHighlight && highlightTimeout) {
      onHighlight('Sending...')
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current)
    }

    setMessages(prev => [...prev, { role: 'user', segments: [{ type: 'content', data: text }] }])
    setMessages(prev => [...prev, { role: 'assistant', segments: [] }])

    const safeContext = context ? JSON.parse(JSON.stringify(context)) : undefined

    try {
      const res = await authFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text, context: safeContext }),
      })

      if (!res.ok) {
        const err = await res.text()
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, segments: [{ type: 'content', data: 'Error: ' + err }] }
            : m
        ))
        setStreaming(false)
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          flushSegment()
          updatePending()
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)

              if (parsed.type === 'token') {
                appendToSegment('content', parsed.content)
                updatePending()
              } else if (parsed.type === 'reasoning') {
                appendToSegment('reasoning', parsed.content)
                updatePending()
              } else if (parsed.type === 'tool_call') {
                flushSegment()
                const tcData = JSON.stringify({
                  id: parsed.id || '',
                  name: parsed.name || '',
                  arguments: parsed.arguments || '',
                })
                streamingSegments.current.push({ type: 'tool_call', data: tcData })
                updatePending()
              } else if (parsed.type === 'tool_result') {
                streamingSegments.current.push({ type: 'tool_result', data: parsed.content || '' })
                updatePending()
              } else if (parsed.type === 'action') {
                // 捕获 AI 选股结果 → 左侧股票列表
                if (parsed.action === 'run_screen' && parsed.payload?.results?.length) {
                  setAiStocks(prev => {
                    const merged = [...prev]
                    for (const r of parsed.payload.results) {
                      if (!merged.some(x => x.code === r.code)) {
                        merged.push({
                          code: r.code,
                          name: r.name || r.code,
                          score: typeof r.score === 'number' ? r.score : 0,
                          signals: Array.isArray(r.signals) ? r.signals : [],
                        })
                      }
                    }
                    return merged
                  })
                  setStockPanelOpen(true)
                }
                if (onAction) onAction(parsed.action, parsed.payload)
              } else if (parsed.type === 'debug_prompt') {
                // Store last 5 prompt dumps for debug panel
                const entry = { filePath: parsed.filePath, messageCount: parsed.messageCount, totalTokens: parsed.totalTokens, timestamp: new Date().toLocaleTimeString() }
                debugPrompts.current = [...debugPrompts.current.slice(-4), entry]
                setDebugCount(prev => prev + 1)
              } else if (parsed.type === 'error') {
                setMessages(prev => prev.map((m, i) =>
                  i === prev.length - 1
                    ? { ...m, segments: [{ type: 'content', data: 'Error: ' + parsed.content }] }
                    : m
                ))
              }
            } catch {}
          }
        }
      }
    } catch (e: any) {
      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1
          ? { ...m, segments: [{ type: 'content', data: 'Error: ' + e.message }] }
          : m
      ))
    }
    setStreaming(false)

    // Fix 1: Auto-cleanup — reload clean compacted history from server
    loadMessagesFromServer().then(serverMessages => {
      if (serverMessages.length > 0) {
        setMessages(serverMessages)
      }
    })

    if (onHighlight && highlightTimeout) {
      onHighlight('AI Response')
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current)
      highlightTimeout.current = setTimeout(() => onHighlight(null), 2000)
    }
  }

  // Also listen on native keydown for browser automation compatibility.
  // agent-browser/Playwright types directly into the DOM, bypassing React's onChange,
  // so React state `input` stays stale. Read the actual DOM value instead.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const nativeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const domValue = inputRef.current?.value || ''
        console.log('[ChatPanel] native Enter, DOM value:', domValue)
        send(domValue)
      }
    }
    el.addEventListener('keydown', nativeHandler)
    return () => el.removeEventListener('keydown', nativeHandler)
  }, [streaming]) // only re-attach on streaming change, NOT on input change

  // ===== SSE listener: auto-refresh chat when scheduled tasks save messages =====
  // Re-connects on auth token change (logout/relogin)
  useEffect(() => {
    const token = getAuthToken()
    if (!token) {
      console.log('[ChatPanel] No auth token, SSE disabled')
      return
    }
    const url = `/api/chat/events?token=${encodeURIComponent(token)}`
    let evtSource: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let mounted = true

    console.log('[ChatPanel] Connecting SSE with token:', token.slice(0, 8) + '...')

    function connect() {
      if (!mounted) return
      evtSource = new EventSource(url)

      evtSource.addEventListener('open', () => {
        if (!mounted) return
        console.log('[ChatPanel] SSE connected')
      })

      evtSource.addEventListener('chat_updated', (e: MessageEvent) => {
        if (!mounted) return
        console.log('[ChatPanel] SSE chat_updated, reloading messages...')
        loadMessagesFromServer().then(serverMessages => {
          if (mounted && serverMessages.length > 0) {
            setMessages(serverMessages)
          }
        })
      })

      evtSource.onerror = () => {
        console.log('[ChatPanel] SSE error, will reconnect in 5s')
        // Clean up and reconnect after 5 seconds
        if (evtSource) {
          evtSource.close()
          evtSource = null
        }
        if (mounted) {
          if (reconnectTimer) clearTimeout(reconnectTimer) // prevent timer leak
          reconnectTimer = setTimeout(connect, 5000)
        }
      }
    }

    connect()

    return () => {
      mounted = false
      if (evtSource) {
        console.log('[ChatPanel] SSE closing (token may have changed)')
        evtSource.close()
      }
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [getAuthToken()]) // reconnect when token changes (login/logout)

  /** Recall a message: truncate from this index, reload from server */
  const handleRecall = async (index: number) => {
    const res = await authFetch('/api/chat/recall', {
      method: 'POST',
      body: JSON.stringify({ index }),
    })
    if (res.ok) {
      const data = await res.json()
      setMessages((data.messages || []).map(convertToSegments))
    }
  }

  /** Edit a message: replace content + truncate after, reload from server */
  const handleEditSave = async (index: number, content: string) => {
    if (!content.trim()) return
    const res = await authFetch('/api/chat/edit', {
      method: 'POST',
      body: JSON.stringify({ index, content: content.trim() }),
    })
    if (res.ok) {
      const data = await res.json()
      setMessages((data.messages || []).map(convertToSegments))
      setEditingIndex(null)
      setEditText('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      console.log('[ChatPanel] React Enter pressed, input:', input, 'streaming:', streaming)
      send()
      return
    }

    // Input history navigation (up/down arrow)
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const hist = inputHistory.current
      if (hist.length === 0) return
      const newIdx = historyIndex === -1 ? hist.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(newIdx)
      setInput(hist[newIdx])
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const hist = inputHistory.current
      if (hist.length === 0 || historyIndex === -1) return
      const newIdx = historyIndex + 1
      if (newIdx >= hist.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(newIdx)
        setInput(hist[newIdx])
      }
    }
  }

  /* ===== Markdown renderer (zero margin on all block elements) ===== */
  const mdComponents: any = {
    h1: ({ children }: any) => <h1 className="m-0 text-base font-bold text-yellow-400">{children}</h1>,
    h2: ({ children }: any) => <h2 className="m-0 text-sm font-bold text-yellow-400">{children}</h2>,
    h3: ({ children }: any) => <h3 className="m-0 text-xs font-semibold text-cyan-400">{children}</h3>,
    h4: ({ children }: any) => <h4 className="m-0 text-xs font-semibold text-cyan-400">{children}</h4>,
    p: ({ children }: any) => <p className="m-0 text-gray-200 text-sm leading-relaxed">{children}</p>,
    strong: ({ children }: any) => <strong className="text-gray-100 font-bold">{children}</strong>,
    em: ({ children }: any) => <em className="italic text-gray-300">{children}</em>,
    code: ({ children, className, inline }: any) => {
      if (inline) {
        return <code className="bg-gray-800 text-yellow-200 text-xs px-1 py-0.5 rounded font-mono m-0">{children}</code>
      }
      return <pre className="bg-[#1a1a2e] text-gray-200 text-[13px] font-mono p-3 rounded border border-gray-700 overflow-auto leading-snug whitespace-pre m-0"><code>{children}</code></pre>
    },
    pre: ({ children }: any) => <pre className="m-0">{children}</pre>,
    table: ({ children }: any) => (
      <table className="m-0 border-collapse w-full text-xs">{children}</table>
    ),
    thead: ({ children }: any) => <thead className="bg-gray-800/80">{children}</thead>,
    th: ({ children }: any) => <th className="m-0 border border-gray-700 px-2.5 py-1.5 text-gray-200 font-semibold text-left whitespace-nowrap">{children}</th>,
    td: ({ children }: any) => <td className="m-0 border border-gray-700 px-2.5 py-1.5 text-gray-300">{children}</td>,
    tr: ({ children }: any) => <tr className="even:bg-gray-900/40">{children}</tr>,
    ul: ({ children }: any) => <ul className="m-0 list-disc pl-4 text-gray-200 text-sm">{children}</ul>,
    ol: ({ children }: any) => <ol className="m-0 list-decimal pl-4 text-gray-200 text-sm">{children}</ol>,
    li: ({ children }: any) => <li className="m-0 leading-normal">{children}</li>,
    blockquote: ({ children }: any) => (
      <blockquote className="m-0 border-l-2 border-cyan-800 pl-3 text-gray-400 text-sm italic">{children}</blockquote>
    ),
    a: ({ href, children }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline m-0">{children}</a>
    ),
    hr: () => <hr className="m-0 border-gray-800" />,
  }

  /** Strip inline margin styles from raw HTML in markdown content */
  function stripInlineMargins(text: string): string {
    return text.replace(/style="([^"]*)"/g, (_m: string, styles: string) => {
      const cleaned = styles
        .replace(/\bmargin\s*:\s*[^;]+;?/gi, '')
        .replace(/\bmargin-top\s*:\s*[^;]+;?/gi, '')
        .replace(/\bmargin-bottom\s*:\s*[^;]+;?/gi, '')
        .replace(/\bmargin-left\s*:\s*[^;]+;?/gi, '')
        .replace(/\bmargin-right\s*:\s*[^;]+;?/gi, '')
        .trim()
      return cleaned ? `style="${cleaned}"` : ''
    })
  }

  /** Markdown content with long-content collapsible wrapper */
  function MarkdownContent({ data }: { data: string }) {
    const [expanded, setExpanded] = useState(false)
    const isLong = data.length > 5000
    const displayData = isLong && !expanded ? data.slice(0, 5000) + '\n...' : data
    // Strip inline margins from AI-generated HTML before rendering
    const sanitized = stripInlineMargins(displayData)

    return (
      <div className="leading-[0] md-content-wrap">
        <style>{`.md-content-wrap [style] { margin: 0 !important; }
.md-content-wrap h1,.md-content-wrap h2,.md-content-wrap h3,.md-content-wrap h4,
.md-content-wrap p,.md-content-wrap table,.md-content-wrap pre,
.md-content-wrap ul,.md-content-wrap ol,.md-content-wrap blockquote,
.md-content-wrap hr { margin-top: 0 !important; margin-bottom: 0 !important; }`}</style>
        <div className="max-w-none leading-normal">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {sanitized}
          </ReactMarkdown>
        </div>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-600 hover:text-gray-400 text-xs mt-0.5 outline-none"
          >
            {expanded ? '\u25b2 Collapse' : '\u25bc Expand all (' + (data.length / 1000).toFixed(1) + 'K)'}
          </button>
        )}
      </div>
    )
  }

    /* ===== Process Block: terminal-style agent stream view ===== */
  function ProcessBlock({ segments, isStreaming }: { segments: Segment[]; isStreaming: boolean }) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [collapsed, setCollapsed] = useState(!isStreaming)

    useEffect(() => {
      if (scrollRef.current && isStreaming) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, [segments, isStreaming])

    useEffect(() => {
      if (!isStreaming) {
        // Don't auto-collapse immediately — let user see the final state
        const timer = setTimeout(() => setCollapsed(true), 3000)
        return () => clearTimeout(timer)
      }
    }, [isStreaming])

    if (!isStreaming && collapsed) {
      const toolCount = segments.filter(s => s.type === 'tool_call').length
      return (
        <div className="mb-0.5">
          <button
            onClick={() => setCollapsed(false)}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg border"
            style={{ background: 'rgba(180,130,70,0.04)', borderColor: 'rgba(180,130,70,0.12)', color: '#c8b080' }}
          >
            <span className="text-xs">&#9654;</span>
            <span className="text-xs font-medium">Agent 分析</span>
            <span className="text-xs opacity-60">({toolCount} 次工具调用)</span>
          </button>
        </div>
      )
    }

    return (
      <div className="mb-0.5 rounded-lg overflow-hidden border" style={{ borderColor: 'rgba(180,130,70,0.12)', background: '#0d0d14' }}>
        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-1.5" style={{ background: 'rgba(180,130,70,0.06)', borderBottom: '1px solid rgba(180,130,70,0.08)' }}>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full" style={{
              background: isStreaming ? '#e8b84b' : '#4ade80',
              boxShadow: isStreaming ? '0 0 4px #e8b84b66' : 'none'
            }} />
            <span className="text-xs font-medium" style={{ color: '#c8b080' }}>Agent</span>
            {isStreaming && <span className="text-xs animate-pulse" style={{ color: '#a09070' }}>&#9679; 思考中</span>}
          </div>
          {!isStreaming && (
            <button
              onClick={() => setCollapsed(true)}
              className="text-xs outline-none cursor-pointer" style={{ color: '#6b5d48' }}
            >
              ▲ 收起
            </button>
          )}
        </div>

        {/* Content area */}
        <div
          ref={scrollRef}
          className="px-3 py-2 space-y-1"
          style={isStreaming ? { maxHeight: '200px', overflowY: 'auto' } : {}}
        >
          {segments.length === 0 && isStreaming && (
            <div className="text-xs animate-pulse" style={{ color: '#5a5a6a' }}>等待 Agent 输出...</div>
          )}
          {renderProcessContent(segments)}
          {isStreaming && (
            <span className="inline-block w-1.5 h-3 ml-0.5 animate-pulse" style={{ background: '#e8b84b', boxShadow: '0 0 4px #e8b84b66' }} />
          )}
        </div>
      </div>
    )
  }

  /* ===== Merge consecutive reasoning + content segments into flowing text ===== */
  function renderProcessContent(segs: Segment[]) {
    // Group: merge consecutive text segments (reasoning/content), keep tool blocks separate
    const blocks: { type: 'text' | 'tool'; data: string; segs: Segment[] }[] = []
    for (const seg of segs) {
      if (seg.type === 'reasoning' || seg.type === 'content') {
        const last = blocks[blocks.length - 1]
        if (last?.type === 'text') {
          last.data += '\n' + seg.data
          last.segs.push(seg)
        } else {
          blocks.push({ type: 'text', data: seg.data, segs: [seg] })
        }
      } else {
        blocks.push({ type: 'tool', data: '', segs: [seg] })
      }
    }

    return blocks.map((block, bi) => {
      if (block.type === 'text') {
        return (
          <div key={bi} className="text-xs leading-relaxed py-0.5" style={{ color: '#c8c090' }}>
            <MarkdownContent data={block.data} />
          </div>
        )
      }
      // Tool blocks: render each tool segment individually
      return block.segs.map((seg, si) => renderProcessSegment(seg, si))
    })
  }

  /* ===== Render a single process segment (terminal agent style) ===== */
  function renderProcessSegment(seg: Segment, idx: number) {
    switch (seg.type) {
      case 'reasoning':
      case 'content':
        // Merge consecutive content/reasoning into one flowing block
        return null  // handled by ProcessBlock directly
      case 'tool_call': {
        let tc: ToolCallInfo
        try { tc = JSON.parse(seg.data) } catch { tc = { id: '', name: seg.data, arguments: '' } }
        const argsTrunc = tc.arguments.length > 60 ? tc.arguments.slice(0, 60) + '...' : tc.arguments
        return (
          <div key={idx} className="rounded border px-2.5 py-1.5" style={{ borderColor: 'rgba(180,130,70,0.12)', background: 'rgba(180,130,70,0.04)' }}>
            <div className="flex items-center gap-1.5 text-xs font-mono" style={{ color: '#c8b080' }}>
              <span>&#9670;</span>
              <span className="font-medium">{tc.name}</span>
              {argsTrunc && <span className="truncate" style={{ color: '#8a7a60' }}>{argsTrunc}</span>}
            </div>
          </div>
        )
      }
      case 'tool_result': {
        // Compact one-line summary — don't show raw tool output
        let summary = '[Tool result]'
        try {
          const parsed = JSON.parse(seg.data)
          if (parsed && typeof parsed === 'object') {
            // Try to get a meaningful summary from common patterns
            if (Array.isArray(parsed)) summary = `→ returned ${parsed.length} items`
            else if (parsed.matchedCount !== undefined) summary = `→ Matched: ${parsed.matchedCount} stocks`
            else if (parsed.totalStocks !== undefined) summary = `→ ${parsed.matchedStocks}/${parsed.totalStocks} matched (${parsed.executionTime}ms)`
            else summary = `→ ${Object.keys(parsed).length} fields`
          }
        } catch {
          const s = seg.data.slice(0, 80)
          summary = `→ ${s}`
        }
        return (
          <div key={idx} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono" style={{ color: '#6a7a6a' }}>
            <span className="text-[10px]">&#9654;</span>
            <span>{summary}</span>
          </div>
        )
      }
      default:
        return null
    }
  }

  /* ===== Render the assistant message: process block + final answer ===== */
  function renderAssistantMessage(segs: Segment[], isStreaming: boolean) {
    // Process steps: reasonings + tool_calls + tool_results (everything before final content)
    const processSegments: Segment[] = []
    // Final content segments (everything after last tool_result)
    const contentSegments: Segment[] = []

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (seg.type === 'content' && !isStreaming) {
        // Check if there are no more tool segments after this
        const remaining = segs.slice(i + 1)
        const hasMoreTools = remaining.some(s => s.type === 'tool_call' || s.type === 'tool_result')
        if (!hasMoreTools) {
          contentSegments.push(seg)
          continue
        }
      }
      processSegments.push(seg)
    }

    // If no process segments, everything is content
    const finalContent = contentSegments.length > 0
      ? contentSegments
      : processSegments.length === 0
        ? segs
        : []

    const processBlock = processSegments.length > 0 ? processSegments : null

    return (
      <div>
        {/* Process block (reasoning + tools) */}
        {processBlock && (
          <div className="mb-0.5">
            <ProcessBlock segments={processBlock} isStreaming={isStreaming} />
          </div>
        )}

        {/* Final answer */}
        {finalContent.length > 0 && (
          <div className="mb-0.5">
            {finalContent.map((seg, j) => (
              <div key={j} className="text-gray-200 text-sm whitespace-pre-wrap break-words leading-normal">
                {seg.type === 'content' ? <MarkdownContent data={seg.data} /> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  /* ===== Agent header: SClaw identity strip ===== */
  function AgentHeader() {
    return (
      <div className="flex items-center gap-2 mb-1 pb-1 border-b border-bronze/20">
        <span className="text-lg leading-none">🦀</span>
        <span className="text-bronze font-bold text-xs tracking-wider uppercase">SClaw</span>
        <span className="text-gray-600 text-[10px] font-mono hidden sm:inline">· market hunter</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]" />
          <span className="text-gray-600 text-[9px] font-mono">online</span>
        </span>
      </div>
    )
  }

  /* ===== User message bubble ===== */
  function UserMessageBlock({ content }: { content: string }) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-gray-900/80 border border-cyan-800/50 rounded-lg px-3 py-1">
          <div className="text-gray-200 text-sm whitespace-pre-wrap break-words leading-normal">
            {content}
          </div>
        </div>
      </div>
    )
  }

  /* ===== Assistant message bubble ===== */
  function AssistantBubble({ children }: { children: React.ReactNode }) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] bg-[rgba(196,154,108,0.04)] border border-bronze/20 rounded-lg px-3 py-1.5">
          <AgentHeader />
          {children}
        </div>
      </div>
    )
  }

  // Memoize message rendering — typing in input should NOT re-render messages
  const messagesList = useMemo(() => (
    <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-3 relative" onScroll={handleChatScroll} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
      {messages.map((msg, i) => {
        const isEditing = editingIndex === i && msg.role === 'user'
        const msgContent = msg.segments?.find(s => s.type === 'content')?.data || msg.content || ''
        return (
        <div key={i} className="group mb-4 leading-normal relative">
          {/* Hover actions: recall + edit (not during streaming, not on last assistant msg) */}
          {!streaming && !isEditing && (
            <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 z-10">
              <button
                onClick={() => handleRecall(i)}
                className="text-gray-600 hover:text-amber-400 text-[10px] font-mono px-1 border border-gray-800 hover:border-amber-900 rounded cursor-pointer"
                title="Recall (truncate from here)"
              >↩</button>
              <button
                onClick={() => { setEditingIndex(i); setEditText(msgContent) }}
                className="text-gray-600 hover:text-cyan-400 text-[10px] font-mono px-1 border border-gray-800 hover:border-cyan-900 rounded cursor-pointer"
                title="Edit this message"
              >✎</button>
            </div>
          )}

          {isEditing ? (
            /* Edit mode: textarea with save/cancel */
            <div className="flex flex-col gap-1">
              <textarea
                value={editText}
                onChange={e => setEditText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(i, editText) }
                  if (e.key === 'Escape') { setEditingIndex(null); setEditText('') }
                }}
                className="w-full bg-gray-900 text-gray-200 text-sm font-mono border border-gray-700 rounded px-2 py-1 resize-none outline-none min-h-[60px]"
                autoFocus
              />
              <div className="flex gap-2 text-[10px] font-mono">
                <button
                  onClick={() => handleEditSave(i, editText)}
                  className="text-green-500 hover:text-green-400 border border-green-900 hover:border-green-700 px-2 py-0.5 rounded cursor-pointer"
                >Enter Save</button>
                <button
                  onClick={() => { setEditingIndex(null); setEditText('') }}
                  className="text-gray-500 hover:text-gray-400 border border-gray-800 hover:border-gray-700 px-2 py-0.5 rounded cursor-pointer"
                >Esc Cancel</button>
              </div>
            </div>
          ) : msg.role === 'user' ? (
            <UserMessageBlock content={msgContent} />
          ) : (
            <AssistantBubble>
              {msg.segments && msg.segments.length > 0
                ? renderAssistantMessage(msg.segments, streaming && i === messages.length - 1)
                : /* Backward compat: old messages without segments */
                  msg.content ? (
                    <div>
                      {msg.toolCalls?.map((tc, j) => (
                        <div key={`tc-${j}`} className="text-xs font-mono text-gray-600 leading-normal py-1">
                          ── Tool: {tc.name} ──
                        </div>
                      ))}
                      <div className="text-gray-300 text-sm whitespace-pre-wrap break-words leading-normal">
                        {msg.content}
                      </div>
                    </div>
                  ) : null}
            </AssistantBubble>
          )}
        </div>
      )})}
    </div>
  ), [messages, streaming, editingIndex, editText, isNearBottom])

  return (
    <div className="flex flex-1 min-h-0 bg-black font-mono relative">
      {/* 左侧：AI 选股列表 */}
      <ChatStockList
        stocks={aiStocks}
        open={stockPanelOpen}
        onToggle={() => setStockPanelOpen(o => !o)}
        onSelect={s => setViewingStock(s)}
        onClear={() => setAiStocks([])}
      />

      {/* 右侧：聊天 */}
      <div className="flex flex-col flex-1 min-h-0 relative">
        {messagesList}

      {/* Floating scroll-to-bottom button — outside scroll container */}
      {!isNearBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-16 right-4 z-30 bg-bronze/20 hover:bg-bronze/40 border border-bronze/40 rounded-full px-3 py-1.5 text-bronze text-xs font-mono cursor-pointer transition-all shadow-lg backdrop-blur-sm"
          title="Scroll to bottom"
        >
          ↓ Bottom
        </button>
      )}

      {/* Debug panel — shows recent prompt dumps */}
      {debugCount > 0 && (
        <div className="border-t border-amber-900/40 bg-black px-4">
          <button
            onClick={() => setDebugOpen(!debugOpen)}
            className="text-amber-600 hover:text-amber-400 text-xs font-mono py-1.5 cursor-pointer outline-none w-full text-left"
          >
            {debugOpen ? '▼' : '▶'} Prompt Debug ({debugCount} dumped)
          </button>
          {debugOpen && (
            <div className="pb-2 space-y-1">
              {debugPrompts.current.map((entry, i) => (
                <div key={i} className="text-amber-700/80 text-[10px] font-mono leading-normal truncate">
                  <span className="text-amber-500/60">[{entry.timestamp}]</span>{' '}
                  <span className="text-amber-600/80">{entry.messageCount}msgs</span>
                  {' | '}
                  <span className="text-amber-600/80">{entry.totalTokens}tok</span>
                  {' | '}
                  <span className="text-amber-700/60">{entry.filePath}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Input bar — terminal style */}
      <div className="border-t border-gray-800 bg-black px-4 py-2.5">
        {/* Model selector mini-bar */}
        <div className="flex items-center gap-2 mb-1.5 px-0.5">
          <span className="text-[10px] text-gray-600 font-mono">🧠</span>
          <select
            value={currentModel}
            onChange={e => handleModelSwitch(e.target.value)}
            disabled={streaming}
            className="bg-transparent text-gray-500 hover:text-gray-300 text-[10px] font-mono border border-gray-800 rounded px-1.5 py-0.5 outline-none cursor-pointer disabled:opacity-30 appearance-none"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'8\' viewBox=\'0 0 8 8\'%3E%3Cpath fill=\'%236b7280\' d=\'M2 2l2 2 2-2z\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingRight: '16px' }}
          >
            {availableModels.map(m => (
              <option key={m.id} value={m.id} className="bg-black text-gray-300">{m.name}</option>
            ))}
          </select>
          {modelSwitchMsg && (
            <span className="text-[10px] text-bronze font-mono animate-pulse">{modelSwitchMsg}</span>
          )}
          {!modelSwitchMsg && availableModels.length > 0 && (
            <span className="text-[9px] text-gray-700 font-mono ml-auto">
              {currentModel === 'deepseek-v4-pro' ? '⚡ Pro' : '⚡ Flash'}
            </span>
          )}
        </div>
        <div className="flex gap-2 items-center">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter command..."
            rows={1}
            disabled={streaming}
            className="flex-1 bg-transparent text-gray-200 border-0 px-0 py-2 text-sm font-mono resize-none outline-none disabled:opacity-50 min-h-[36px] max-h-[100px]"
          />
          <button
            onClick={() => send()}
            disabled={streaming || !input.trim()}
            title="Send message (Enter)"
            className="text-bronze hover:text-bronze-light disabled:opacity-30 text-xs font-mono px-3 py-1 border border-bronze/40 rounded hover:border-bronze transition-colors cursor-pointer flex-shrink-0"
          >
            ▶ Send
          </button>
          <button
            onClick={handleClear}
            disabled={streaming}
            title="Clear chat history"
            className="text-gray-600 hover:text-red-400 disabled:opacity-30 text-xs font-mono px-2 py-1 border border-gray-800 rounded hover:border-red-900 transition-colors cursor-pointer flex-shrink-0"
          >
            ✕ Clear
          </button>
        </div>
      </div>
      </div>

      {/* 缠论 overlay — 点击左侧股票时全屏显示 */}
      {viewingStock && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 shrink-0">
            <span className="text-bronze font-mono text-sm">
              🔍 缠论分析: {viewingStock.name} ({viewingStock.code})
            </span>
            <button
              onClick={() => setViewingStock(null)}
              className="text-gray-500 hover:text-red-400 text-xs font-mono px-3 py-1 border border-gray-800 rounded hover:border-red-900 transition-colors cursor-pointer"
            >
              ✕ 关闭
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <Suspense fallback={<div className="flex items-center justify-center h-full text-gray-500 text-sm font-mono">Loading Chan...</div>}>
              <ChanPanel onBack={() => setViewingStock(null)} initialCode={viewingStock.code} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}