import { unzlibSync } from 'fflate';
import { COMPRESSION_NAMES } from './constants';
import { ExrError } from './errors';
import { ExrEvent, ExrEventCallback } from './events';
import { float16ToFloat32 } from './half';
import { decodePizBlock } from './piz';
import { decodeDwaBlock } from './dwa';
import { decodeB44Block } from './b44';
import { DecodeExrPartOptions, DecodedChannel, DecodedPart, ExrChannel, ExrPart, ExrStructure } from './types';

const UINT32_MAX = 4294967295.0;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function emit(onEvent: ExrEventCallback | undefined, event: ExrEvent) {
  onEvent?.(event);
}

function getScanlineLinesPerBlock(compression: number): number {
  switch (compression) {
    case 0:
    case 1:
    case 2:
      return 1;
    case 3:
    case 5:
      return 16;
    case 4:
    case 6:
    case 7:
    case 8:
      return 32;
    case 9:
      return 256;
    default:
      return 1;
  }
}

function undoPredictor(data: Uint8Array) {
  for (let i = 1; i < data.length; i++) {
    data[i] = (data[i - 1] + data[i] - 128) & 0xff;
  }
}

function undoInterleave(data: Uint8Array): Uint8Array {
  const length = data.length;
  const output = new Uint8Array(length);
  const half = Math.floor((length + 1) / 2);
  const first = data.subarray(0, half);
  const second = data.subarray(half);

  for (let i = 0; i < half; i++) {
    output[i * 2] = first[i];
    if (i * 2 + 1 < length) {
      output[i * 2 + 1] = second[i];
    }
  }

  return output;
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

function toNumberOffset(low: number, high: number): number {
  const combined = BigInt(low) + (BigInt(high) << 32n);
  if (combined > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ExrError('MALFORMED_OFFSET_TABLE', 'Chunk offset exceeds safe integer range.', {
      offset: combined.toString(),
    });
  }
  return Number(combined);
}

interface CompressionDecodeContext {
  buffer: ArrayBuffer;
  dataPtr: number;
  dataSize: number;
  part: ExrPart;
  partId: number;
  chunkIndex: number;
  chunkY: number;
  linesInChunk: number;
}

interface CompressionHandler {
  compressionId: number;
  name: string;
  linesPerBlock: number;
  decodeBlock: (context: CompressionDecodeContext) => Uint8Array;
}

function decodeZipStyleBlock(context: CompressionDecodeContext): Uint8Array {
  try {
    const compressed = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
    const raw = unzlibSync(compressed);
    undoPredictor(raw);
    return undoInterleave(raw);
  } catch (error) {
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress ZIP/ZIPS chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
    });
  }
}

const SUPPORTED_COMPRESSION_HANDLERS = new Map<number, CompressionHandler>([
  [
    0,
    {
      compressionId: 0,
      name: COMPRESSION_NAMES[0],
      linesPerBlock: 1,
      decodeBlock: ({ buffer, dataPtr, dataSize }) => new Uint8Array(buffer, dataPtr, dataSize),
    },
  ],
  [
    2,
    {
      compressionId: 2,
      name: COMPRESSION_NAMES[2],
      linesPerBlock: 1,
      decodeBlock: decodeZipStyleBlock,
    },
  ],
  [
    3,
    {
      compressionId: 3,
      name: COMPRESSION_NAMES[3],
      linesPerBlock: 16,
      decodeBlock: decodeZipStyleBlock,
    },
  ],
  [
    4,
    {
      compressionId: 4,
      name: COMPRESSION_NAMES[4],
      linesPerBlock: 32,
      decodeBlock: decodePizBlock,
    },
  ],
  [
    6,
    {
      compressionId: 6,
      name: COMPRESSION_NAMES[6],
      linesPerBlock: 32,
      decodeBlock: decodeB44Block,
    },
  ],
  [
    7,
    {
      compressionId: 7,
      name: COMPRESSION_NAMES[7],
      linesPerBlock: 32,
      decodeBlock: decodeB44Block,
    },
  ],
  [
    8,
    {
      compressionId: 8,
      name: COMPRESSION_NAMES[8],
      linesPerBlock: 32,
      decodeBlock: decodeDwaBlock,
    },
  ],
  [
    9,
    {
      compressionId: 9,
      name: COMPRESSION_NAMES[9],
      linesPerBlock: 256,
      decodeBlock: decodeDwaBlock,
    },
  ],
]);
// RLE_COMPRESSION (id 1) is intentionally not registered yet. Adding it next is a map entry + handler.

interface ChannelDecodeMeta {
  channel: ExrChannel;
  bytesPerSample: number;
  sampledWidth: number;
  sampledHeight: number;
  sampleOriginX: number;
  sampleOriginY: number;
  data: Float32Array;
}

function buildChannelMeta(part: ExrPart): ChannelDecodeMeta[] {
  if (!part.dataWindow) return [];

  const { xMin, xMax, yMin, yMax } = part.dataWindow;

  return part.channels.map((channel) => {
    const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
    const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;
    const sampleOriginX = firstSampleCoordinate(xMin, xSampling);
    const sampleOriginY = firstSampleCoordinate(yMin, ySampling);
    const sampledWidth = countSamplesInRange(xMin, xMax, xSampling);
    const sampledHeight = countSamplesInRange(yMin, yMax, ySampling);
    const bytesPerSample = channel.pixelType === 1 ? 2 : 4;

    return {
      channel,
      bytesPerSample,
      sampledWidth,
      sampledHeight,
      sampleOriginX,
      sampleOriginY,
      data: new Float32Array(sampledWidth * sampledHeight),
    };
  });
}

function getExpectedUncompressedChunkSize(
  part: ExrPart,
  channelMeta: ChannelDecodeMeta[],
  chunkY: number,
  linesPerBlock: number,
): number {
  if (!part.dataWindow) return 0;

  let expected = 0;

  for (let dy = 0; dy < linesPerBlock; dy++) {
    const y = chunkY + dy;
    if (y > part.dataWindow.yMax) {
      break;
    }
    if (y < part.dataWindow.yMin) {
      continue;
    }

    for (const meta of channelMeta) {
      if (meta.sampledWidth === 0 || meta.sampledHeight === 0) {
        continue;
      }

      const ySampling = meta.channel.ySampling > 0 ? meta.channel.ySampling : 1;
      if (!isSampledCoordinate(y, meta.sampleOriginY, ySampling)) {
        continue;
      }

      expected += meta.sampledWidth * meta.bytesPerSample;
    }
  }

  return expected;
}

function decodeValue(view: DataView, byteOffset: number, pixelType: number): number {
  if (pixelType === 1) {
    return float16ToFloat32(view.getUint16(byteOffset, true));
  }
  if (pixelType === 2) {
    return view.getFloat32(byteOffset, true);
  }
  return view.getUint32(byteOffset, true) / UINT32_MAX;
}

export function decodeExrPart(
  buffer: ArrayBuffer,
  structure: ExrStructure,
  options: DecodeExrPartOptions,
): DecodedPart {
  const onEvent = options.onEvent;
  const t0 = nowMs();
  const partIndex = structure.parts.findIndex((part) => part.id === options.partId);

  if (partIndex < 0) {
    throw new ExrError('PART_NOT_FOUND', `Part ${options.partId} was not found in EXR structure.`, {
      partId: options.partId,
    });
  }

  const part = structure.parts[partIndex];
  if (part.type === 'tiledimage') {
    throw new ExrError('UNSUPPORTED_PART_TYPE', 'Tiled EXR parts are not supported.', {
      partId: options.partId,
      type: part.type,
    });
  }

  const compression = part.compression ?? 0;
  const compressionHandler = SUPPORTED_COMPRESSION_HANDLERS.get(compression);
  if (!compressionHandler) {
    const supported = Array.from(SUPPORTED_COMPRESSION_HANDLERS.values())
      .map((handler) => handler.name)
      .join(', ');
    throw new ExrError('UNSUPPORTED_COMPRESSION', `Unsupported compression. Supported: ${supported}.`, {
      partId: options.partId,
      compression,
    });
  }

  if (!part.dataWindow) {
    throw new ExrError('MISSING_DATA_WINDOW', 'EXR part is missing required dataWindow.', {
      partId: options.partId,
    });
  }

  const view = new DataView(buffer);
  const width = part.dataWindow.xMax - part.dataWindow.xMin + 1;
  const height = part.dataWindow.yMax - part.dataWindow.yMin + 1;
  const linesPerBlock = compressionHandler.linesPerBlock;
  const chunkCount = Math.ceil(height / linesPerBlock);

  emit(onEvent, {
    phase: 'decode',
    level: 'info',
    code: 'decode.setup',
    message: `Decoder setup for part ${part.id}.`,
    metrics: {
      partId: part.id,
      width,
      height,
      channels: part.channels.length,
      compression: compressionHandler.name || COMPRESSION_NAMES[compression] || 'UNKNOWN',
      chunks: chunkCount,
    },
  });

  let offsetTablePtr = structure.headerEndOffset;

  for (let i = 0; i < partIndex; i++) {
    const prior = structure.parts[i];
    if (!prior.dataWindow) continue;
    const priorHeight = prior.dataWindow.yMax - prior.dataWindow.yMin + 1;
    const priorChunks = Math.ceil(priorHeight / getScanlineLinesPerBlock(prior.compression ?? 0));
    offsetTablePtr += priorChunks * 8;
  }

  if (offsetTablePtr < 0 || offsetTablePtr + chunkCount * 8 > view.byteLength) {
    throw new ExrError('MALFORMED_OFFSET_TABLE', 'Offset table is truncated or invalid.', {
      partId: options.partId,
      offsetTablePtr,
      chunkCount,
      size: view.byteLength,
    });
  }

  const tOffsets = nowMs();
  const chunkOffsets: number[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const low = view.getUint32(offsetTablePtr + i * 8, true);
    const high = view.getUint32(offsetTablePtr + i * 8 + 4, true);
    chunkOffsets[i] = toNumberOffset(low, high);
  }

  emit(onEvent, {
    phase: 'decode',
    level: 'info',
    code: 'decode.offsets.read',
    message: 'Read chunk offsets.',
    metrics: {
      partId: part.id,
      count: chunkOffsets.length,
      ms: (nowMs() - tOffsets).toFixed(3),
    },
  });

  const channelMeta = buildChannelMeta(part);

  const tDecode = nowMs();
  let bytesRead = 0;

  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex++) {
    const chunkOffset = chunkOffsets[chunkIndex];

    const chunkHeaderSize = structure.isMultipart ? 12 : 8;
    if (chunkOffset < 0 || chunkOffset + chunkHeaderSize > view.byteLength) {
      throw new ExrError('MALFORMED_CHUNK', 'Chunk header is outside file bounds.', {
        partId: part.id,
        chunkIndex,
        chunkOffset,
      });
    }

    let chunkY = 0;
    let dataSize = 0;
    let dataPtr = chunkOffset;

    if (structure.isMultipart) {
      const partNumber = view.getInt32(chunkOffset, true);
      chunkY = view.getInt32(chunkOffset + 4, true);
      dataSize = view.getInt32(chunkOffset + 8, true);
      dataPtr = chunkOffset + 12;

      if (partNumber !== part.id) {
        emit(onEvent, {
          phase: 'decode',
          level: 'warn',
          code: 'decode.chunk.part_mismatch',
          message: 'Skipped chunk whose part number did not match requested part.',
          metrics: {
            chunkIndex,
            expectedPart: part.id,
            actualPart: partNumber,
          },
        });
        continue;
      }
    } else {
      chunkY = view.getInt32(chunkOffset, true);
      dataSize = view.getInt32(chunkOffset + 4, true);
      dataPtr = chunkOffset + 8;
    }

    if (dataSize < 0 || dataPtr < 0 || dataPtr + dataSize > view.byteLength) {
      throw new ExrError('MALFORMED_CHUNK', 'Chunk payload is outside file bounds.', {
        partId: part.id,
        chunkIndex,
        chunkY,
        dataPtr,
        dataSize,
      });
    }

    const linesInChunk = Math.max(0, Math.min(linesPerBlock, part.dataWindow.yMax - chunkY + 1));

    const expectedUncompressedSize = getExpectedUncompressedChunkSize(
      part,
      channelMeta,
      chunkY,
      linesPerBlock,
    );

    // OpenEXR chunks may be stored raw when compression is ineffective.
    const blockData =
      dataSize === expectedUncompressedSize
        ? new Uint8Array(buffer, dataPtr, dataSize)
        : compressionHandler.decodeBlock({
            buffer,
            dataPtr,
            dataSize,
            part,
            partId: part.id,
            chunkIndex,
            chunkY,
            linesInChunk,
          });

    bytesRead += dataSize;

    let blockPointer = 0;

    for (let dy = 0; dy < linesPerBlock; dy++) {
      const y = chunkY + dy;
      if (y > part.dataWindow.yMax) {
        break;
      }
      if (y < part.dataWindow.yMin) {
        continue;
      }

      for (const meta of channelMeta) {
        if (meta.sampledWidth === 0 || meta.sampledHeight === 0) {
          continue;
        }

        const ySampling = meta.channel.ySampling > 0 ? meta.channel.ySampling : 1;
        if (!isSampledCoordinate(y, meta.sampleOriginY, ySampling)) {
          continue;
        }

        const byteLength = meta.sampledWidth * meta.bytesPerSample;
        if (blockPointer + byteLength > blockData.byteLength) {
          throw new ExrError('MALFORMED_CHUNK', 'Chunk row data exceeded block payload bounds.', {
            partId: part.id,
            chunkIndex,
            row: y,
            channel: meta.channel.name,
            blockPointer,
            byteLength,
            blockSize: blockData.byteLength,
          });
        }

        const sampledRow = Math.floor((y - meta.sampleOriginY) / ySampling);
        if (sampledRow < 0 || sampledRow >= meta.sampledHeight) {
          blockPointer += byteLength;
          continue;
        }

        const rowOffset = sampledRow * meta.sampledWidth;
        const rowView = new DataView(blockData.buffer, blockData.byteOffset + blockPointer, byteLength);

        for (let sx = 0; sx < meta.sampledWidth; sx++) {
          const sourceOffset = sx * meta.bytesPerSample;
          meta.data[rowOffset + sx] = decodeValue(rowView, sourceOffset, meta.channel.pixelType);
        }

        blockPointer += byteLength;
      }
    }

    if (blockPointer < blockData.byteLength) {
      emit(onEvent, {
        phase: 'decode',
        level: 'warn',
        code: 'decode.chunk.trailing_bytes',
        message: 'Chunk had trailing bytes after row decode.',
        metrics: {
          partId: part.id,
          chunkIndex,
          trailing: blockData.byteLength - blockPointer,
        },
      });
    }
  }

  const decodedChannels: Record<string, DecodedChannel> = {};
  for (const meta of channelMeta) {
    decodedChannels[meta.channel.name] = {
      pixelType: meta.channel.pixelType,
      xSampling: meta.channel.xSampling,
      ySampling: meta.channel.ySampling,
      sampledWidth: meta.sampledWidth,
      sampledHeight: meta.sampledHeight,
      sampleOriginX: meta.sampleOriginX,
      sampleOriginY: meta.sampleOriginY,
      data: meta.data,
    };
  }

  emit(onEvent, {
    phase: 'decode',
    level: 'info',
    code: 'decode.complete',
    message: `Decoded part ${part.id}.`,
    metrics: {
      partId: part.id,
      channels: Object.keys(decodedChannels).length,
      readKB: (bytesRead / 1024).toFixed(1),
      ms: (nowMs() - tDecode).toFixed(3),
      totalMs: (nowMs() - t0).toFixed(3),
    },
  });

  return {
    width,
    height,
    channels: decodedChannels,
  };
}
