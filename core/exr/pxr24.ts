import { unzlibSync } from 'fflate';
import { ExrError } from './errors';
import { ExrPart } from './types';

interface Pxr24ChannelLayout {
  pixelType: number;
  sampledWidth: number;
  sampleOriginY: number;
  ySampling: number;
  bytesPerSample: number;
}

interface Pxr24RowPlan {
  pixelType: number;
  sampledWidth: number;
  bytesPerSample: number;
}

export interface Pxr24DecodeContext {
  buffer: ArrayBuffer;
  dataPtr: number;
  dataSize: number;
  expectedUncompressedSize: number;
  part: ExrPart;
  partId: number;
  chunkIndex: number;
  chunkY: number;
  linesInChunk: number;
}

function modulo(value: number, base: number): number {
  const result = value % base;
  return result < 0 ? result + base : result;
}

function firstSampleCoordinate(min: number, sampling: number): number {
  if (sampling <= 1) return min;
  const remainder = modulo(min, sampling);
  return remainder === 0 ? min : min + (sampling - remainder);
}

function countSamplesInRange(min: number, max: number, sampling: number): number {
  if (sampling <= 0 || max < min) return 0;
  const first = firstSampleCoordinate(min, sampling);
  if (first > max) return 0;
  return Math.floor((max - first) / sampling) + 1;
}

function isSampledCoordinate(value: number, firstSample: number, sampling: number): boolean {
  if (sampling <= 1) return true;
  if (value < firstSample) return false;
  return (value - firstSample) % sampling === 0;
}

function buildRowPlan(context: Pxr24DecodeContext): {
  rows: Pxr24RowPlan[];
  encodedSize: number;
  decodedSize: number;
} {
  const dataWindow = context.part.dataWindow;
  if (!dataWindow) {
    throw new Error('PXR24 decode requires part dataWindow.');
  }

  const channelLayouts: Pxr24ChannelLayout[] = context.part.channels.map((channel) => {
    const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
    const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;
    const sampleOriginY = firstSampleCoordinate(dataWindow.yMin, ySampling);
    const sampledWidth = countSamplesInRange(dataWindow.xMin, dataWindow.xMax, xSampling);
    const bytesPerSample = channel.pixelType === 1 ? 2 : 4;

    return {
      pixelType: channel.pixelType,
      sampledWidth,
      sampleOriginY,
      ySampling,
      bytesPerSample,
    };
  });

  const rows: Pxr24RowPlan[] = [];
  let encodedSize = 0;
  let decodedSize = 0;

  for (let dy = 0; dy < context.linesInChunk; dy++) {
    const y = context.chunkY + dy;
    if (y < dataWindow.yMin || y > dataWindow.yMax) {
      continue;
    }

    for (const layout of channelLayouts) {
      if (layout.sampledWidth === 0) {
        continue;
      }
      if (!isSampledCoordinate(y, layout.sampleOriginY, layout.ySampling)) {
        continue;
      }

      rows.push({
        pixelType: layout.pixelType,
        sampledWidth: layout.sampledWidth,
        bytesPerSample: layout.bytesPerSample,
      });

      const encodedBytesPerSample = layout.pixelType === 2 ? 3 : layout.bytesPerSample;
      encodedSize += layout.sampledWidth * encodedBytesPerSample;
      decodedSize += layout.sampledWidth * layout.bytesPerSample;
    }
  }

  return { rows, encodedSize, decodedSize };
}

export function decodePxr24Block(context: Pxr24DecodeContext): Uint8Array {
  try {
    const compressed = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
    const unpacked = unzlibSync(compressed);
    const plan = buildRowPlan(context);

    if (unpacked.byteLength !== plan.encodedSize) {
      throw new Error('Invalid PXR24 intermediate payload length.');
    }
    if (plan.decodedSize !== context.expectedUncompressedSize) {
      throw new Error('Invalid PXR24 expected output length.');
    }

    const out = new Uint8Array(plan.decodedSize);

    let unpackedPtr = 0;
    let outPtr = 0;

    for (const row of plan.rows) {
      const width = row.sampledWidth;

      if (row.pixelType === 1) {
        const needed = width * 2;
        if (unpackedPtr + needed > unpacked.length) {
          throw new Error('Truncated PXR24 HALF payload.');
        }

        let p0 = unpackedPtr;
        let p1 = p0 + width;
        unpackedPtr += needed;

        let pixel = 0;
        for (let x = 0; x < width; x++) {
          const diff = (((unpacked[p0++] << 8) | unpacked[p1++]) >>> 0);
          pixel = (pixel + diff) >>> 0;
          out[outPtr++] = pixel & 0xff;
          out[outPtr++] = (pixel >>> 8) & 0xff;
        }
        continue;
      }

      if (row.pixelType === 0) {
        const needed = width * 4;
        if (unpackedPtr + needed > unpacked.length) {
          throw new Error('Truncated PXR24 UINT payload.');
        }

        let p0 = unpackedPtr;
        let p1 = p0 + width;
        let p2 = p1 + width;
        let p3 = p2 + width;
        unpackedPtr += needed;

        let pixel = 0;
        for (let x = 0; x < width; x++) {
          const diff =
            (((unpacked[p0++] << 24) >>> 0) |
              ((unpacked[p1++] << 16) >>> 0) |
              ((unpacked[p2++] << 8) >>> 0) |
              (unpacked[p3++] >>> 0)) >>>
            0;
          pixel = (pixel + diff) >>> 0;
          out[outPtr++] = pixel & 0xff;
          out[outPtr++] = (pixel >>> 8) & 0xff;
          out[outPtr++] = (pixel >>> 16) & 0xff;
          out[outPtr++] = (pixel >>> 24) & 0xff;
        }
        continue;
      }

      if (row.pixelType === 2) {
        const needed = width * 3;
        if (unpackedPtr + needed > unpacked.length) {
          throw new Error('Truncated PXR24 FLOAT payload.');
        }

        let p0 = unpackedPtr;
        let p1 = p0 + width;
        let p2 = p1 + width;
        unpackedPtr += needed;

        let pixel = 0;
        for (let x = 0; x < width; x++) {
          const diff =
            (((unpacked[p0++] << 24) >>> 0) |
              ((unpacked[p1++] << 16) >>> 0) |
              ((unpacked[p2++] << 8) >>> 0)) >>>
            0;
          pixel = (pixel + diff) >>> 0;
          out[outPtr++] = pixel & 0xff;
          out[outPtr++] = (pixel >>> 8) & 0xff;
          out[outPtr++] = (pixel >>> 16) & 0xff;
          out[outPtr++] = (pixel >>> 24) & 0xff;
        }
        continue;
      }

      throw new Error(`Unsupported PXR24 pixel type ${row.pixelType}.`);
    }

    if (unpackedPtr !== unpacked.length || outPtr !== out.length) {
      throw new Error('PXR24 payload decode bounds mismatch.');
    }

    return out;
  } catch (error) {
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress PXR24 chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
      expected: context.expectedUncompressedSize,
    });
  }
}
