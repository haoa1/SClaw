import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import AgentStreamView from './AgentStreamView'
import type { ScheduledTask, QueueStatus } from '../types'

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function cronToHuman(cron: string): string {
  const parts = cron.split(' ')
  if (parts.length !== 5) return cron
  const [min, hour, , , dow] = parts
  let s = ''
  if (dow !== '*') {
    const days = ['日', '一', '二', '三', '四', '五', '六']
    s = '周' + dow.split(',').map(d => days[parseInt(d)]).join('、')
  } else {
    s = '每天'
  }
  if (hour !== '*' && min !== '*') {
    s += ' ' + hour.padStart(2, '0') + ':' + min.padStart(2, '0')
  } else {
    s += ' ' + cron
  }
  return s
}

export default function SchedulerPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [queue, setQueue] = useState<QueueStatus>({ running: null, queued: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [doneStreams, setDoneStreams] = useState<Set<string>>(new Set())

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [taskRes, queueRes] = await Promise.all([
        api.getSchedulerTasks(),
        api.getQueueStatus(),
      ])
      setTasks(taskRes.tasks)
      setQueue(queueRes)
    } catch (err: any) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleCancel = async (taskId: string, label: string) => {
    setMessage('')
    try {
      const res = await api.cancelSchedulerTask(taskId)
      setMessage(res.success
        ? '已取消: ' + (label || taskId.slice(0, 8))
        : '取消失败: ' + res.message)
      loadData()
    } catch (err: any) {
      setMessage('取消失败: ' + (err.message || '未知错误'))
    }
  }

  const handleRunNow = async (taskId: string) => {
    setMessage('')
    try {
      await api.runSchedulerTask(taskId)
      setMessage('任务已触发')
      setTimeout(loadData, 1000)
    } catch (err: any) {
      setMessage('触发失败: ' + (err.message || '未知错误'))
    }
  }

  const handleToggle = async (taskId: string, enabled: boolean) => {
    setMessage('')
    try {
      await api.toggleSchedulerTask(taskId, enabled)
      setMessage(enabled ? '已启用' : '已停用')
      loadData()
    } catch (err: any) {
      setMessage('操作失败: ' + (err.message || '未知错误'))
    }
  }

  const handleDelete = async (taskId: string, label: string) => {
    if (!confirm('确定删除任务「' + (label || taskId.slice(0, 8)) + '」？')) return
    setMessage('')
    try {
      await api.deleteSchedulerTask(taskId)
      setMessage('已删除')
      loadData()
    } catch (err: any) {
      setMessage('删除失败: ' + (err.message || '未知错误'))
    }
  }

  const handleStreamDone = useCallback((_taskId: string) => {
    setDoneStreams(prev => new Set(prev).add(_taskId))
  }, [])

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <h2 className="text-lg font-semibold text-stock-text mb-4">⏰ 定时任务</h2>
        <div className="bronze-divider mb-4"><span>◇</span></div>
        <div className="text-center text-stock-text-secondary py-12">加载中...</div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-lg font-semibold text-stock-text mb-4">⏰ 定时任务</h2>
      <div className="bronze-divider mb-4"><span>◇</span></div>

      {error && (
        <div className="bg-red-900/30 border border-red-800/50 text-red-300 px-4 py-2 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {message && (
        <div className="bg-bronze-glow border border-bronze-dim/30 text-bronze px-4 py-2 rounded-lg mb-4 text-sm">
          {message}
        </div>
      )}

      {/* Queue status bar */}
      {queue.running && (
        <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg px-4 py-3 mb-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
            <span className="text-blue-300 font-medium">运行中:</span>
            <span className="text-blue-200">{queue.running.label}</span>
            {queue.queued.length > 0 && (
              <span className="text-stock-text-secondary ml-2">
                (+ {queue.queued.length} 个排队)
              </span>
            )}
          </div>
          {queue.queued.length > 0 && (
            <div className="mt-2 pl-5 space-y-1">
              {queue.queued.map(q => (
                <div key={q.id} className="flex items-center justify-between text-stock-text-secondary">
                  <span>⏳ {q.label}</span>
                  <button
                    onClick={() => handleCancel(q.id, q.label)}
                    className="text-red-400 hover:text-red-300 text-xs underline cursor-pointer"
                  >
                    取消
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <div className="text-center text-stock-text-secondary py-12">暂无定时任务</div>
      ) : (
        <div className="space-y-3">
          {tasks.map(t => {
            const lr = t.lastResult
            const isRunning = queue.running?.id === t.id
            const isQueued = queue.queued.some(q => q.id === t.id)
            return (
              <div
                key={t.id}
                className={'bg-stock-card border rounded-xl overflow-hidden ' + (
                  isRunning ? 'border-blue-700/50' :
                  isQueued ? 'border-yellow-700/30' :
                  'border-stock-border'
                )}
              >
                <div className="px-4 py-3 space-y-2">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        {isRunning && <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />}
                        {isQueued && <span className="text-yellow-400">⏳</span>}
                        <span className="text-stock-text font-medium">{t.label || '(未命名)'}</span>
                        {!t.enabled && (
                          <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">已停用</span>
                        )}
                      </div>
                      <div className="text-xs text-stock-text-secondary mt-1 space-x-3">
                        <span>{cronToHuman(t.cronExpr)}</span>
                        <span>|</span>
                        {(t.taskType === 'agent') ? (
                          <span className="text-cyan-400">AI分析</span>
                        ) : (
                          <span className={t.aiMode === 'both' ? 'text-bronze' : 'text-green-400'}>
                            {t.aiMode === 'email' ? '邮件' : '邮件+AI'}
                          </span>
                        )}
                        <span>|</span>
                        <span className="text-stock-text-secondary/60">
                          {(t.strategies || []).map(s => s.strategyName || s.strategyId).join(', ')}
                        </span>
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleRunNow(t.id)}
                        disabled={isRunning}
                        className={'px-2 py-1 text-xs rounded cursor-pointer ' + (
                          isRunning
                            ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                            : 'bg-stock-hover text-stock-text-secondary hover:text-stock-text hover:bg-gray-700'
                        )}
                        title="立即执行"
                      >
                        ▶ 运行
                      </button>
                      {isRunning ? (
                        <button
                          onClick={() => handleCancel(t.id, t.label || '')}
                          className="px-2 py-1 text-xs rounded bg-red-900/40 text-red-300 hover:bg-red-900/60 cursor-pointer"
                          title="取消运行"
                        >
                          ■ 中止
                        </button>
                      ) : isQueued ? (
                        <button
                          onClick={() => handleCancel(t.id, t.label || '')}
                          className="px-2 py-1 text-xs rounded bg-yellow-900/40 text-yellow-300 hover:bg-yellow-900/60 cursor-pointer"
                        >
                          ✕ 取消排队
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleToggle(t.id, !t.enabled)}
                        className={'px-2 py-1 text-xs rounded cursor-pointer ' + (
                          t.enabled
                            ? 'bg-green-900/40 text-green-300 hover:bg-green-900/60'
                            : 'bg-gray-800 text-gray-500 hover:text-gray-400'
                        )}
                      >
                        {t.enabled ? '启用' : '停用'}
                      </button>
                      <button
                        onClick={() => handleDelete(t.id, t.label || '')}
                        className="px-2 py-1 text-xs rounded bg-gray-800 text-stock-text-secondary hover:text-red-300 hover:bg-red-900/40 cursor-pointer"
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  {/* Last run info */}
                  {lr && !isRunning && !doneStreams.has(t.id) && (
                    <div className="text-xs text-stock-text-secondary/60 bg-stock-hover/50 rounded px-3 py-1.5">
                      上次运行: {t.lastRun ? formatTime(t.lastRun) : '从未'}
                      {' | '}命中 {lr.matchedCount}/{lr.totalCount} 只
                      {lr.topResults && lr.topResults.length > 0 && (
                        <span className="ml-2">
                          Top: {lr.topResults.map(r => r.code).join(', ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {(isRunning || doneStreams.has(t.id)) && (
                  <div className="px-4 pb-3">
                    <AgentStreamView
                      taskId={t.id}
                      onDone={() => handleStreamDone(t.id)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Refresh button */}
      <div className="mt-6 text-center">
        <button
          onClick={loadData}
          className="px-4 py-2 text-sm text-stock-text-secondary hover:text-stock-text bg-stock-card border border-stock-border rounded-lg hover:bg-stock-hover transition cursor-pointer"
        >
          ↻ 刷新
        </button>
      </div>
    </div>
  )
}
