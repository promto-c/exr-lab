import { ExrError } from '../../shared/errors';
import { float16ToFloat32, float32ToFloat16 } from '../../shared/half';
import { PartWriteMeta } from '../meta';
import { isSampledCoordinate } from '../sampling';

const B44_BLOCK_SIZE = 14;
const B44A_BLOCK_MARKER = 0xfc;

const B44A_COMPRESSION = 7;

interface ChunkChannelPlane {
  channel: PartWriteMeta['channels'][number];
  sampledRows: number;
  plane: Uint8Array;
}

function countSampledRowsInChunk(
  channel: PartWriteMeta['channels'][number],
  chunkY: number,
  linesInChunk: number,
): number {
  let rows = 0;
  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;
    if (isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
      rows++;
    }
  }
  return rows;
}

function buildChunkChannelPlanes(
  raw: Uint8Array,
  part: PartWriteMeta,
  chunkY: number,
  linesInChunk: number,
): ChunkChannelPlane[] {
  const planes = part.channels.map((channel) => {
    const sampledRows = countSampledRowsInChunk(channel, chunkY, linesInChunk);
    return {
      channel,
      sampledRows,
      plane: new Uint8Array(channel.rowByteLength * sampledRows),
      writePtr: 0,
    };
  });

  let rawPtr = 0;

  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;

    for (let channelIndex = 0; channelIndex < part.channels.length; channelIndex++) {
      const plane = planes[channelIndex];
      const channel = plane.channel;
      if (!isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
        continue;
      }

      const rowSize = channel.rowByteLength;
      if (rawPtr + rowSize > raw.byteLength) {
        throw new ExrError('ENCODING_FAILED', 'Failed to split raw chunk into channel planes.', {
          consumed: rawPtr,
          expected: raw.byteLength,
          rowSize,
        });
      }

      plane.plane.set(raw.subarray(rawPtr, rawPtr + rowSize), plane.writePtr);
      plane.writePtr += rowSize;
      rawPtr += rowSize;
    }
  }

  if (rawPtr !== raw.byteLength) {
    throw new ExrError('ENCODING_FAILED', 'Raw chunk split consumed an unexpected number of bytes.', {
      consumed: rawPtr,
      expected: raw.byteLength,
    });
  }

  return planes.map((plane) => ({
    channel: plane.channel,
    sampledRows: plane.sampledRows,
    plane: plane.plane,
  }));
}

function transformHalfForB44(halfValue: number): number {
  if ((halfValue & 0x7c00) === 0x7c00) {
    return 0x8000;
  }
  if ((halfValue & 0x8000) !== 0) {
    return ~halfValue & 0xffff;
  }
  return halfValue | 0x8000;
}

function convertLinearToB44Half(halfValue: number): number {
  if ((halfValue & 0x7c00) === 0x7c00) {
    return 0;
  }
  if (halfValue >= 0x558c && halfValue < 0x8000) {
    return 0x7bff;
  }

  const linearValue = float16ToFloat32(halfValue);
  if (!Number.isFinite(linearValue)) {
    return 0;
  }

  const mapped = Math.exp(linearValue / 8);
  return float32ToFloat16(mapped);
}

function signedDelta16(current: number, previous: number): number {
  const diff = (current - previous) & 0xffff;
  return diff >= 0x8000 ? diff - 0x10000 : diff;
}

function clampUint6(value: number): number {
  if (value < 0) return 0;
  if (value > 63) return 63;
  return value | 0;
}

function packB44Block14(transformed: Uint16Array): Uint8Array {
  const deltas = [
    signedDelta16(transformed[4], transformed[0]),
    signedDelta16(transformed[8], transformed[4]),
    signedDelta16(transformed[12], transformed[8]),
    signedDelta16(transformed[1], transformed[0]),
    signedDelta16(transformed[5], transformed[4]),
    signedDelta16(transformed[9], transformed[8]),
    signedDelta16(transformed[13], transformed[12]),
    signedDelta16(transformed[2], transformed[1]),
    signedDelta16(transformed[6], transformed[5]),
    signedDelta16(transformed[10], transformed[9]),
    signedDelta16(transformed[14], transformed[13]),
    signedDelta16(transformed[3], transformed[2]),
    signedDelta16(transformed[7], transformed[6]),
    signedDelta16(transformed[11], transformed[10]),
    signedDelta16(transformed[15], transformed[14]),
  ];

  let shift = 0;
  for (; shift < 15; shift++) {
    const step = 1 << shift;
    const minDelta = -(32 * step);
    const maxDelta = 31 * step;
    const fits = deltas.every((delta) => delta >= minDelta && delta <= maxDelta);
    if (fits) break;
  }

  const step = 1 << shift;
  const bias = 32 * step;
  const q = deltas.map((delta) => clampUint6(Math.round((delta + bias) / step)));

  const out = new Uint8Array(B44_BLOCK_SIZE);
  out[0] = (transformed[0] >> 8) & 0xff;
  out[1] = transformed[0] & 0xff;
  out[2] = ((shift & 0x3f) << 2) | ((q[0] >> 4) & 0x03);
  out[3] = ((q[0] & 0x0f) << 4) | ((q[1] >> 2) & 0x0f);
  out[4] = ((q[1] & 0x03) << 6) | (q[2] & 0x3f);
  out[5] = ((q[3] & 0x3f) << 2) | ((q[4] >> 4) & 0x03);
  out[6] = ((q[4] & 0x0f) << 4) | ((q[5] >> 2) & 0x0f);
  out[7] = ((q[5] & 0x03) << 6) | (q[6] & 0x3f);
  out[8] = ((q[7] & 0x3f) << 2) | ((q[8] >> 4) & 0x03);
  out[9] = ((q[8] & 0x0f) << 4) | ((q[9] >> 2) & 0x0f);
  out[10] = ((q[9] & 0x03) << 6) | (q[10] & 0x3f);
  out[11] = ((q[11] & 0x3f) << 2) | ((q[12] >> 4) & 0x03);
  out[12] = ((q[12] & 0x0f) << 4) | ((q[13] >> 2) & 0x0f);
  out[13] = ((q[13] & 0x03) << 6) | (q[14] & 0x3f);
  return out;
}

function encodeHalfPlaneB44(
  plane: Uint8Array,
  sampledWidth: number,
  sampledRows: number,
  compression: number,
  applyPLinear: boolean,
): Uint8Array {
  if (sampledWidth <= 0 || sampledRows <= 0) {
    return new Uint8Array(0);
  }

  const view = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
  const blocksX = Math.ceil(sampledWidth / 4);
  const blocksY = Math.ceil(sampledRows / 4);
  const out: number[] = [];
  const transformed = new Uint16Array(16);

  for (let blockY = 0; blockY < blocksY; blockY++) {
    const startY = blockY * 4;

    for (let blockX = 0; blockX < blocksX; blockX++) {
      const startX = blockX * 4;

      for (let row = 0; row < 4; row++) {
        const sourceY = Math.min(startY + row, sampledRows - 1);
        for (let col = 0; col < 4; col++) {
          const sourceX = Math.min(startX + col, sampledWidth - 1);
          const sampleIndex = sourceY * sampledWidth + sourceX;
          const sourceHalf = view.getUint16(sampleIndex * 2, true);
          const half = applyPLinear ? convertLinearToB44Half(sourceHalf) : sourceHalf;
          transformed[row * 4 + col] = transformHalfForB44(half);
        }
      }

      const first = transformed[0];
      let isFlat = true;
      for (let i = 1; i < transformed.length; i++) {
        if (transformed[i] !== first) {
          isFlat = false;
          break;
        }
      }

      if (compression === B44A_COMPRESSION && isFlat) {
        out.push((first >> 8) & 0xff, first & 0xff, B44A_BLOCK_MARKER);
        continue;
      }

      const block = packB44Block14(transformed);
      out.push(...block);
    }
  }

  return Uint8Array.from(out);
}

export function encodeB44Chunk(raw: Uint8Array, part: PartWriteMeta, chunkY: number): Uint8Array {
  const linesInChunk = Math.max(0, Math.min(part.linesPerBlock, part.dataWindow.yMax - chunkY + 1));
  const channelPlanes = buildChunkChannelPlanes(raw, part, chunkY, linesInChunk);
  const out: number[] = [];

  for (const channelPlane of channelPlanes) {
    if (channelPlane.channel.pixelType === 1) {
      const encodedHalfPlane = encodeHalfPlaneB44(
        channelPlane.plane,
        channelPlane.channel.sampledWidth,
        channelPlane.sampledRows,
        part.compression,
        channelPlane.channel.pLinear !== 0,
      );
      out.push(...encodedHalfPlane);
      continue;
    }

    out.push(...channelPlane.plane);
  }

  const encoded = Uint8Array.from(out);
  return encoded.byteLength >= raw.byteLength ? raw : encoded;
}
