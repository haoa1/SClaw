/**
 * useWatchAlertSSE — Hook for connecting to /api/watch-stream SSE.
 *
 * Manages EventSource lifecycle, parses alert/status/keepalive events,
 * and exposes alerts + connection state to React components.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { WatchAlert, WatchSSEStatus } from '../types';

function getToken(): string | null {
  try { return localStorage.getItem('auth-token'); } catch { return null; }
}

export interface WatchSSEState {
  /** Latest alerts in chronological order (newest last) */
  alerts: WatchAlert[];
  /** Unread count */
  unread: number;
  /** Whether the SSE connection is active */
  connected: boolean;
  /** Connection error message, if any */
  error: string | null;
  /** Watch status (active tasks, total tasks) */
  status: WatchSSEStatus | null;
  /** Clear all alerts */
  clearAlerts: () => void;
  /** Mark all alerts as read */
  markAllRead: () => void;
  /** Dismiss a single alert by id */
  dismissAlert: (alertId: string) => void;
}

const MAX_ALERTS = 100;

export function useWatchAlertSSE(): WatchSSEState {
  const [alerts, setAlerts] = useState<WatchAlert[]>([]);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<WatchSSEStatus | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
    setUnread(0);
  }, []);

  const markAllRead = useCallback(() => {
    setAlerts(prev => prev.map(a => ({ ...a, read: true })));
    setUnread(0);
  }, []);

  const dismissAlert = useCallback((alertId: string) => {
    setAlerts(prev => {
      const next = prev.filter(a => a.id !== alertId);
      return next;
    });
    // Re-count unread from remaining
    setUnread(prev => Math.max(0, prev - 1));
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    function connect() {
      const token = getToken();
      if (!token) {
        setError('No auth token');
        setConnected(false);
        return;
      }

      // Clean up any existing connection
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const url = `/api/watch-stream?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        setError(null);
      };

      es.onmessage = (event) => {
        if (!mountedRef.current) return;

        try {
          const data = JSON.parse(event.data);

          if (data.type === 'alert') {
            // Strip the 'type' field — it's metadata, not part of WatchAlert
            const { type, ...alertData } = data;
            const alert: WatchAlert = {
              ...alertData,
              // Ensure id exists; generate one if server didn't provide it
              id: alertData.id || `${alertData.userId}_${alertData.stock}_${alertData.timestamp}`,
              // New alerts are always unread
              read: false,
            };

            setAlerts(prev => {
              const next = [...prev, alert];
              // Keep max alerts
              if (next.length > MAX_ALERTS) {
                return next.slice(next.length - MAX_ALERTS);
              }
              return next;
            });
            setUnread(prev => prev + 1);
          } else if (data.type === 'status') {
            setStatus(data as WatchSSEStatus);
          }
          // Ignore keepalive events
        } catch (err) {
          console.warn('[WatchSSE] Failed to parse event:', err);
        }
      };

      es.onerror = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        setError('Connection lost, reconnecting...');
        es.close();
        esRef.current = null;

        // Auto-reconnect after 5s
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 5000);
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (esRef.current) esRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, []);

  return { alerts, unread, connected, error, status, clearAlerts, markAllRead, dismissAlert };
}
