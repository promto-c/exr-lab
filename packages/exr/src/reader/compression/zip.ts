import { unzlibSync } from 'fflate';
import { ExrError } from '../../shared/errors';
import { ExrPart } from '../../shared/types';

export interface ZipDecodeScratch {
  inflate: Uint8Array;
  output: Uint8Array;
}

export interface ZipStyleDecodeContext {
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

export function decodeZipStyleBlock(context: ZipStyleDecodeContext): Uint8Array {
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
  } catch {
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress ZIP/ZIPS chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
    });
  }
}
