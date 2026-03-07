import React from 'react';
import { CACHE_MB_MAX, CACHE_MB_MIN } from '../../components/PreferencesView';
import { ExrCache } from '../../core/cache';
import { PrefetchEngine, type PrefetchStrategy } from '../../core/prefetch';
import type { RawDecodeResult } from '../../services/render/types';
import type { CacheStats } from '../../types';
import type { SequenceFrame } from '../sequence/sequenceUtils';

const RECENT_HISTORY_LIMIT = 64;

const EMPTY_CACHE_STATS: CacheStats = {
  cacheBytes: 0,
  uniqueCacheBytes: 0,
  rawBytes: 0,
  totalUniqueBytes: 0,
  partCacheBytes: 0,
  frameCacheBytes: 0,
  bufferCacheBytes: 0,
  partCacheCount: 0,
  frameCacheCount: 0,
  bufferCacheCount: 0,
};

export type UseCachePrefetchParams = {
  rawPixelData: RawDecodeResult | null;
  maxCacheMB: number;
  cachePolicy: 'oldest' | 'distance';
  cacheDistance: number;
  sequenceFrameIndex: number | null;
  sequenceFrames: SequenceFrame[];
  safeSequenceFrameIndex: number | null;
  prefetchStrategy: PrefetchStrategy;
  prefetchConcurrency: number;
};

export type UseCachePrefetchResult = {
  exrCacheRef: React.MutableRefObject<ExrCache>;
  prefetchEngineRef: React.MutableRefObject<PrefetchEngine>;
  recentFrameIndicesRef: React.MutableRefObject<number[]>;
  cacheStats: CacheStats;
  formatBytes: (bytes: number) => string;
  updateCacheStats: () => void;
  pruneCachesToLimit: () => void;
  purgeCaches: () => void;
};

export const useCachePrefetch = ({
  rawPixelData,
  maxCacheMB,
  cachePolicy,
  cacheDistance,
  sequenceFrameIndex,
  sequenceFrames,
  safeSequenceFrameIndex,
  prefetchStrategy,
  prefetchConcurrency,
}: UseCachePrefetchParams): UseCachePrefetchResult => {
  const exrCacheRef = React.useRef<ExrCache>(new ExrCache());
  const prefetchEngineRef = React.useRef<PrefetchEngine>(new PrefetchEngine());
  const recentFrameIndicesRef = React.useRef<number[]>([]);

  const [cacheStats, setCacheStats] = React.useState<CacheStats>(EMPTY_CACHE_STATS);

  const formatBytes = React.useCallback((bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    const base = 1024;
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
    const value = bytes / Math.pow(base, exponent);
    const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;

    return `${value.toFixed(precision)} ${units[exponent]}`;
  }, []);

  const updateCacheStats = React.useCallback(() => {
    setCacheStats(exrCacheRef.current.computeStats(rawPixelData));
  }, [rawPixelData]);

  const pruneCachesToLimit = React.useCallback(() => {
    exrCacheRef.current.setMaxCacheMB(maxCacheMB);
    exrCacheRef.current.setPolicy(cachePolicy);
    exrCacheRef.current.setDistance(cacheDistance);

    const purged = exrCacheRef.current.prune(
      sequenceFrameIndex,
      sequenceFrames,
      CACHE_MB_MIN,
      CACHE_MB_MAX,
    );

    if (purged) {
      updateCacheStats();
    }
  }, [
    cacheDistance,
    cachePolicy,
    maxCacheMB,
    sequenceFrameIndex,
    sequenceFrames,
    updateCacheStats,
  ]);

  const purgeCaches = React.useCallback(() => {
    exrCacheRef.current.clearAll();
    updateCacheStats();
  }, [updateCacheStats]);

  React.useEffect(() => {
    updateCacheStats();
  }, [rawPixelData, updateCacheStats]);

  React.useEffect(() => {
    pruneCachesToLimit();
    updateCacheStats();
  }, [maxCacheMB, pruneCachesToLimit, updateCacheStats]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      updateCacheStats();
    }, 1000);

    return () => window.clearInterval(interval);
  }, [updateCacheStats]);

  React.useEffect(() => {
    pruneCachesToLimit();
    updateCacheStats();
  }, [cachePolicy, cacheDistance, sequenceFrameIndex, pruneCachesToLimit, updateCacheStats]);

  React.useEffect(() => {
    const engine = prefetchEngineRef.current;

    if (sequenceFrames.length === 0 || safeSequenceFrameIndex === null) {
      engine.stop();
      return;
    }

    const history = recentFrameIndicesRef.current;
    if (history[history.length - 1] !== safeSequenceFrameIndex) {
      history.push(safeSequenceFrameIndex);
      if (history.length > RECENT_HISTORY_LIMIT) {
        history.splice(0, history.length - RECENT_HISTORY_LIMIT);
      }
    }

    engine.start({
      cache: exrCacheRef.current,
      frames: sequenceFrames,
      currentIndex: safeSequenceFrameIndex,
      strategy: prefetchStrategy,
      concurrency: prefetchConcurrency,
      recentIndices: history,
      onProgress: () => {
        pruneCachesToLimit();
        updateCacheStats();
      },
    });

    return () => {
      engine.stop();
    };
  }, [
    prefetchConcurrency,
    prefetchStrategy,
    pruneCachesToLimit,
    safeSequenceFrameIndex,
    sequenceFrames,
    updateCacheStats,
  ]);

  return {
    exrCacheRef,
    prefetchEngineRef,
    recentFrameIndicesRef,
    cacheStats,
    formatBytes,
    updateCacheStats,
    pruneCachesToLimit,
    purgeCaches,
  };
};
