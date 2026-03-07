import { ChannelMapping, RawDecodeResult } from './types';
import { RenderParams } from './types';

const DEFAULT_BINS = 64;

export function computeHistogram(
  raw: RawDecodeResult,
  mapping: ChannelMapping,
  params?: RenderParams,
  bins: number = DEFAULT_BINS,
): number[] {
  const histogram = new Array(bins).fill(0);
  const { width, height, channels } = raw;
  const len = width * height;

  const rPlane = mapping.r ? channels[mapping.r] : undefined;
  const gPlane = mapping.g ? channels[mapping.g] : undefined;
  const bPlane = mapping.b ? channels[mapping.b] : undefined;

  const hasDisplayTransform = !!params;
  const exposure = params?.exposure ?? 0;
  const expMult = Math.pow(2, exposure);
  const safeGamma = params ? (params.gamma > 0 ? params.gamma : 1.0) : 1.0;
  const invGamma = 1.0 / safeGamma;

  for (let i = 0; i < len; i++) {
    let r = rPlane ? rPlane[i] : 0;
    let g = gPlane ? gPlane[i] : 0;
    let b = bPlane ? bPlane[i] : 0;

    if (hasDisplayTransform) {
      if (exposure !== 0) {
        r *= expMult;
        g *= expMult;
        b *= expMult;
      }

      if (r < 0) r = 0;
      if (g < 0) g = 0;
      if (b < 0) b = 0;

      if (invGamma !== 1.0) {
        r = Math.pow(r, invGamma);
        g = Math.pow(g, invGamma);
        b = Math.pow(b, invGamma);
      }
    } else {
      if (r < 0) r = 0;
      if (g < 0) g = 0;
      if (b < 0) b = 0;
    }

    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const bucket = lum >= 1.0 ? bins - 1 : (lum * bins) | 0;
    histogram[bucket]++;
  }

  return histogram;
}
