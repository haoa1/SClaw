/**
 * WatchAlertToast — Toast-style popup for new watch alerts.
 *
 * Slides in from the top-right, auto-dismisses after 4s.
 * Shows stock name, price change direction/percent, and condition.
 */

import { useEffect, useState, useRef } from 'react';
import { WatchAlert } from '../types';

interface Props {
  alert: WatchAlert;
  onDismiss: () => void;
  onClick: (alert: WatchAlert) => void;
}

export default function WatchAlertToast({ alert, onDismiss, onClick }: Props) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // Trigger slide-in animation
    requestAnimationFrame(() => setVisible(true));

    // Auto-dismiss after 4s
    timerRef.current = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300); // wait for slide-out animation
    }, 4000);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [alert, onDismiss]);

  const isUp = alert.changePercent >= 0;
  const arrow = isUp ? '🟢' : '🔴';
  const dir = isUp ? '涨' : '跌';

  return (
    <div
      onClick={() => onClick(alert)}
      className={`
        fixed top-20 right-6 z-[9999] cursor-pointer
        bg-stock-card border border-gray-700 rounded-xl shadow-2xl
        px-4 py-3 max-w-sm w-full
        transition-all duration-300 ease-out
        ${visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
        hover:border-bronze/50 hover:shadow-bronze/10
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-lg">{arrow}</span>
          <span className="text-sm font-semibold text-white">{alert.stockName}</span>
          <span className="text-xs text-gray-500">{alert.stock}</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          className="text-gray-600 hover:text-gray-300 text-sm"
        >
          ✕
        </button>
      </div>

      {/* Price info */}
      <div className="flex items-center gap-3 ml-1">
        <span className="text-lg font-bold text-white">{alert.price.toFixed(2)}</span>
        <span className={`text-sm font-medium ${isUp ? 'text-red-400' : 'text-green-400'}`}>
          {arrow} {dir} {Math.abs(alert.changePercent).toFixed(2)}%
        </span>
      </div>

      {/* Condition message */}
      <div className="mt-1 text-xs text-gray-400 ml-1 line-clamp-2">
        {alert.message}
      </div>
    </div>
  );
}
