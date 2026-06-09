import { useState, useEffect, useRef } from 'react'

interface GarudaTerminalProps {
  onBack: () => void
}

export default function GarudaTerminal({ onBack }: GarudaTerminalProps) {
  const [connected, setConnected] = useState<boolean | null>(null) // null = checking
  const [lines, setLines] = useState<string[]>([
    '🔌 Garuda Terminal',
    'Checking tunnel connection...',
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const healthInterval = useRef<ReturnType<typeof setInterval>>()

  // Check health on mount and periodically
  const checkHealth = async () => {
    try {
      const res = await fetch('/api/admin/garuda/health')
      const data = await res.json()
      setConnected(data.ok && data.status === 'connected')
      if (data.ok && data.status === 'connected') {
        setLines(prev => {
          if (prev.includes('✅ Connected to Garuda tunnel')) return prev
          return [...prev, '✅ Connected to Garuda tunnel']
        })
      }
    } catch {
      setConnected(false)
    }
  }

  useEffect(() => {
    checkHealth()
    healthInterval.current = setInterval(checkHealth, 15000)
    return () => {
      if (healthInterval.current) clearInterval(healthInterval.current)
    }
  }, [])

  // Auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const sendCommand = async () => {
    const text = input.trim()
    if (!text || sending) return

    setSending(true)
    setLines(prev => [...prev, '', `> ${text}`])
    setInput('')

    try {
      const res = await fetch('/api/admin/garuda/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text }),
      })
      const data = await res.json()

      if (data.ok) {
        // Split output into lines for display
        const outputLines = data.output
          .split('\n')
          .filter((l: string) => l.trim())
          .map((l: string) => `  ${l}`)
        setLines(prev => [...prev, ...outputLines])
      } else {
        setLines(prev => [...prev, `  ⚠️ Error: ${data.error || 'Unknown error'}`])
      }
    } catch (err: any) {
      setLines(prev => [...prev, `  ❌ Request failed: ${err.message}`])
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      sendCommand()
    }
  }

  const handleBack = () => {
    if (healthInterval.current) clearInterval(healthInterval.current)
    onBack()
  }

  const tunnelStatus = connected === null ? 'Checking...'
    : connected ? 'Connected' : 'Disconnected'

  const tunnelColor = connected === null ? 'bg-yellow-500'
    : connected ? 'bg-green-400' : 'bg-red-500'

  return (
    <div className="flex flex-col h-full bg-black text-green-400 font-mono text-sm">
      {/* Terminal header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-700 text-xs text-gray-400">
        <div className="flex items-center gap-2">
          <span className="text-purple-400">🔌 Garuda Terminal</span>
          <span className={`w-2 h-2 rounded-full ${tunnelColor}`} />
          <span>{tunnelStatus}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={checkHealth}
            className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded transition text-xs"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setLines(['🔌 Garuda Terminal', 'Cleared.'])}
            className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded transition text-xs"
          >
            Clear
          </button>
          <button
            onClick={handleBack}
            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition text-xs"
          >
            ← Back
          </button>
        </div>
      </div>

      {/* Terminal status bar */}
      <div className="flex items-center gap-4 px-4 py-1.5 bg-gray-900/50 border-b border-gray-800 text-xs text-gray-600">
        <span>POST /api/admin/garuda/exec</span>
        <span className="text-gray-700">|</span>
        <span>tunnel → localhost:19999 → Garuda</span>
        <span className="text-gray-700">|</span>
        <span className={connected ? 'text-green-700' : 'text-yellow-700'}>
          {connected ? 'Tunnel active' : 'Waiting for tunnel...'}
        </span>
      </div>

      {/* Terminal output */}
      <div className="flex-1 overflow-y-auto p-4 space-y-0.5">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all leading-relaxed">
            {line}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-t border-gray-700">
        <span className="text-green-400 select-none">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? 'Type a command...' : 'Tunnel not connected...'}
          disabled={!connected || sending}
          className="flex-1 bg-transparent text-green-400 outline-none placeholder-gray-600"
          autoFocus
        />
        <button
          onClick={sendCommand}
          disabled={!connected || !input.trim() || sending}
          className="px-3 py-1 bg-green-700 hover:bg-green-600 disabled:bg-gray-800 disabled:text-gray-600 text-green-200 rounded text-xs transition"
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  )
}
