import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { WatchTaskSimple } from '../types';

interface Props {
  token: string;
}

const CONDITION_LABELS: Record<string, string> = {
  price_change: '涨跌幅',
  volume_spike: '量比',
  price_cross: '价格突破均线',
  new_high_low: '创N日新高/新低',
  combined: '组合条件',
};

const DIRECTION_LABELS: Record<string, string> = {
  up: '上涨↑',
  down: '下跌↓',
  break_up: '向上突破',
  break_down: '向下突破',
  new_high: '创新高',
  new_low: '创新低',
};

function describeCondition(cond: any): string {
  const typeLabel = CONDITION_LABELS[cond.type] || cond.type;
  switch (cond.type) {
    case 'price_change':
      return `${typeLabel} ${DIRECTION_LABELS[cond.direction] || cond.direction} ${cond.thresholdPercent}%`;
    case 'volume_spike':
      return `${typeLabel} ≥ ${cond.ratio}x`;
    case 'price_cross':
      return `${typeLabel} — ${cond.cross || 'ma5'}`;
    case 'new_high_low':
      return `${DIRECTION_LABELS[cond.direction] || cond.direction} (${cond.period || 60}日)`;
    default:
      return typeLabel;
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN');
}

export default function WatchTaskPanel({ token }: Props) {
  const [tasks, setTasks] = useState<WatchTaskSimple[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sseStatus, setSseStatus] = useState<{ active: number; total: number } | null>(null);

  useEffect(() => {
    fetchTasks();
    connectSSE();
  }, [token]);

  async function fetchTasks() {
    try {
      setLoading(true);
      const data = await api.getWatchTasks();
      setTasks(data.tasks);
      setError(null);
    } catch (e: any) {
      setError(e.message || '获取盯盘任务失败');
    } finally {
      setLoading(false);
    }
  }

  function connectSSE() {
    const url = `/api/watch-stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    es.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'status') {
          setSseStatus({ active: data.activeTasks, total: data.totalTasks });
        }
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      es.close();
      // Reconnect after 5s
      setTimeout(() => connectSSE(), 5000);
    };

    return () => es.close();
  }

  if (loading) {
    return <div className="watch-panel"><p>加载中…</p></div>;
  }

  if (error) {
    return <div className="watch-panel"><p className="error">{error}</p></div>;
  }

  const isConnected = sseStatus !== null;

  return (
    <div className="watch-panel">
      <div className="watch-header">
        <h3>盯盘任务</h3>
        <span className={`sse-badge ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? '已连接' : '未连接'}
          {isConnected && sseStatus && (
            <> · {sseStatus.active}/{sseStatus.total} 活跃</>
          )}
        </span>
      </div>

      {tasks.length === 0 ? (
        <p className="empty-state">暂无盯盘任务。在对话中创建任务后会自动显示在这里。</p>
      ) : (
        <div className="watch-task-list">
          {tasks.map(task => (
            <div key={task.id} className={`watch-task-card ${!task.enabled ? 'disabled' : ''}`}>
              <div className="watch-task-header">
                <span className="watch-task-label">{task.label || '未命名任务'}</span>
                <span className={`watch-task-status ${task.enabled ? 'on' : 'off'}`}>
                  {task.enabled ? '运行中' : '已暂停'}
                </span>
              </div>

              <div className="watch-task-meta">
                <span>间隔: {task.interval}s</span>
                <span>冷却: {task.cooldownSeconds}s</span>
              </div>

              <div className="watch-targets">
                <strong>关注:</strong>{' '}
                {task.watchTargets.length > 0
                  ? task.watchTargets.join(', ')
                  : '自选股'}
              </div>

              <div className="watch-conditions">
                <strong>条件:</strong>
                <ul>
                  {task.conditions.map((cond, i) => (
                    <li key={i}>{describeCondition(cond)}</li>
                  ))}
                </ul>
              </div>

              <div className="watch-channels">
                <strong>通知:</strong>{' '}
                {[
                  task.alertChannels.frontend && '前端',
                  '邮件',
                  task.alertChannels.agent && 'Agent',
                ].filter(Boolean).join(', ') || '无'}
                {task.email ? (
                  <span className="watch-email"> → {task.email}</span>
                ) : (
                  <span className="watch-email-unset"> (未设置)</span>
                )}
              </div>

              <div className="watch-times">
                <span>创建: {formatTime(task.createdAt)}</span>
                {task.lastRun && <span>上次运行: {formatTime(task.lastRun)}</span>}
                {task.lastAlert && (
                  <span className="last-alert">
                    上次报警: {task.lastAlert.stock} — {task.lastAlert.message}
                    <br />
                    <small>{formatTime(task.lastAlert.timestamp)}</small>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
