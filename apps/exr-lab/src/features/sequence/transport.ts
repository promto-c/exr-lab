import type { ExrCache } from '../../core/cache';
import type { SequenceFrame } from './sequenceUtils';

export type PlaybackMode = 'timing' | 'every' | 'cached';
export type CacheStage = 'none' | 'buffer' | 'decoded';

export const DEFAULT_SEQUENCE_FPS = 24;

export const CACHE_STAGE_COLORS: Record<CacheStage, string | null> = {
  none: null,
  buffer: 'var(--tone-slider-cache-buffer)',
  decoded: 'var(--theme-accent)',
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const getSafeSequenceFrameIndex = (
  sequenceFrameIndex: number | null,
  frameCount: number,
): number | null => {
  if (sequenceFrameIndex === null) return null;
  return clamp(sequenceFrameIndex, 0, Math.max(frameCount - 1, 0));
};

export const getCurrentFrameLabel = (
  safeSequenceFrameIndex: number | null,
  sequenceFrames: SequenceFrame[],
): string => {
  if (safeSequenceFrameIndex === null || sequenceFrames.length === 0) return '';

  const frame = sequenceFrames[safeSequenceFrameIndex];
  const current = frame?.frameNumber ?? safeSequenceFrameIndex + 1;
  const lastFrame = sequenceFrames[sequenceFrames.length - 1];
  const total = lastFrame?.frameNumber ?? sequenceFrames.length;
  const pad = Math.max(String(total).length, 1);

  return `${String(current).padStart(pad, '0')} / ${String(total).padStart(pad, '0')}`;
};

export const getSequenceCacheMask = (
  sequenceFrames: SequenceFrame[],
  cache: ExrCache,
): CacheStage[] => {
  if (sequenceFrames.length === 0) return [];

  return sequenceFrames.map((frame): CacheStage => {
    if (cache.hasFrame(frame.id)) return 'decoded';
    if (cache.hasBuffer(frame.id)) return 'buffer';
    return 'none';
  });
};
