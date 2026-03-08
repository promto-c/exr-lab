import { zlibSync } from 'fflate';
import { ExrError } from '../../shared/errors';
import { PartWriteMeta } from '../meta';
import { isSampledCoordinate } from '../sampling';

function floatBitsToFloat24Bits(bits: number): number {
  const sign = bits & 0x80000000;
  const exponent = bits & 0x7f800000;
  const mantissa = bits & 0x007fffff;

  let reduced = 0;
  if (exponent === 0x7f800000) {
    if (mantissa !== 0) {
      const shrunkMantissa = mantissa >>> 8;
      reduced = (exponent >>> 8) | shrunkMantissa | (shrunkMantissa === 0 ? 1 : 0);
    } else {
      reduced = exponent >>> 8;
    }
  } else {
    reduced = ((exponent | mantissa) + (mantissa & 0x00000080)) >>> 8;
    if (reduced >= 0x7f8000) {
      reduced = (exponent | mantissa) >>> 8;
    }
  }

  return ((sign >>> 8) | reduced) >>> 0;
}

export function encodePxr24Chunk(raw: Uint8Array, part: PartWriteMeta, chunkY: number): Uint8Array {
  const out: number[] = [];
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let rawPtr = 0;

  for (let dy = 0; dy < part.linesPerBlock; dy++) {
    const y = chunkY + dy;
    if (y > part.dataWindow.yMax) break;

    for (const channel of part.channels) {
      if (!isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
        continue;
      }

      const count = channel.sampledWidth;

      if (channel.pixelType === 1) {
        const p0 = new Uint8Array(count);
        const p1 = new Uint8Array(count);
        let prev = 0;

        for (let i = 0; i < count; i++) {
          const pixel = view.getUint16(rawPtr, true);
          rawPtr += 2;
          const diff = (pixel - prev) >>> 0;
          prev = pixel;
          p0[i] = (diff >>> 8) & 0xff;
          p1[i] = diff & 0xff;
        }

        out.push(...p0, ...p1);
        continue;
      }

      if (channel.pixelType === 0) {
        const p0 = new Uint8Array(count);
        const p1 = new Uint8Array(count);
        const p2 = new Uint8Array(count);
        const p3 = new Uint8Array(count);
        let prev = 0;

        for (let i = 0; i < count; i++) {
          const pixel = view.getUint32(rawPtr, true);
          rawPtr += 4;
          const diff = (pixel - prev) >>> 0;
          prev = pixel;
          p0[i] = (diff >>> 24) & 0xff;
          p1[i] = (diff >>> 16) & 0xff;
          p2[i] = (diff >>> 8) & 0xff;
          p3[i] = diff & 0xff;
        }

        out.push(...p0, ...p1, ...p2, ...p3);
        continue;
      }

      const p0 = new Uint8Array(count);
      const p1 = new Uint8Array(count);
      const p2 = new Uint8Array(count);
      let prev = 0;

      for (let i = 0; i < count; i++) {
        const bits = view.getUint32(rawPtr, true);
        rawPtr += 4;
        const pixel24 = floatBitsToFloat24Bits(bits);
        const diff = (pixel24 - prev) >>> 0;
        prev = pixel24;
        p0[i] = (diff >>> 16) & 0xff;
        p1[i] = (diff >>> 8) & 0xff;
        p2[i] = diff & 0xff;
      }

      out.push(...p0, ...p1, ...p2);
    }
  }

  if (rawPtr !== raw.byteLength) {
    throw new ExrError('ENCODING_FAILED', 'PXR24 encoder consumed an unexpected raw block length.', {
      consumed: rawPtr,
      expected: raw.byteLength,
    });
  }

  const packed = Uint8Array.from(out);
  const encoded = zlibSync(packed);
  return encoded.byteLength >= raw.byteLength ? raw : encoded;
}
