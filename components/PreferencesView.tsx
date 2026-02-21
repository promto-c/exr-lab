import React from 'react';
import { X } from 'lucide-react';
import { CacheStats } from '../types';
import { PrecisionSlider } from './PrecisionSlider';

export const CACHE_MB_MIN = 64;
export const CACHE_MB_MAX = 65536;

interface PreferencesViewProps {
  isOpen: boolean;
  onClose: () => void;
  cacheStats: CacheStats;
  maxCacheMB: number;
  maxCacheBytes: number;
  cacheUsagePercent: number;
  cacheExceeded: boolean;
  onCacheLimitChange: (value: number) => void;
  onPurgeCaches: () => void;
  formatBytes: (bytes: number) => string;
}

export const PreferencesView: React.FC<PreferencesViewProps> = ({
  isOpen,
  onClose,
  cacheStats,
  maxCacheMB,
  maxCacheBytes,
  cacheUsagePercent,
  cacheExceeded,
  onCacheLimitChange,
  onPurgeCaches,
  formatBytes,
}) => {
  if (!isOpen) return null;

  return (
    <div
      data-touch-ui="true"
      className="absolute inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close preferences"
      />
      <div 
        className="relative z-10 w-full max-w-xl rounded-xl border border-neutral-800 bg-neutral-950/95 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Preferences</h3>
            <p className="text-xs text-neutral-500">Memory + cache controls</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors"
            aria-label="Close preferences"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-neutral-500">Memory & Cache</p>
                <p className="text-xs text-neutral-400">Soft cap for in-app caches only.</p>
              </div>
              <span className="text-[10px] font-mono text-neutral-300">
                {formatBytes(cacheStats.uniqueCacheBytes)} / {formatBytes(maxCacheBytes)}
              </span>
            </div>

            <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className={`h-full ${cacheExceeded ? 'bg-red-500/80' : 'bg-teal-500/80'}`}
                style={{ width: `${cacheUsagePercent * 100}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
                <div className="text-neutral-500">Current frame data</div>
                <div className="font-mono text-neutral-200">{formatBytes(cacheStats.rawBytes)}</div>
              </div>
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
                <div className="text-neutral-500">Cache usage (unique)</div>
                <div className="font-mono text-neutral-200">{formatBytes(cacheStats.uniqueCacheBytes)}</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <PrecisionSlider
                value={maxCacheMB}
                min={CACHE_MB_MIN}
                max={CACHE_MB_MAX}
                step={16}
                onChange={onCacheLimitChange}
                ariaLabel="Cache size"
                className="flex-1"
              />
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={CACHE_MB_MIN}
                  max={CACHE_MB_MAX}
                  step={16}
                  value={maxCacheMB}
                  onChange={(e) => onCacheLimitChange(Number(e.target.value))}
                  className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                />
                <span className="text-[10px] text-neutral-500">MB</span>
              </div>
            </div>

            <div className="flex items-center justify-between text-[10px] text-neutral-500">
              <span>Min {CACHE_MB_MIN} MB</span>
              <span>Max {CACHE_MB_MAX} MB</span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => {
                  if (window.confirm('Clear in-memory caches?')) {
                    onPurgeCaches();
                  }
                }}
                className="px-3 py-1.5 rounded-md border border-neutral-700 bg-neutral-900 text-xs text-neutral-200 hover:bg-neutral-800 transition-colors"
              >
                Clear caches
              </button>
              {cacheExceeded && (
                <span className="text-[10px] text-red-400">Cache is above the limit and will auto-trim.</span>
              )}
            </div>
          </div>

          <div className="border-t border-neutral-800 pt-3 text-xs text-neutral-500">
            <div className="flex flex-wrap items-center gap-3">
              <span>Part cache: {formatBytes(cacheStats.partCacheBytes)} · {cacheStats.partCacheCount}</span>
              <span>Frame cache: {formatBytes(cacheStats.frameCacheBytes)} · {cacheStats.frameCacheCount}</span>
              <span>Buffer cache: {formatBytes(cacheStats.bufferCacheBytes)} · {cacheStats.bufferCacheCount}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
