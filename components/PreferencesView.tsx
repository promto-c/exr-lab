import React from 'react';
import { X, Database, Play } from 'lucide-react';
import { CacheStats } from '../types';
import { PrecisionSlider } from './PrecisionSlider';
import type { PlaybackMode } from '../App';
import { PREFETCH_STRATEGIES, type PrefetchStrategy } from '../core/prefetch';

export const CACHE_MB_MIN = 64;
export const CACHE_MB_MAX = 65536;

type PreferencesCategory = 'cache' | 'playback';

interface PreferencesViewProps {
  isOpen: boolean;
  onClose: () => void;
  cacheStats: CacheStats;
  maxCacheMB: number;
  maxCacheBytes: number;
  cacheUsagePercent: number;
  cacheExceeded: boolean;
  onCacheLimitChange: (value: number) => void;
  onCachePolicyChange: (policy: 'oldest' | 'distance') => void;
  cachePolicy: 'oldest' | 'distance';
  cacheDistance: number;
  onCacheDistanceChange: (value: number) => void;
  onPurgeCaches: () => void;
  formatBytes: (bytes: number) => string;
  // Playback
  playbackMode: PlaybackMode;
  onPlaybackModeChange: (mode: PlaybackMode) => void;
  sequenceFps: number;
  onSequenceFpsChange: (fps: number) => void;
  // Prefetch
  prefetchStrategy: PrefetchStrategy;
  onPrefetchStrategyChange: (strategy: PrefetchStrategy) => void;
  prefetchConcurrency: number;
  onPrefetchConcurrencyChange: (concurrency: number) => void;
}

const PLAYBACK_MODES: { value: PlaybackMode; label: string; description: string }[] = [
  {
    value: 'timing',
    label: 'Preserve timing',
    description: 'Maintain target FPS; skip uncached frames to keep real-time pace.',
  },
  {
    value: 'every',
    label: 'Every frame',
    description: 'Play every frame in order. May slow down if decode takes longer than frame interval.',
  },
  {
    value: 'cached',
    label: 'Wait for cache',
    description: 'Only advance once the next frame is fully decoded. Guarantees no skip or stutter.',
  },
];

export const PreferencesView: React.FC<PreferencesViewProps> = ({
  isOpen,
  onClose,
  cacheStats,
  maxCacheMB,
  maxCacheBytes,
  cacheUsagePercent,
  cacheExceeded,
  onCacheLimitChange,
  onCachePolicyChange,
  cachePolicy,
  cacheDistance,
  onCacheDistanceChange,
  onPurgeCaches,
  formatBytes,
  playbackMode,
  onPlaybackModeChange,
  sequenceFps,
  onSequenceFpsChange,
  prefetchStrategy,
  onPrefetchStrategyChange,
  prefetchConcurrency,
  onPrefetchConcurrencyChange,
}) => {
  const [category, setCategory] = React.useState<PreferencesCategory>('cache');

  if (!isOpen) return null;

  const categories: { id: PreferencesCategory; label: string; icon: React.ReactNode }[] = [
    { id: 'cache', label: 'Cache', icon: <Database className="w-3.5 h-3.5" /> },
    { id: 'playback', label: 'Playback', icon: <Play className="w-3.5 h-3.5" /> },
  ];

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
        className="relative z-10 w-full max-w-2xl rounded-xl border border-neutral-800 bg-neutral-950/95 shadow-2xl flex flex-col"
        style={{ maxHeight: 'min(580px, calc(100vh - 2rem))' }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Preferences</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors"
            aria-label="Close preferences"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left category list */}
          <nav className="w-36 shrink-0 border-r border-neutral-800 py-2 flex flex-col gap-0.5 overflow-y-auto">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setCategory(cat.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors rounded-r-md mr-1 ${
                  category === cat.id
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50'
                }`}
              >
                {cat.icon}
                {cat.label}
              </button>
            ))}
          </nav>

          {/* Right content pane */}
          <div className="flex-1 overflow-y-auto p-4">
            {category === 'cache' && (
              <CachePane
                cacheStats={cacheStats}
                maxCacheMB={maxCacheMB}
                maxCacheBytes={maxCacheBytes}
                cacheUsagePercent={cacheUsagePercent}
                cacheExceeded={cacheExceeded}
                onCacheLimitChange={onCacheLimitChange}
                onCachePolicyChange={onCachePolicyChange}
                cachePolicy={cachePolicy}
                cacheDistance={cacheDistance}
                onCacheDistanceChange={onCacheDistanceChange}
                onPurgeCaches={onPurgeCaches}
                formatBytes={formatBytes}
                prefetchStrategy={prefetchStrategy}
                onPrefetchStrategyChange={onPrefetchStrategyChange}
                prefetchConcurrency={prefetchConcurrency}
                onPrefetchConcurrencyChange={onPrefetchConcurrencyChange}
              />
            )}
            {category === 'playback' && (
              <PlaybackPane
                playbackMode={playbackMode}
                onPlaybackModeChange={onPlaybackModeChange}
                sequenceFps={sequenceFps}
                onSequenceFpsChange={onSequenceFpsChange}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---------- Cache pane (extracted from previous body) ---------- */

const CachePane: React.FC<{
  cacheStats: CacheStats;
  maxCacheMB: number;
  maxCacheBytes: number;
  cacheUsagePercent: number;
  cacheExceeded: boolean;
  onCacheLimitChange: (value: number) => void;
  onCachePolicyChange: (policy: 'oldest' | 'distance') => void;
  cachePolicy: 'oldest' | 'distance';
  cacheDistance: number;
  onCacheDistanceChange: (value: number) => void;
  onPurgeCaches: () => void;
  formatBytes: (bytes: number) => string;
  prefetchStrategy: PrefetchStrategy;
  onPrefetchStrategyChange: (strategy: PrefetchStrategy) => void;
  prefetchConcurrency: number;
  onPrefetchConcurrencyChange: (concurrency: number) => void;
}> = ({
  cacheStats,
  maxCacheMB,
  maxCacheBytes,
  cacheUsagePercent,
  cacheExceeded,
  onCacheLimitChange,
  onCachePolicyChange,
  cachePolicy,
  cacheDistance,
  onCacheDistanceChange,
  onPurgeCaches,
  formatBytes,
  prefetchStrategy,
  onPrefetchStrategyChange,
  prefetchConcurrency,
  onPrefetchConcurrencyChange,
}) => (
  <div className="space-y-4">
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-neutral-500">Memory &amp; Cache</p>
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

    <div className="space-y-4">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-neutral-500">Eviction policy</p>
        <div className="mt-1 text-xs">
          <div className="inline-flex rounded-md border border-neutral-800 overflow-hidden">
            <button
              type="button"
              className={`px-3 py-1 transition-colors ${
                cachePolicy === 'oldest'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800'
              }`}
              onClick={() => onCachePolicyChange('oldest')}
            >
              Oldest frames first
            </button>
            <button
              type="button"
              className={`px-3 py-1 transition-colors flex items-center gap-1 ${
                cachePolicy === 'distance'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800'
              }`}
              onClick={() => onCachePolicyChange('distance')}
            >
              <span>Drop frames farther than</span>
              <input
                type="number"
                min={0}
                step={1}
                value={cacheDistance}
                onChange={(e) => onCacheDistanceChange(Number(e.target.value))}
                disabled={cachePolicy !== 'distance'}
                className="w-16 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
              />
              <span>frames</span>
            </button>
          </div>
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

    {/* Prefetch strategy */}
    <div className="space-y-4">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-neutral-500">Background prefetch</p>
        <p className="text-xs text-neutral-400 mt-0.5">
          Pre-cache frames in background threads for smoother playback.
        </p>
      </div>

      <div className="space-y-1.5">
        {PREFETCH_STRATEGIES.map((s) => (
          <label
            key={s.value}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
              prefetchStrategy === s.value
                ? 'border-teal-600/60 bg-teal-900/15'
                : 'border-neutral-800 bg-neutral-900/40 hover:bg-neutral-800/40'
            }`}
          >
            <input
              type="radio"
              name="prefetchStrategy"
              value={s.value}
              checked={prefetchStrategy === s.value}
              onChange={() => onPrefetchStrategyChange(s.value)}
              className="mt-0.5 accent-teal-500"
            />
            <div>
              <div className="text-xs text-neutral-100">{s.label}</div>
              <div className="text-[10px] text-neutral-500 leading-snug mt-0.5">{s.description}</div>
            </div>
          </label>
        ))}
      </div>

      {prefetchStrategy !== 'on-demand' && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-neutral-500">Concurrency</p>
          <div className="flex items-center gap-2">
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onPrefetchConcurrencyChange(n)}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors border ${
                  prefetchConcurrency === n
                    ? 'bg-neutral-800 text-neutral-100 border-neutral-600'
                    : 'text-neutral-400 border-neutral-800 hover:bg-neutral-800/50'
                }`}
              >
                {n}
              </button>
            ))}
            <span className="text-[10px] text-neutral-500 ml-1">parallel decode{prefetchConcurrency > 1 ? 's' : ''}</span>
          </div>
        </div>
      )}
    </div>
  </div>
);

/* ---------- Playback pane ---------- */

const FPS_PRESETS = [12, 24, 25, 30, 48, 60];

const PlaybackPane: React.FC<{
  playbackMode: PlaybackMode;
  onPlaybackModeChange: (mode: PlaybackMode) => void;
  sequenceFps: number;
  onSequenceFpsChange: (fps: number) => void;
}> = ({ playbackMode, onPlaybackModeChange, sequenceFps, onSequenceFpsChange }) => (
  <div className="space-y-5">
    {/* FPS */}
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-neutral-500">Frame rate</p>
      <div className="flex items-center gap-2 flex-wrap">
        {FPS_PRESETS.map((fps) => (
          <button
            key={fps}
            type="button"
            onClick={() => onSequenceFpsChange(fps)}
            className={`px-2.5 py-1 rounded-md text-xs transition-colors border ${
              sequenceFps === fps
                ? 'bg-neutral-800 text-neutral-100 border-neutral-600'
                : 'text-neutral-400 border-neutral-800 hover:bg-neutral-800/50'
            }`}
          >
            {fps}
          </button>
        ))}
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={120}
            step={1}
            value={sequenceFps}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 1 && v <= 120) onSequenceFpsChange(v);
            }}
            className="w-16 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
          />
          <span className="text-[10px] text-neutral-500">fps</span>
        </div>
      </div>
    </div>

    {/* Playback mode */}
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-neutral-500">Playback mode</p>
      <div className="space-y-1.5">
        {PLAYBACK_MODES.map((mode) => (
          <label
            key={mode.value}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
              playbackMode === mode.value
                ? 'border-teal-600/60 bg-teal-900/15'
                : 'border-neutral-800 bg-neutral-900/40 hover:bg-neutral-800/40'
            }`}
          >
            <input
              type="radio"
              name="playbackMode"
              value={mode.value}
              checked={playbackMode === mode.value}
              onChange={() => onPlaybackModeChange(mode.value)}
              className="mt-0.5 accent-teal-500"
            />
            <div>
              <div className="text-xs text-neutral-100">{mode.label}</div>
              <div className="text-[10px] text-neutral-500 leading-snug mt-0.5">{mode.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  </div>
);
