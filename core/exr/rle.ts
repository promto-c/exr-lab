import { ExrError } from './errors';
import { ExrPart } from './types';

export interface RleDecodeContext {
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

function decodeRunLength(input: Uint8Array, expectedSize: number): Uint8Array {
  if (expectedSize < 0) {
    throw new Error('Invalid expected RLE output size.');
  }

  const output = new Uint8Array(expectedSize);
  let sourcePtr = 0;
  let outputPtr = 0;

  while (sourcePtr < input.length) {
    const length = (input[sourcePtr] << 24) >> 24;
    sourcePtr += 1;

    if (length < 0) {
      const count = -length;
      if (sourcePtr + count > input.length) {
        throw new Error('Truncated RLE literal run.');
      }
      if (outputPtr + count > output.length) {
        throw new Error('RLE literal run exceeded expected output size.');
      }

      output.set(input.subarray(sourcePtr, sourcePtr + count), outputPtr);
      sourcePtr += count;
      outputPtr += count;
      continue;
    }

    const count = length + 1;
    if (sourcePtr >= input.length) {
      throw new Error('Truncated RLE repeat run.');
    }
    if (outputPtr + count > output.length) {
      throw new Error('RLE repeat run exceeded expected output size.');
    }

    output.fill(input[sourcePtr], outputPtr, outputPtr + count);
    sourcePtr += 1;
    outputPtr += count;
  }

  if (outputPtr !== output.length) {
    throw new Error('RLE output size mismatch.');
  }

  return output;
}

export function decodeRleBlock(context: RleDecodeContext): Uint8Array {
  try {
    const compressed = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
    const unpacked = decodeRunLength(compressed, context.expectedUncompressedSize);
    undoPredictor(unpacked);
    return undoInterleave(unpacked);
  } catch (error) {
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress RLE chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
      expected: context.expectedUncompressedSize,
    });
  }
}
