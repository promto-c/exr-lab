import { describe, expect, it } from 'vitest';
import type { ExrChannel } from '@blackboard/exr-reader';
import { getLayerMapping, guessChannels } from '../channelMapping';

const ch = (name: string): ExrChannel => ({
  name,
  pixelType: 1,
  pLinear: 0,
  xSampling: 1,
  ySampling: 1,
});

describe('channel mapping helpers', () => {
  it('guesses canonical rgba channels', () => {
    const map = guessChannels([ch('beauty.R'), ch('beauty.G'), ch('beauty.B'), ch('beauty.A')]);
    expect(map).toEqual({
      r: 'beauty.R',
      g: 'beauty.G',
      b: 'beauty.B',
      a: 'beauty.A',
    });
  });

  it('falls back to first channels when rgb names are absent', () => {
    const map = guessChannels([ch('Z'), ch('Y')]);
    expect(map.r).toBe('Z');
    expect(map.g).toBe('Y');
    expect(map.b).toBe('Z');
  });

  it('maps layer channels using prefix-aware xyz matching', () => {
    const map = getLayerMapping([ch('depth.Z'), ch('depth.A')], 'depth');
    expect(map).toEqual({
      r: '',
      g: '',
      b: 'depth.Z',
      a: 'depth.A',
    });
  });
});
