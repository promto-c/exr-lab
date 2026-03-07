import { describe, expect, it } from 'vitest';
import { ExrCache } from '../../../core/cache';
import type { SequenceFrame } from '../sequenceUtils';
import {
  getCurrentFrameLabel,
  getSafeSequenceFrameIndex,
  getSequenceCacheMask,
} from '../transport';

const makeFrame = (id: string, frameNumber: number | null): SequenceFrame => ({
  id,
  file: new File(['x'], `${id}.exr`),
  name: `${id}.exr`,
  relativePath: `${id}.exr`,
  sequenceKey: 'shot',
  frameNumber,
});

describe('sequence transport helpers', () => {
  it('clamps and null-handles safe sequence frame index', () => {
    expect(getSafeSequenceFrameIndex(null, 10)).toBeNull();
    expect(getSafeSequenceFrameIndex(2, 5)).toBe(2);
    expect(getSafeSequenceFrameIndex(99, 3)).toBe(2);
    expect(getSafeSequenceFrameIndex(-5, 3)).toBe(0);
  });

  it('formats frame label using sequence frame numbers', () => {
    const frames = [makeFrame('a', 1001), makeFrame('b', 1002), makeFrame('c', 1003)];
    expect(getCurrentFrameLabel(1, frames)).toBe('1002 / 1003');
  });

  it('computes cache stage mask from cache content', () => {
    const frames = [makeFrame('f1', 1), makeFrame('f2', 2), makeFrame('f3', 3)];
    const cache = new ExrCache();

    cache.setBuffer('f2', new ArrayBuffer(4));
    cache.setFrame('f3', {
      partId: 0,
      structure: {
        magic: 0,
        version: 0,
        flags: 0,
        isMultipart: false,
        parts: [],
        headerEndOffset: 0,
      },
      rawPixelData: {
        width: 1,
        height: 1,
        channels: { R: new Float32Array([1]) },
      },
    });

    expect(getSequenceCacheMask(frames, cache)).toEqual(['none', 'buffer', 'decoded']);
  });
});
