import React from 'react';
import { RefreshCw, Wifi, X } from 'lucide-react';

interface PwaToastProps {
  /** 'update' = new version available, 'offline' = app cached for offline use */
  kind: 'update' | 'offline';
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * A small toast that appears at the bottom-right to prompt for update or
 * confirm offline readiness.
 */
export const PwaToast: React.FC<PwaToastProps> = ({ kind, onAccept, onDismiss }) => {
  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 shadow-2xl text-sm text-neutral-200 animate-in slide-in-from-bottom-4">
      {kind === 'update' ? (
        <>
          <RefreshCw size={18} className="shrink-0 text-blue-400" />
          <span>A new version is available.</span>
          <button
            onClick={onAccept}
            className="ml-2 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
          >
            Update
          </button>
        </>
      ) : (
        <>
          <Wifi size={18} className="shrink-0 text-green-400" />
          <span>EXR Lab is ready to work offline.</span>
        </>
      )}
      <button
        onClick={onDismiss}
        className="ml-1 rounded p-1 hover:bg-neutral-700 transition-colors"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
};
