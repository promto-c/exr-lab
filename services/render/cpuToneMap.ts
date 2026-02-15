import { ChannelMapping, RawDecodeResult } from './types';
import { RenderParams } from './types';

/**
 * CPU tonemap path retained for parity fallback.
 */
export function toneMapToImage(
  raw: RawDecodeResult,
  mapping: ChannelMapping,
  params: RenderParams,
): Uint8ClampedArray {
  const { width, height, channels } = raw;
  const len = width * height;
  const outputBuffer = new Uint8ClampedArray(len * 4);

  const rPlane = mapping.r ? channels[mapping.r] : undefined;
  const gPlane = mapping.g ? channels[mapping.g] : undefined;
  const bPlane = mapping.b ? channels[mapping.b] : undefined;
  const aPlane = mapping.a ? channels[mapping.a] : undefined;

  const exposure = params.exposure;
  const expMult = Math.pow(2, exposure);
  const safeGamma = params.gamma > 0 ? params.gamma : 1.0;
  const invGamma = 1.0 / safeGamma;

  for (let i = 0; i < len; i++) {
    let r = rPlane ? rPlane[i] : 0;
    let g = gPlane ? gPlane[i] : 0;
    let b = bPlane ? bPlane[i] : 0;
    const a = aPlane ? aPlane[i] : 1;

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

    const outIdx = i * 4;
    outputBuffer[outIdx] = r >= 1.0 ? 255 : (r * 255) | 0;
    outputBuffer[outIdx + 1] = g >= 1.0 ? 255 : (g * 255) | 0;
    outputBuffer[outIdx + 2] = b >= 1.0 ? 255 : (b * 255) | 0;
    outputBuffer[outIdx + 3] = (a * 255) | 0;
  }

  return outputBuffer;
}
