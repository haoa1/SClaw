/**
 * WatchAlertPanel — Side panel showing all watch alerts.
 *
 * Lists alerts with unread indicators, mark-read, clear all.
 * Each alert shows stock name, code, price change, message, and timestamp.
 * Click an alert to scroll to it / take action. Also shows connection status.
 */

import { WatchAlert } from '../types';

interface Props {
  alerts: WatchAlert[];
  unread: number;
  connected: boolean;
  error: string | null;
  onClearAlerts: () => void;
  onMarkAllRead: () => void;
  onDismissAlert: (alertId: string) => void;
  onClose: () => void;
}

function formatTime(ts: string | number): string {
  try {
    const d = new Date(ts);
    // If today, show HH:MM:SS. If older, show MM-DD HH:MM
    const now = new Date();
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (isToday) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return String(ts);
  }
}

export default function WatchAlertPanel({ alerts, unread, connected, error, onClearAlerts, onMarkAllRead, onDismissAlert, onClose }: Props) {
  return (
    <div className="bg-stock-card border-l border-gray-800 w-96 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔔</span>
          <h3 className="font-semibold text-white text-sm">Watch Alerts</h3>
          {unread > 0 && (
            <span className="bg-red-600 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-medium">
              {unread}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-600'}`} title={connected ? 'Connected' : 'Disconnected'} />
          {alerts.length > 0 && (
            <>
              <button onClick={onMarkAllRead} className="text-xs text-gray-500 hover:text-bronze transition" title="Mark all read">
                ✓ All Read
              </button>
              <button onClick={onClearAlerts} className="text-xs text-gray-500 hover:text-red-400 transition" title="Clear all">
                ✕ Clear
              </button>
            </>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm ml-1">&gt;</button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/30 border-b border-red-900/50 px-4 py-2 text-xs text-red-300 flex items-center gap-2">
          <span>⚠</span>
          <span className="flex-1 truncate">{error}</span>
        </div>
      )}

      {/* Alert list */}
      <div className="flex-1 overflow-y-auto">
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 px-4">
            <span className="text-4xl mb-3">🔕</span>
            <p className="text-sm">No alerts yet</p>
            <p className="text-xs mt-1">Alerts will appear here when watched stocks trigger conditions</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {[...alerts].reverse().map((alert) => {
              const isRead = alert.read;
              const isUp = alert.changePercent >= 0;
              return (
                <div
                  key={alert.id}
                  className={`px-4 py-3 hover:bg-gray-800/30 transition cursor-pointer ${
                    !isRead ? 'bg-bronze-glow border-l-2 border-l-bronze' : 'border-l-2 border-l-transparent'
                  }`}
                >
                  {/* Stock info */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {!isRead && <span className="w-2 h-2 rounded-full bg-bronze flex-shrink-0" />}
                      <span className="text-sm font-medium text-white truncate">{alert.stockName}</span>
                      <span className="text-xs text-gray-500">{alert.stock}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-gray-600">{formatTime(alert.timestamp)}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDismissAlert(alert.id); }}
                        className="text-gray-700 hover:text-gray-400 text-xs"
                        title="Dismiss"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Price row */}
                  <div className="flex items-center gap-3 ml-3">
                    <span className="text-base font-bold text-white">{alert.price.toFixed(2)}</span>
                    <span className={`text-xs font-medium ${isUp ? 'text-red-400' : 'text-green-400'}`}>
                      {isUp ? '🟢' : '🔴'} {isUp ? '+' : ''}{alert.changePercent.toFixed(2)}%
                    </span>
                    {alert.volumeRatio !== undefined && alert.volumeRatio !== null && (
                      <span className="text-xs text-gray-500">
                        Vol: {(alert.volumeRatio).toFixed(1)}x
                      </span>
                    )}
                  </div>

                  {/* Message */}
                  <div className="mt-1 text-xs text-gray-400 ml-3">
                    {alert.message}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer stats */}
      {alerts.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex items-center justify-between">
          <span>{alerts.length} alert{alerts.length !== 1 ? 's' : ''}</span>
          <span>{unread > 0 ? `${unread} unread` : 'All read ✓'}</span>
        </div>
      )}
    </div>
  );
}
