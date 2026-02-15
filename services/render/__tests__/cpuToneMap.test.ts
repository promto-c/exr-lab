import { describe, expect, it } from 'vitest';
import { toneMapToImage } from '../cpuToneMap';
import { RawDecodeResult } from '../types';

describe('toneMapToImage', () => {
  it('applies exposure/gamma and channel mapping parity math', () => {
    const raw: RawDecodeResult = {
      width: 2,
      height: 1,
      channels: {
        R: new Float32Array([0.5, 2.0]),
        G: new Float32Array([0.5, 2.0]),
        B: new Float32Array([0.5, 2.0]),
        A: new Float32Array([1.0, 0.5]),
      },
    };

    const out = toneMapToImage(
      raw,
      { r: 'R', g: 'G', b: 'B', a: 'A' },
      { exposure: 0, gamma: 2.0 },
    );

    expect(Array.from(out)).toEqual([180, 180, 180, 255, 255, 255, 255, 127]);
  });
});
