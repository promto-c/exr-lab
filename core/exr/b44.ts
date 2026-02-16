import { ExrError } from './errors';
import { float16ToFloat32 } from './half';
import { ExrPart } from './types';

const HALF_VALUES_PER_BLOCK = 16;
const B44_BLOCK_SIZE = 14;
const B44A_BLOCK_SIZE = 3;
const B44A_MARKER_THRESHOLD = 13 << 2;

const floatScratch = new ArrayBuffer(4);
const floatView = new Float32Array(floatScratch);
const uintView = new Uint32Array(floatScratch);

let b44ToLinearTable: Uint16Array | null = null;

interface B44ChannelLayout {
  channel: ExrPart['channels'][number];
  bytesPerSample: number;
  sampledWidth: number;
  sampledRows: number;
  sampleOriginY: number;
  ySampling: number;
  firstChunkSampleY: number;
  plane: Uint8Array;
}

export interface B44DecodeContext {
  buffer: ArrayBuffer;
  dataPtr: number;
  dataSize: number;
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

function firstSampleInRange(
  min: number,
  max: number,
  sampleOrigin: number,
  sampling: number,
): number | null {
  if (max < min) return null;
  if (sampling <= 1) return min;

  const delta = min - sampleOrigin;
  const remainder = modulo(delta, sampling);
  const first = remainder === 0 ? min : min + (sampling - remainder);
  return first <= max ? first : null;
}

function float32ToFloat16(value: number): number {
  if (Object.is(value, -0)) return 0x8000;
  if (Object.is(value, 0)) return 0;
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 0x7e00;
    return value < 0 ? 0xfc00 : 0x7c00;
  }

  floatView[0] = value;
  const bits = uintView[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;

  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const m = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((m + 0x1000) >> 13);
  }

  if (exponent >= 0x1f) {
    return sign | 0x7c00;
  }

  return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
}

function convertB44ToLinear(value: number): number {
  if ((value & 0x7c00) === 0x7c00) return 0;
  if (value > 0x8000) return 0;

  const floatValue = float16ToFloat32(value);
  const converted = 8 * Math.log(floatValue);
  return float32ToFloat16(converted);
}

function getB44ToLinearTable(): Uint16Array {
  if (b44ToLinearTable) {
    return b44ToLinearTable;
  }

  const table = new Uint16Array(1 << 16);
  for (let i = 0; i < table.length; i++) {
    table[i] = convertB44ToLinear(i);
  }

  b44ToLinearTable = table;
  return table;
}

function unpack14(source: Uint8Array, offset: number, out: Uint16Array) {
  const shift = source[offset + 2] >> 2;
  const bias = 0x20 << shift;

  out[0] = (source[offset] << 8) | source[offset + 1];

  out[4] = (out[0] + (((((source[offset + 2] << 4) | (source[offset + 3] >> 4)) & 0x3f) << shift) - bias)) & 0xffff;
  out[8] = (out[4] + (((((source[offset + 3] << 2) | (source[offset + 4] >> 6)) & 0x3f) << shift) - bias)) & 0xffff;
  out[12] = (out[8] + ((((source[offset + 4] & 0x3f) << shift) - bias))) & 0xffff;

  out[1] = (out[0] + (((source[offset + 5] >> 2) << shift) - bias)) & 0xffff;
  out[5] = (out[4] + (((((source[offset + 5] << 4) | (source[offset + 6] >> 4)) & 0x3f) << shift) - bias)) & 0xffff;
  out[9] = (out[8] + (((((source[offset + 6] << 2) | (source[offset + 7] >> 6)) & 0x3f) << shift) - bias)) & 0xffff;
  out[13] = (out[12] + ((((source[offset + 7] & 0x3f) << shift) - bias))) & 0xffff;

  out[2] = (out[1] + (((source[offset + 8] >> 2) << shift) - bias)) & 0xffff;
  out[6] = (out[5] + (((((source[offset + 8] << 4) | (source[offset + 9] >> 4)) & 0x3f) << shift) - bias)) & 0xffff;
  out[10] = (out[9] + (((((source[offset + 9] << 2) | (source[offset + 10] >> 6)) & 0x3f) << shift) - bias)) & 0xffff;
  out[14] = (out[13] + ((((source[offset + 10] & 0x3f) << shift) - bias))) & 0xffff;

  out[3] = (out[2] + (((source[offset + 11] >> 2) << shift) - bias)) & 0xffff;
  out[7] = (out[6] + (((((source[offset + 11] << 4) | (source[offset + 12] >> 4)) & 0x3f) << shift) - bias)) & 0xffff;
  out[11] = (out[10] + (((((source[offset + 12] << 2) | (source[offset + 13] >> 6)) & 0x3f) << shift) - bias)) & 0xffff;
  out[15] = (out[14] + ((((source[offset + 13] & 0x3f) << shift) - bias))) & 0xffff;

  for (let i = 0; i < HALF_VALUES_PER_BLOCK; i++) {
    const value = out[i];
    out[i] = (value & 0x8000) !== 0 ? (value & 0x7fff) : (~value & 0xffff);
  }
}

function unpack3(source: Uint8Array, offset: number, out: Uint16Array) {
  let value = (source[offset] << 8) | source[offset + 1];
  value = (value & 0x8000) !== 0 ? (value & 0x7fff) : (~value & 0xffff);
  out.fill(value);
}

function buildChannelLayouts(context: B44DecodeContext): B44ChannelLayout[] {
  const part = context.part;
  const dataWindow = part.dataWindow;
  if (!dataWindow) {
    throw new Error('B44 decode requires part dataWindow.');
  }

  const chunkStart = context.chunkY;
  const chunkEnd = context.chunkY + context.linesInChunk - 1;

  const layouts: B44ChannelLayout[] = [];

  for (const channel of part.channels) {
    const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
    const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;
    const sampleOriginY = firstSampleCoordinate(dataWindow.yMin, ySampling);
    const sampledWidth = countSamplesInRange(dataWindow.xMin, dataWindow.xMax, xSampling);
    const bytesPerSample = channel.pixelType === 1 ? 2 : 4;

    const visibleStart = Math.max(chunkStart, dataWindow.yMin);
    const visibleEnd = Math.min(chunkEnd, dataWindow.yMax);

    let sampledRows = 0;
    let firstChunkSampleY = -1;
    if (visibleEnd >= visibleStart) {
      const first = firstSampleInRange(visibleStart, visibleEnd, sampleOriginY, ySampling);
      if (first !== null) {
        firstChunkSampleY = first;
        sampledRows = Math.floor((visibleEnd - first) / ySampling) + 1;
      }
    }

    const planeSize = sampledWidth * sampledRows * bytesPerSample;

    layouts.push({
      channel,
      bytesPerSample,
      sampledWidth,
      sampledRows,
      sampleOriginY,
      ySampling,
      firstChunkSampleY,
      plane: new Uint8Array(planeSize),
    });
  }

  return layouts;
}

export function decodeB44Block(context: B44DecodeContext): Uint8Array {
  try {
    const part = context.part;
    const dataWindow = part.dataWindow;
    if (!dataWindow) {
      throw new Error('B44 decode requires part dataWindow.');
    }

    const source = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
    const layouts = buildChannelLayouts(context);
    const halfBlock = new Uint16Array(HALF_VALUES_PER_BLOCK);
    const chunkStart = context.chunkY;
    const chunkEnd = context.chunkY + context.linesInChunk - 1;

    let sourceCursor = 0;

    for (const layout of layouts) {
      if (layout.plane.length === 0) {
        continue;
      }

      if (layout.channel.pixelType !== 1) {
        if (sourceCursor + layout.plane.length > source.length) {
          throw new Error('Truncated B44 payload for non-HALF channel data.');
        }

        layout.plane.set(source.subarray(sourceCursor, sourceCursor + layout.plane.length));
        sourceCursor += layout.plane.length;
        continue;
      }

      const blocksY = Math.ceil(layout.sampledRows / 4);
      const blocksX = Math.ceil(layout.sampledWidth / 4);
      const applyPLinear = layout.channel.pLinear !== 0;
      const toLinearTable = applyPLinear ? getB44ToLinearTable() : null;

      for (let blockY = 0; blockY < blocksY; blockY++) {
        const rowBase = blockY * 4;
        const rowsInBlock = Math.min(4, layout.sampledRows - rowBase);

        for (let blockX = 0; blockX < blocksX; blockX++) {
          const colBase = blockX * 4;
          const colsInBlock = Math.min(4, layout.sampledWidth - colBase);

          if (sourceCursor + B44A_BLOCK_SIZE > source.length) {
            throw new Error('Truncated B44 payload while reading block header.');
          }

          if (source[sourceCursor + 2] >= B44A_MARKER_THRESHOLD) {
            unpack3(source, sourceCursor, halfBlock);
            sourceCursor += B44A_BLOCK_SIZE;
          } else {
            if (sourceCursor + B44_BLOCK_SIZE > source.length) {
              throw new Error('Truncated B44 payload while reading 14-byte block.');
            }
            unpack14(source, sourceCursor, halfBlock);
            sourceCursor += B44_BLOCK_SIZE;
          }

          if (toLinearTable) {
            for (let i = 0; i < HALF_VALUES_PER_BLOCK; i++) {
              halfBlock[i] = toLinearTable[halfBlock[i]];
            }
          }

          for (let row = 0; row < rowsInBlock; row++) {
            const rowIndex = rowBase + row;
            const rowOffset = rowIndex * layout.sampledWidth;
            const srcRowOffset = row * 4;

            for (let col = 0; col < colsInBlock; col++) {
              const dstIndex = (rowOffset + colBase + col) * 2;
              const value = halfBlock[srcRowOffset + col];
              layout.plane[dstIndex] = value & 0xff;
              layout.plane[dstIndex + 1] = value >> 8;
            }
          }
        }
      }
    }

    const outputSize = layouts.reduce((total, layout) => total + layout.plane.length, 0);
    const output = new Uint8Array(outputSize);
    let outputCursor = 0;

    for (let y = chunkStart; y <= chunkEnd; y++) {
      if (y < dataWindow.yMin || y > dataWindow.yMax) {
        continue;
      }

      for (const layout of layouts) {
        if (layout.sampledRows === 0 || layout.sampledWidth === 0) {
          continue;
        }

        if (!isSampledCoordinate(y, layout.sampleOriginY, layout.ySampling)) {
          continue;
        }

        if (layout.firstChunkSampleY < 0 || y < layout.firstChunkSampleY) {
          continue;
        }

        const sampledRow = Math.floor((y - layout.firstChunkSampleY) / layout.ySampling);
        if (sampledRow < 0 || sampledRow >= layout.sampledRows) {
          continue;
        }

        const rowByteLength = layout.sampledWidth * layout.bytesPerSample;
        const rowOffset = sampledRow * rowByteLength;
        output.set(layout.plane.subarray(rowOffset, rowOffset + rowByteLength), outputCursor);
        outputCursor += rowByteLength;
      }
    }

    if (outputCursor !== output.length) {
      throw new Error('B44 row packing produced an unexpected output size.');
    }

    return output;
  } catch (error) {
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress B44/B44A chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
    });
  }
}
