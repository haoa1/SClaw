import { useState } from 'react'

interface VSCodePanelProps {
  onBack: () => void
}

export default function VSCodePanel({ onBack }: VSCodePanelProps) {
  const [loading, setLoading] = useState(true)
  const codeServerUrl = '/code-server/'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#1e1e1e' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        backgroundColor: '#2d2d2d',
        borderBottom: '1px solid #3c3c3c'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={onBack}
            style={{
              background: 'none',
              border: '1px solid #555',
              color: '#ccc',
              padding: '4px 12px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            ← Back
          </button>
          <span style={{ color: '#4ec9b0', fontWeight: 600, fontSize: '14px' }}>🖥️ VS Code</span>
        </div>
        <button
          onClick={() => window.open('/code-server/', '_blank')}
          style={{
            background: 'none',
            border: '1px solid #555',
            color: '#ccc',
            padding: '4px 12px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px'
          }}
        >
          Open in new tab ↗
        </button>
      </div>

      {/* Iframe */}
      <div style={{ flex: 1, position: 'relative' }}>
        {loading && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#888',
            fontSize: '14px',
            backgroundColor: '#1e1e1e',
            zIndex: 1
          }}>
            ⌛ Connecting to VS Code...
          </div>
        )}
        <iframe
          src={codeServerUrl}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: loading ? 'none' : 'block'
          }}
          onLoad={() => setLoading(false)}
          title="VS Code"
        />
      </div>

      {/* Status bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '4px 16px',
        backgroundColor: '#007acc',
        color: '#fff',
        fontSize: '12px'
      }}>
        <span>VS Code Server (code-server)</span>
        <span>|</span>
        <span>SSH tunnel → Mac</span>
        <span>|</span>
        <span style={{ color: loading ? '#ff0' : '#0f0' }}>
          {loading ? 'Connecting...' : 'Connected ✅'}
        </span>
      </div>
    </div>
  )
}
