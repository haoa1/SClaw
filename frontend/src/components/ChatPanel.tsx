import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
  return fetch(url, { ...options, headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) } })
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
    const res = await authFetch('/api/messages')
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data.messages) && data.messages.length > 0)
        return data.messages.map(convertToSegments)
    }
  } catch {}
  return [{ role: 'assistant' as const, segments: [{ type: 'content' as const, data: '连接成功，输入指令开始分析' }] }]
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
  return [{ role: 'assistant', segments: [{ type: 'content', data: '连接成功，输入指令开始分析' }] }]
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

  // Streaming state: ordered segments list + accumulator for reasoning/content fragments
  const streamingSegments = useRef<Segment[]>([])
  const segmentAccum = useRef<{ type: 'reasoning' | 'content'; data: string } | null>(null)

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
          (serverMessages.length === 1 && serverMessages[0].segments?.[0]?.data !== '连接成功，输入指令开始分析')) {
        setMessages(serverMessages)
      } else {
        const local = loadMessages()
        setMessages(local)
        saveMessagesToServer(local)
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

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (!streaming && inputRef.current) {
      inputRef.current.focus()
    }
  }, [streaming])

  const updatePending = () => {
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

  const send = async (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    if (!text || streaming) return
    setInput('')
    setStreaming(true)

    // Reset streaming state
    streamingSegments.current = []
    segmentAccum.current = null

    if (onHighlight && highlightTimeout) {
      onHighlight('发送中...')
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
                if (onAction) onAction(parsed.action, parsed.payload)
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
      onHighlight('AI 回应')
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      console.log('[ChatPanel] React Enter pressed, input:', input, 'streaming:', streaming)
      send()
    }
  }

  /* ===== Markdown renderer (OpenClaw terminal style) ===== */
  const mdComponents: any = {
    h1: ({ children }: any) => <h1 className="text-yellow-400 text-base font-bold mt-3 mb-2 leading-relaxed">{children}</h1>,
    h2: ({ children }: any) => <h2 className="text-yellow-400 text-sm font-bold mt-2 mb-1.5 leading-relaxed">{children}</h2>,
    h3: ({ children }: any) => <h3 className="text-cyan-400 text-sm font-semibold mt-1.5 mb-1 leading-relaxed">{children}</h3>,
    h4: ({ children }: any) => <h4 className="text-cyan-400 text-xs font-semibold mt-1 mb-0.5 leading-relaxed">{children}</h4>,
    p: ({ children }: any) => <p className="text-gray-200 text-sm mb-1 leading-relaxed last:mb-0">{children}</p>,
    strong: ({ children }: any) => <strong className="text-gray-100 font-bold">{children}</strong>,
    em: ({ children }: any) => <em className="italic text-gray-300">{children}</em>,
    code: ({ children, className }: any) => {
      const isInline = !className
      if (isInline) {
        return <code className="bg-gray-800 text-yellow-200 text-xs px-1 py-0.5 rounded font-mono">{children}</code>
      }
      return <code className="block bg-[#1a1a2e] text-gray-200 text-xs font-mono p-3 rounded border border-gray-700 overflow-x-auto leading-relaxed">{children}</code>
    },
    pre: ({ children }: any) => <div className="mb-2">{children}</div>,
    table: ({ children }: any) => (
      <div className="overflow-x-auto mb-2">
        <table className="border-collapse w-full text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }: any) => <thead className="bg-gray-800/80">{children}</thead>,
    th: ({ children }: any) => <th className="border border-gray-700 px-2.5 py-1.5 text-gray-200 font-semibold text-left whitespace-nowrap">{children}</th>,
    td: ({ children }: any) => <td className="border border-gray-700 px-2.5 py-1.5 text-gray-300">{children}</td>,
    tr: ({ children }: any) => <tr className="even:bg-gray-900/40">{children}</tr>,
    ul: ({ children }: any) => <ul className="list-disc pl-4 mb-1 text-gray-200 text-sm space-y-0.5">{children}</ul>,
    ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-1 text-gray-200 text-sm space-y-0.5">{children}</ol>,
    li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }: any) => (
      <blockquote className="border-l-2 border-cyan-800 pl-3 my-1.5 text-gray-400 text-sm italic">{children}</blockquote>
    ),
    a: ({ href, children }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline">
        {children}
      </a>
    ),
    hr: () => <hr className="border-gray-800 my-2" />,
  }

  /** Markdown content with long-content collapsible wrapper */
  function MarkdownContent({ data }: { data: string }) {
    const [expanded, setExpanded] = useState(false)
    const isLong = data.length > 5000
    const displayData = isLong && !expanded ? data.slice(0, 5000) + '\n...' : data
    return (
      <div>
        <div className="prose prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {displayData}
          </ReactMarkdown>
        </div>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-600 hover:text-gray-400 text-xs mt-1 outline-none"
          >
            {expanded ? '▲ 收起' : '▼ 展开全部 (' + (data.length / 1000).toFixed(1) + 'K)'}
          </button>
        )}
      </div>
    )
  }

  /* ===== Process Block: scrollable (5 lines) during streaming, collapsible after ===== */
  function ProcessBlock({ segments, isStreaming }: { segments: Segment[]; isStreaming: boolean }) {
    const scrollRef = useRef<HTMLDivElement>(null)
    // Start collapsed if already finished; start open if still streaming
    const [collapsed, setCollapsed] = useState(!isStreaming)

    // Auto-scroll to bottom during streaming
    useEffect(() => {
      if (scrollRef.current && isStreaming) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, [segments, isStreaming])

    // Auto-collapse when streaming finishes
    useEffect(() => {
      if (!isStreaming) {
        setCollapsed(true)
      }
    }, [isStreaming])

    // Collapsed state (after streaming): show expand button only
    if (!isStreaming && collapsed) {
      return (
        <div className="mb-1">
          <button
            onClick={() => setCollapsed(false)}
            className="text-gray-600 hover:text-gray-400 text-xs outline-none cursor-pointer"
          >
            ▶ 展开思考过程 ({segments.length} 段)
          </button>
        </div>
      )
    }

    // Expanded or streaming: show the content with optional scroll
    return (
      <div className="mb-1">
        {!isStreaming && (
          <div className="flex items-center gap-2 mb-0.5">
            <button
              onClick={() => setCollapsed(true)}
              className="text-gray-600 hover:text-gray-400 text-xs outline-none cursor-pointer"
            >
              ▼ 收起思考过程
            </button>
          </div>
        )}
        <div
          ref={scrollRef}
          style={isStreaming ? { maxHeight: '7.5rem', overflowY: 'auto' } : undefined}
        >
          {segments.map((seg, i) => renderProcessSegment(seg, i))}
        </div>
      </div>
    )
  }

  /* ===== Render a single process segment (reasoning / content / tool_call / tool_result) ===== */
  function renderProcessSegment(seg: Segment, idx: number) {
    switch (seg.type) {
      case 'reasoning':
        return (
          <div key={idx} className="text-gray-500 text-xs italic leading-relaxed py-0.5">
            {seg.data}
          </div>
        )
      case 'content':
        return (
          <div key={idx} className="text-gray-400 text-xs leading-relaxed py-0.5 border-l border-gray-800 pl-2">
            {seg.data}
          </div>
        )
      case 'tool_call': {
        let tc: ToolCallInfo
        try { tc = JSON.parse(seg.data) } catch { tc = { id: '', name: seg.data, arguments: '' } }
        const toolColors: Record<string, string> = {
          assess_stock_risk: 'bg-red-900/40 text-red-300 border-red-700',
          assess_portfolio_risk: 'bg-red-900/40 text-red-300 border-red-700',
          get_stock_info: 'bg-blue-900/40 text-blue-300 border-blue-700',
          frontend_execute: 'bg-purple-900/40 text-purple-300 border-purple-700',
          generate_strategies: 'bg-green-900/40 text-green-300 border-green-700',
          read_file: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
          write_file: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
        }
        const colorClass = toolColors[tc.name] || 'bg-gray-800 text-gray-300 border-gray-600'
        return (
          <div key={idx} className="flex items-center gap-2 py-0.5">
            <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold border ${colorClass}`}>
              ⚡ {tc.name}
            </span>
            <span className="text-gray-600 text-xs font-mono truncate max-w-[60%]">
              {tc.arguments?.slice(0, 80)}{tc.arguments?.length > 80 ? '...' : ''}
            </span>
          </div>
        )
      }
      case 'tool_result':
        return (
          <div key={idx} className="text-xs text-gray-500 font-mono border-l-2 border-gray-800 pl-2 py-0.5 truncate leading-relaxed">
            {seg.data.slice(0, 200)}{seg.data.length > 200 ? '...' : ''}
          </div>
        )
      default:
        return null
    }
  }

  /* ===== Content Block: prominent display for final answer ===== */
  function ContentBlock({ data }: { data: string }) {
    return (
      <div className="text-gray-100 text-sm bg-gray-900/20 rounded px-3 py-2 my-1.5 border-l border-gray-600">
        <MarkdownContent data={data} />
      </div>
    )
  }

  /* ===== Render assistant message: process vs content split ===== */
  function renderAssistantMessage(segments: Segment[], isStreaming: boolean) {
    // Everything before the last content segment is "process" (hidden in collapsible)
    const lastContentIdx = [...segments].reverse().findIndex(s => s.type === 'content')
    const splitIdx = lastContentIdx >= 0 ? segments.length - lastContentIdx - 1 : segments.length
    const processSegs = segments.slice(0, splitIdx)
    const finalSegs = segments.slice(splitIdx).filter(s => s.type === 'content')

    return (
      <div className="bg-gray-900/15 rounded px-3 py-2 border-l-2 border-gray-500">
        {processSegs.length > 0 && (
          <ProcessBlock segments={processSegs} isStreaming={isStreaming} />
        )}
        {finalSegs.map((seg, i) => (
          <ContentBlock key={i} data={seg.data} />
        ))}
      </div>
    )
  }

  /* ===== User Message Block: compact summary auto-collapsed, normal messages clean ===== */
  function UserMessageBlock({ content }: { content: string }) {
    const [collapsed, setCollapsed] = useState(content.startsWith('Compacted Conversation'))
    const lines = content.split('\n')

    if (!collapsed) {
      return (
        <div className="bg-gray-800/30 rounded px-3 py-2.5 border-l-2 border-blue-600">
          <div className="flex gap-2 items-start">
            <span className="text-yellow-500 flex-shrink-0 text-sm font-bold">&gt;&gt;</span>
            <div className="text-blue-200 text-sm whitespace-pre-wrap break-words leading-relaxed">
              {content}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="bg-gray-800/30 rounded px-3 py-2 border-l-2 border-gray-700/60">
        <div className="flex items-center gap-2">
          <span className="text-gray-500 flex-shrink-0 text-xs font-bold">&gt;&gt;</span>
          <span className="text-gray-500 text-xs truncate">
            {lines[0]}{lines.length > 1 ? ` (${lines.length} lines, ${content.length} chars)` : ''}
          </span>
          <button
            onClick={() => setCollapsed(false)}
            className="text-gray-600 hover:text-gray-400 text-xs ml-auto outline-none cursor-pointer flex-shrink-0"
          >
            ▶ 展开
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-black font-mono">
      <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.map((msg, i) => (
          <div key={i} className="mb-2 leading-relaxed">
            {msg.role === 'user' ? (
              <UserMessageBlock content={msg.segments?.find(s => s.type === 'content')?.data || msg.content || ''} />
            ) : (
              <div>
                {msg.segments && msg.segments.length > 0
                  ? renderAssistantMessage(msg.segments, streaming && i === messages.length - 1)
                  : /* Backward compat: old messages without segments */
                    msg.content ? (
                      <div>
                        {msg.toolCalls?.map((tc, j) => (
                          <div key={`tc-${j}`} className="text-xs font-mono text-gray-600 leading-relaxed py-1">
                            ── Tool: {tc.name} ──
                          </div>
                        ))}
                        <div className="text-gray-300 text-sm whitespace-pre-wrap break-words leading-relaxed">
                          {msg.content}
                        </div>
                      </div>
                    ) : null}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input bar — terminal style */}
      <div className="border-t border-gray-800 bg-black px-4 py-2.5">
        <div className="flex gap-2 items-center">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入指令..."
            rows={1}
            disabled={streaming}
            className="flex-1 bg-transparent text-gray-200 border-0 px-0 py-2 text-sm font-mono resize-none outline-none disabled:opacity-50 min-h-[36px] max-h-[100px]"
          />
        </div>
      </div>
    </div>
  )
}
