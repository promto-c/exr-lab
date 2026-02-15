import { describe, expect, it } from 'vitest';
import { computeHistogram } from '../histogram';
import { RawDecodeResult } from '../types';

describe('computeHistogram', () => {
  it('places values into expected bins for normalized luminance', () => {
    const raw: RawDecodeResult = {
      width: 2,
      height: 1,
      channels: {
        R: new Float32Array([0, 1]),
        G: new Float32Array([0, 1]),
        B: new Float32Array([0, 1]),
      },
    };

    const histogram = computeHistogram(
      raw,
      { r: 'R', g: 'G', b: 'B', a: '' },
      { exposure: 0, gamma: 1 },
    );

    expect(histogram[0]).toBe(1);
    expect(histogram[63]).toBe(1);
    expect(histogram.reduce((sum, bin) => sum + bin, 0)).toBe(2);
  });

  it('supports raw histogram mode without display transforms', () => {
    const raw: RawDecodeResult = {
      width: 1,
      height: 1,
      channels: {
        R: new Float32Array([0.25]),
        G: new Float32Array([0.25]),
        B: new Float32Array([0.25]),
      },
    };

    const histogram = computeHistogram(raw, { r: 'R', g: 'G', b: 'B', a: '' });
    expect(histogram[16]).toBe(1);
    expect(histogram.reduce((sum, bin) => sum + bin, 0)).toBe(1);
  });
});
