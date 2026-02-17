import { unzlibSync } from 'fflate';
import { COMPRESSION_NAMES } from './constants';
import { ExrError } from './errors';
import { ExrEvent, ExrEventCallback } from './events';
import { float16ToFloat32 } from './half';
import { decodePizBlock } from './piz';
import { decodeDwaBlock } from './dwa';
import { decodeB44Block } from './b44';
import { decodeRleBlock } from './rle';
import { decodePxr24Block } from './pxr24';
import { DecodeExrPartOptions, DecodedChannel, DecodedPart, ExrChannel, ExrPart, ExrStructure } from './types';

const UINT32_MAX = 4294967295.0;
const INV_UINT32_MAX = 1 / UINT32_MAX;

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

function undoZipPredictorAndInterleave(data: Uint8Array, output: Uint8Array): Uint8Array {
  const length = data.length;
  if (length === 0) return data;

  const half = (length + 1) >> 1;

  let predicted = data[0];
  output[0] = predicted;

  for (let i = 1; i < half; i++) {
    predicted = (predicted + data[i] - 128) & 0xff;
    output[i << 1] = predicted;
  }

  for (let i = half; i < length; i++) {
    predicted = (predicted + data[i] - 128) & 0xff;
    output[((i - half) << 1) + 1] = predicted;
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
  // Most files stay within 53-bit safe range and avoid BigInt overhead.
  if (high <= 0x1fffff) {
    return high * 4294967296 + low;
  }

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
  expectedUncompressedSize: number;
  part: ExrPart;
  partId: number;
  chunkIndex: number;
  chunkY: number;
  linesInChunk: number;
  zipScratch?: ZipDecodeScratch;
}

interface CompressionHandler {
  compressionId: number;
  name: string;
  linesPerBlock: number;
  decodeBlock: (context: CompressionDecodeContext) => Uint8Array;
}

interface ZipDecodeScratch {
  inflate: Uint8Array;
  output: Uint8Array;
}

function decodeZipStyleBlock(context: CompressionDecodeContext): Uint8Array {
  try {
    const compressed = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
    let raw: Uint8Array;

    if (context.expectedUncompressedSize > 0 && context.zipScratch) {
      if (context.zipScratch.inflate.byteLength < context.expectedUncompressedSize) {
        context.zipScratch.inflate = new Uint8Array(context.expectedUncompressedSize);
      }

      const inflateOut = context.zipScratch.inflate.subarray(0, context.expectedUncompressedSize);
      raw = unzlibSync(compressed, { out: inflateOut });
    } else if (context.expectedUncompressedSize > 0) {
      raw = unzlibSync(compressed, { out: new Uint8Array(context.expectedUncompressedSize) });
    } else {
      raw = unzlibSync(compressed);
    }

    if (context.zipScratch) {
      if (context.zipScratch.output.byteLength < raw.byteLength) {
        context.zipScratch.output = new Uint8Array(raw.byteLength);
      }

      const output = context.zipScratch.output.subarray(0, raw.byteLength);
      return undoZipPredictorAndInterleave(raw, output);
    }

    return undoZipPredictorAndInterleave(raw, new Uint8Array(raw.byteLength));
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
    1,
    {
      compressionId: 1,
      name: COMPRESSION_NAMES[1],
      linesPerBlock: 1,
      decodeBlock: decodeRleBlock,
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
    5,
    {
      compressionId: 5,
      name: COMPRESSION_NAMES[5],
      linesPerBlock: 16,
      decodeBlock: decodePxr24Block,
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

interface ChannelDecodeMeta {
  channel: ExrChannel;
  pixelType: number;
  ySampling: number;
  bytesPerSample: number;
  rowByteLength: number;
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
      pixelType: channel.pixelType,
      ySampling,
      bytesPerSample,
      rowByteLength: sampledWidth * bytesPerSample,
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
  linesInChunk: number,
): number {
  if (!part.dataWindow) return 0;

  let expected = 0;

  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;
    if (y < part.dataWindow.yMin) {
      continue;
    }

    for (const meta of channelMeta) {
      if (meta.sampledWidth === 0 || meta.sampledHeight === 0) {
        continue;
      }

      if (!isSampledCoordinate(y, meta.sampleOriginY, meta.ySampling)) {
        continue;
      }

      expected += meta.rowByteLength;
    }
  }

  return expected;
}

function decodeRowIntoChannel(
  meta: ChannelDecodeMeta,
  blockData: Uint8Array,
  blockPointer: number,
  rowOffset: number,
  blockView: DataView,
) {
  const destination = meta.data;
  const sampleCount = meta.sampledWidth;
  const sourceByteOffset = blockData.byteOffset + blockPointer;

  if (meta.pixelType === 1) {
    if ((sourceByteOffset & 1) === 0) {
      const source = new Uint16Array(blockData.buffer, sourceByteOffset, sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        destination[rowOffset + i] = float16ToFloat32(source[i]);
      }
      return;
    }

    for (let i = 0; i < sampleCount; i++) {
      destination[rowOffset + i] = float16ToFloat32(blockView.getUint16(blockPointer + (i << 1), true));
    }
    return;
  }

  if (meta.pixelType === 2) {
    if ((sourceByteOffset & 3) === 0) {
      const source = new Float32Array(blockData.buffer, sourceByteOffset, sampleCount);
      destination.set(source, rowOffset);
      return;
    }

    for (let i = 0; i < sampleCount; i++) {
      destination[rowOffset + i] = blockView.getFloat32(blockPointer + (i << 2), true);
    }
    return;
  }

  if ((sourceByteOffset & 3) === 0) {
    const source = new Uint32Array(blockData.buffer, sourceByteOffset, sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      destination[rowOffset + i] = source[i] * INV_UINT32_MAX;
    }
    return;
  }

  for (let i = 0; i < sampleCount; i++) {
    destination[rowOffset + i] = blockView.getUint32(blockPointer + (i << 2), true) * INV_UINT32_MAX;
  }
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
  const zipScratch: ZipDecodeScratch = {
    inflate: new Uint8Array(0),
    output: new Uint8Array(0),
  };

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
      linesInChunk,
    );

    const predecodedZipBlock = options.predecodedZipBlocks?.get(chunkIndex);

    // OpenEXR chunks may be stored raw when compression is ineffective.
    const blockData =
      predecodedZipBlock
        ? predecodedZipBlock
        : dataSize === expectedUncompressedSize
        ? new Uint8Array(buffer, dataPtr, dataSize)
        : compressionHandler.decodeBlock({
            buffer,
            dataPtr,
            dataSize,
            expectedUncompressedSize,
            part,
            partId: part.id,
            chunkIndex,
            chunkY,
            linesInChunk,
            zipScratch: compression === 2 || compression === 3 ? zipScratch : undefined,
          });

    bytesRead += dataSize;

    let blockPointer = 0;
    const blockView = new DataView(blockData.buffer, blockData.byteOffset, blockData.byteLength);

    for (let dy = 0; dy < linesInChunk; dy++) {
      const y = chunkY + dy;
      if (y < part.dataWindow.yMin) {
        continue;
      }

      for (const meta of channelMeta) {
        if (meta.sampledWidth === 0 || meta.sampledHeight === 0) {
          continue;
        }

        if (!isSampledCoordinate(y, meta.sampleOriginY, meta.ySampling)) {
          continue;
        }

        const byteLength = meta.rowByteLength;
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

        const sampledRow = Math.floor((y - meta.sampleOriginY) / meta.ySampling);
        if (sampledRow < 0 || sampledRow >= meta.sampledHeight) {
          blockPointer += byteLength;
          continue;
        }

        const rowOffset = sampledRow * meta.sampledWidth;
        decodeRowIntoChannel(meta, blockData, blockPointer, rowOffset, blockView);

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
