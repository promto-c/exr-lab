import type { ExrChannel, ExrPart, ExrStructure, ExrWindow } from './core/exr';

export enum LogStatus {
  Start = 'start',
  Ok = 'ok',
  Warn = 'warn',
  Error = 'error',
}

export interface LogMetric {
  label: string;
  value: string | number;
}

export interface LogEntry {
  id: string;
  stepId: string;
  title: string;
  status: LogStatus;
  ms: number;
  metrics: LogMetric[];
  description?: string;
  details?: {
    type: 'hex' | 'json' | 'table' | 'channels' | 'chunk-map';
    data: unknown;
  };
}

export type { ExrChannel, ExrPart, ExrStructure, ExrWindow };

export interface DecodingOptions {
  partId: number;
}

export interface CacheStats {
  cacheBytes: number;
  uniqueCacheBytes: number;
  rawBytes: number;
  totalUniqueBytes: number;
  partCacheBytes: number;
  frameCacheBytes: number;
  bufferCacheBytes: number;
  partCacheCount: number;
  frameCacheCount: number;
  bufferCacheCount: number;
}
