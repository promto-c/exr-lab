import { ExrError } from './errors';
import { ExrPart } from './types';

const USHORT_RANGE = 1 << 16;
const BITMAP_SIZE = USHORT_RANGE >> 3;

const HUF_ENCBITS = 16;
const HUF_DECBITS = 14;
const HUF_ENCSIZE = (1 << HUF_ENCBITS) + 1;
const HUF_DECSIZE = 1 << HUF_DECBITS;
const HUF_DECMASK = HUF_DECSIZE - 1;

const SHORT_ZEROCODE_RUN = 59;
const LONG_ZEROCODE_RUN = 63;
const SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;

const NBITS = 16;
const A_OFFSET = 1 << (NBITS - 1);
const MOD_MASK = (1 << NBITS) - 1;

interface Cursor {
  value: number;
}

interface HufDecEntry {
  len: number;
  lit: number;
  p: number[] | null;
}

interface BitState {
  c: number;
  lc: number;
}

interface PizChannelLayout {
  sampledWidth: number;
  sampledRows: number;
  ySampling: number;
  sampleOriginY: number;
  wordsPerSample: number;
  wordsPerRow: number;
  wordStart: number;
  wordEnd: number;
  wordCursor: number;
}

export interface PizDecodeContext {
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

function countSampledRowsInRange(start: number, end: number, sampleOrigin: number, sampling: number): number {
  if (end < start) return 0;
  if (sampling <= 1) return end - start + 1;

  let count = 0;
  for (let y = start; y <= end; y++) {
    if (isSampledCoordinate(y, sampleOrigin, sampling)) {
      count++;
    }
  }
  return count;
}

function readUint16(view: DataView, cursor: Cursor): number {
  if (cursor.value + 2 > view.byteLength) {
    throw new Error('Truncated PIZ payload.');
  }
  const value = view.getUint16(cursor.value, true);
  cursor.value += 2;
  return value;
}

function readUint32(view: DataView, cursor: Cursor): number {
  if (cursor.value + 4 > view.byteLength) {
    throw new Error('Truncated PIZ payload.');
  }
  const value = view.getUint32(cursor.value, true);
  cursor.value += 4;
  return value;
}

function reverseLutFromBitmap(bitmap: Uint8Array, lut: Uint16Array): number {
  let k = 0;
  for (let i = 0; i < USHORT_RANGE; i++) {
    if (i === 0 || (bitmap[i >> 3] & (1 << (i & 7)))) {
      lut[k++] = i;
    }
  }

  const n = k - 1;
  while (k < USHORT_RANGE) {
    lut[k++] = 0;
  }

  return n;
}

function clearHuffmanDecodingTable(table: HufDecEntry[]) {
  for (let i = 0; i < HUF_DECSIZE; i++) {
    table[i] = { len: 0, lit: 0, p: null };
  }
}

function getBits(nBits: number, state: BitState, input: Uint8Array, cursor: Cursor): number {
  while (state.lc < nBits) {
    state.c = ((state.c << 8) | readUint8FromArray(input, cursor)) >>> 0;
    state.lc += 8;
  }

  state.lc -= nBits;
  return (state.c >>> state.lc) & ((1 << nBits) - 1);
}

const HUF_TABLE_BUFFER = new Int32Array(59);

function hufCanonicalCodeTable(hcode: Int32Array) {
  HUF_TABLE_BUFFER.fill(0);
  for (let i = 0; i < HUF_ENCSIZE; i++) {
    HUF_TABLE_BUFFER[hcode[i]] += 1;
  }

  let c = 0;
  for (let i = 58; i > 0; i--) {
    const nextCode = (c + HUF_TABLE_BUFFER[i]) >> 1;
    HUF_TABLE_BUFFER[i] = c;
    c = nextCode;
  }

  for (let i = 0; i < HUF_ENCSIZE; i++) {
    const length = hcode[i];
    if (length > 0) {
      hcode[i] = length | (HUF_TABLE_BUFFER[length]++ << 6);
    }
  }
}

function hufUnpackEncTable(
  input: Uint8Array,
  cursor: Cursor,
  maxTableBytes: number,
  minSymbol: number,
  maxSymbol: number,
  hcode: Int32Array,
) {
  const start = cursor.value;
  const state: BitState = { c: 0, lc: 0 };

  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    if (cursor.value - start > maxTableBytes) {
      throw new Error('Invalid PIZ Huffman table payload.');
    }

    const length = getBits(6, state, input, cursor);
    hcode[symbol] = length;

    if (length === LONG_ZEROCODE_RUN) {
      if (cursor.value - start > maxTableBytes) {
        throw new Error('Invalid PIZ Huffman table payload.');
      }

      let zeroRun = getBits(8, state, input, cursor) + SHORTEST_LONG_RUN;
      if (symbol + zeroRun > maxSymbol + 1) {
        throw new Error('Invalid PIZ Huffman zero-run.');
      }

      while (zeroRun-- > 0) {
        hcode[symbol++] = 0;
      }
      symbol--;
    } else if (length >= SHORT_ZEROCODE_RUN) {
      let zeroRun = length - SHORT_ZEROCODE_RUN + 2;
      if (symbol + zeroRun > maxSymbol + 1) {
        throw new Error('Invalid PIZ Huffman zero-run.');
      }

      while (zeroRun-- > 0) {
        hcode[symbol++] = 0;
      }
      symbol--;
    }
  }

  hufCanonicalCodeTable(hcode);
}

function hufLength(code: number): number {
  return code & 63;
}

function hufCode(code: number): number {
  return code >>> 6;
}

function hufBuildDecTable(hcode: Int32Array, minSymbol: number, maxSymbol: number, table: HufDecEntry[]) {
  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    const code = hufCode(hcode[symbol]);
    const length = hufLength(hcode[symbol]);

    if (code >>> length) {
      throw new Error('Invalid PIZ Huffman code.');
    }

    if (length > HUF_DECBITS) {
      const entry = table[code >>> (length - HUF_DECBITS)];
      if (entry.len) {
        throw new Error('Invalid PIZ Huffman decode table entry.');
      }

      entry.lit += 1;
      if (entry.p) {
        entry.p.push(symbol);
      } else {
        entry.p = [symbol];
      }
    } else if (length) {
      const base = code << (HUF_DECBITS - length);
      const count = 1 << (HUF_DECBITS - length);

      for (let i = 0; i < count; i++) {
        const entry = table[base + i];
        if (entry.len || entry.p) {
          throw new Error('Invalid PIZ Huffman decode table entry.');
        }

        entry.len = length;
        entry.lit = symbol;
      }
    }
  }
}

function readUint8FromArray(input: Uint8Array, cursor: Cursor): number {
  if (cursor.value >= input.length) {
    throw new Error('Truncated PIZ Huffman payload.');
  }
  const value = input[cursor.value];
  cursor.value += 1;
  return value;
}

function getChar(state: BitState, input: Uint8Array, cursor: Cursor) {
  state.c = ((state.c << 8) | readUint8FromArray(input, cursor)) >>> 0;
  state.lc += 8;
}

function getCode(
  symbol: number,
  runLengthCode: number,
  state: BitState,
  input: Uint8Array,
  cursor: Cursor,
  outBuffer: Uint16Array,
  outOffset: Cursor,
  outEnd: number,
) {
  if (symbol === runLengthCode) {
    if (state.lc < 8) {
      getChar(state, input, cursor);
    }

    state.lc -= 8;
    let repeatCount = (state.c >>> state.lc) & 0xff;

    if (outOffset.value === 0 || outOffset.value + repeatCount > outEnd) {
      throw new Error('Invalid PIZ run-length code.');
    }

    const last = outBuffer[outOffset.value - 1];
    while (repeatCount-- > 0) {
      outBuffer[outOffset.value++] = last;
    }
  } else if (outOffset.value < outEnd) {
    outBuffer[outOffset.value++] = symbol;
  } else {
    throw new Error('PIZ Huffman decode overflow.');
  }
}

function hufDecode(
  encodingTable: Int32Array,
  decodingTable: HufDecEntry[],
  input: Uint8Array,
  cursor: Cursor,
  nBits: number,
  runLengthCode: number,
  outSize: number,
  outBuffer: Uint16Array,
  outOffset: Cursor,
) {
  const state: BitState = { c: 0, lc: 0 };
  const inOffsetEnd = Math.trunc(cursor.value + (nBits + 7) / 8);

  while (cursor.value < inOffsetEnd) {
    getChar(state, input, cursor);

    while (state.lc >= HUF_DECBITS) {
      const index = (state.c >>> (state.lc - HUF_DECBITS)) & HUF_DECMASK;
      const entry = decodingTable[index];

      if (entry.len) {
        state.lc -= entry.len;
        getCode(entry.lit, runLengthCode, state, input, cursor, outBuffer, outOffset, outSize);
      } else {
        if (!entry.p) {
          throw new Error('PIZ Huffman decode failed.');
        }

        let matched = false;
        for (let i = 0; i < entry.lit; i++) {
          const symbol = entry.p[i];
          const length = hufLength(encodingTable[symbol]);

          while (state.lc < length && cursor.value < inOffsetEnd) {
            getChar(state, input, cursor);
          }

          if (state.lc >= length) {
            const code = hufCode(encodingTable[symbol]);
            const candidate = (state.c >>> (state.lc - length)) & ((1 << length) - 1);
            if (code === candidate) {
              state.lc -= length;
              getCode(symbol, runLengthCode, state, input, cursor, outBuffer, outOffset, outSize);
              matched = true;
              break;
            }
          }
        }

        if (!matched) {
          throw new Error('PIZ Huffman decode failed.');
        }
      }
    }
  }

  const pad = (8 - nBits) & 7;
  state.c >>>= pad;
  state.lc -= pad;

  while (state.lc > 0) {
    const entry = decodingTable[(state.c << (HUF_DECBITS - state.lc)) & HUF_DECMASK];
    if (!entry.len) {
      throw new Error('PIZ Huffman decode failed.');
    }

    state.lc -= entry.len;
    getCode(entry.lit, runLengthCode, state, input, cursor, outBuffer, outOffset, outSize);
  }
}

function hufUncompress(input: Uint8Array, view: DataView, cursor: Cursor, nCompressed: number, out: Uint16Array, nRaw: number) {
  const outOffset: Cursor = { value: 0 };
  const initialOffset = cursor.value;

  const minSymbol = readUint32(view, cursor);
  const maxSymbol = readUint32(view, cursor);
  readUint32(view, cursor); // reserved
  const nBits = readUint32(view, cursor);
  readUint32(view, cursor); // reserved

  if (minSymbol < 0 || minSymbol >= HUF_ENCSIZE || maxSymbol < 0 || maxSymbol >= HUF_ENCSIZE || minSymbol > maxSymbol) {
    throw new Error('Invalid PIZ Huffman symbol bounds.');
  }

  const encodingTable = new Int32Array(HUF_ENCSIZE);
  const decodingTable: HufDecEntry[] = new Array(HUF_DECSIZE);
  clearHuffmanDecodingTable(decodingTable);

  const tableBytes = nCompressed - (cursor.value - initialOffset);
  if (tableBytes < 0) {
    throw new Error('Invalid PIZ Huffman payload size.');
  }

  hufUnpackEncTable(input, cursor, tableBytes, minSymbol, maxSymbol, encodingTable);

  if (nBits > 8 * (nCompressed - (cursor.value - initialOffset))) {
    throw new Error('Invalid PIZ Huffman bit count.');
  }

  hufBuildDecTable(encodingTable, minSymbol, maxSymbol, decodingTable);
  hufDecode(encodingTable, decodingTable, input, cursor, nBits, maxSymbol, nRaw, out, outOffset);

  if (outOffset.value !== nRaw) {
    throw new Error('PIZ Huffman output size mismatch.');
  }
}

function uint16(value: number): number {
  return value & 0xffff;
}

function int16(value: number): number {
  const clamped = uint16(value);
  return clamped > 0x7fff ? clamped - 0x10000 : clamped;
}

const waveletPair = { a: 0, b: 0 };

function wdec14(low: number, high: number) {
  const ls = int16(low);
  const hs = int16(high);

  const ai = ls + (hs & 1) + (hs >> 1);
  const bi = ai - hs;

  waveletPair.a = ai;
  waveletPair.b = bi;
}

function wdec16(low: number, high: number) {
  const m = uint16(low);
  const d = uint16(high);

  const b = (m - (d >> 1)) & MOD_MASK;
  const a = (d + b - A_OFFSET) & MOD_MASK;

  waveletPair.a = a;
  waveletPair.b = b;
}

function wav2Decode(
  buffer: Uint16Array,
  channelOffset: number,
  nx: number,
  ox: number,
  ny: number,
  oy: number,
  maxValue: number,
) {
  if (nx <= 0 || ny <= 0) {
    return;
  }

  const wavelet14 = maxValue < (1 << 14);
  const minDim = nx > ny ? ny : nx;
  let p = 1;
  while (p <= minDim) {
    p <<= 1;
  }

  let p2 = p >> 1;
  p >>= 2;

  while (p >= 1) {
    let py = 0;
    const ey = oy * (ny - p2);
    const oy1 = oy * p;
    const oy2 = oy * p2;
    const ox1 = ox * p;
    const ox2 = ox * p2;

    for (; py <= ey; py += oy2) {
      let px = py;
      const ex = py + ox * (nx - p2);

      for (; px <= ex; px += ox2) {
        const p01 = px + ox1;
        const p10 = px + oy1;
        const p11 = p10 + ox1;

        if (wavelet14) {
          wdec14(buffer[px + channelOffset], buffer[p10 + channelOffset]);
          const i00 = waveletPair.a;
          const i10 = waveletPair.b;

          wdec14(buffer[p01 + channelOffset], buffer[p11 + channelOffset]);
          const i01 = waveletPair.a;
          const i11 = waveletPair.b;

          wdec14(i00, i01);
          buffer[px + channelOffset] = waveletPair.a;
          buffer[p01 + channelOffset] = waveletPair.b;

          wdec14(i10, i11);
          buffer[p10 + channelOffset] = waveletPair.a;
          buffer[p11 + channelOffset] = waveletPair.b;
        } else {
          wdec16(buffer[px + channelOffset], buffer[p10 + channelOffset]);
          const i00 = waveletPair.a;
          const i10 = waveletPair.b;

          wdec16(buffer[p01 + channelOffset], buffer[p11 + channelOffset]);
          const i01 = waveletPair.a;
          const i11 = waveletPair.b;

          wdec16(i00, i01);
          buffer[px + channelOffset] = waveletPair.a;
          buffer[p01 + channelOffset] = waveletPair.b;

          wdec16(i10, i11);
          buffer[p10 + channelOffset] = waveletPair.a;
          buffer[p11 + channelOffset] = waveletPair.b;
        }
      }

      if (nx & p) {
        const p10 = px + oy1;
        if (wavelet14) {
          wdec14(buffer[px + channelOffset], buffer[p10 + channelOffset]);
        } else {
          wdec16(buffer[px + channelOffset], buffer[p10 + channelOffset]);
        }
        buffer[px + channelOffset] = waveletPair.a;
        buffer[p10 + channelOffset] = waveletPair.b;
      }
    }

    if (ny & p) {
      let px = py;
      const ex = py + ox * (nx - p2);

      for (; px <= ex; px += ox2) {
        const p01 = px + ox1;
        if (wavelet14) {
          wdec14(buffer[px + channelOffset], buffer[p01 + channelOffset]);
        } else {
          wdec16(buffer[px + channelOffset], buffer[p01 + channelOffset]);
        }
        buffer[px + channelOffset] = waveletPair.a;
        buffer[p01 + channelOffset] = waveletPair.b;
      }
    }

    p2 = p;
    p >>= 1;
  }
}

function applyLut(lut: Uint16Array, data: Uint16Array, count: number) {
  for (let i = 0; i < count; i++) {
    data[i] = lut[data[i]];
  }
}

function buildChannelLayout(part: ExrPart, chunkY: number, linesInChunk: number): { channels: PizChannelLayout[]; totalWords: number } {
  if (!part.dataWindow) {
    return { channels: [], totalWords: 0 };
  }

  const { xMin, xMax, yMin, yMax } = part.dataWindow;
  const chunkStart = Math.max(chunkY, yMin);
  const chunkEnd = Math.min(chunkY + linesInChunk - 1, yMax);

  const channels: PizChannelLayout[] = [];
  let totalWords = 0;

  for (const channel of part.channels) {
    const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
    const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;
    const sampleOriginY = firstSampleCoordinate(yMin, ySampling);
    const sampledWidth = countSamplesInRange(xMin, xMax, xSampling);
    const sampledRows = countSampledRowsInRange(chunkStart, chunkEnd, sampleOriginY, ySampling);
    const wordsPerSample = channel.pixelType === 1 ? 1 : 2;
    const wordsPerRow = sampledWidth * wordsPerSample;
    const wordCount = wordsPerRow * sampledRows;

    channels.push({
      sampledWidth,
      sampledRows,
      ySampling,
      sampleOriginY,
      wordsPerSample,
      wordsPerRow,
      wordStart: totalWords,
      wordEnd: totalWords + wordCount,
      wordCursor: totalWords,
    });

    totalWords += wordCount;
  }

  return { channels, totalWords };
}

function decodePizChunk(context: PizDecodeContext): Uint8Array {
  if (!context.part.dataWindow) {
    throw new Error('Part is missing dataWindow.');
  }

  const { channels, totalWords } = buildChannelLayout(context.part, context.chunkY, context.linesInChunk);
  const { yMin, yMax } = context.part.dataWindow;

  const compressedView = new DataView(context.buffer, context.dataPtr, context.dataSize);
  const compressedBytes = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
  const cursor: Cursor = { value: 0 };

  const bitmap = new Uint8Array(BITMAP_SIZE);
  const minNonZero = readUint16(compressedView, cursor);
  const maxNonZero = readUint16(compressedView, cursor);

  if (maxNonZero >= BITMAP_SIZE) {
    throw new Error('Invalid PIZ bitmap range.');
  }

  if (minNonZero <= maxNonZero) {
    const bitmapLength = maxNonZero - minNonZero + 1;
    if (cursor.value + bitmapLength > compressedView.byteLength) {
      throw new Error('Truncated PIZ bitmap payload.');
    }

    bitmap.set(compressedBytes.subarray(cursor.value, cursor.value + bitmapLength), minNonZero);
    cursor.value += bitmapLength;
  }

  const lut = new Uint16Array(USHORT_RANGE);
  const maxValue = reverseLutFromBitmap(bitmap, lut);

  const huffmanLength = readUint32(compressedView, cursor);
  if (huffmanLength > compressedView.byteLength - cursor.value) {
    throw new Error('Invalid PIZ Huffman payload length.');
  }

  const outBuffer = new Uint16Array(totalWords);
  hufUncompress(compressedBytes, compressedView, cursor, huffmanLength, outBuffer, totalWords);

  for (const channel of channels) {
    for (let component = 0; component < channel.wordsPerSample; component++) {
      wav2Decode(
        outBuffer,
        channel.wordStart + component,
        channel.sampledWidth,
        channel.wordsPerSample,
        channel.sampledRows,
        channel.sampledWidth * channel.wordsPerSample,
        maxValue,
      );
    }
  }

  applyLut(lut, outBuffer, totalWords);

  const output = new Uint8Array(totalWords * 2);
  let outputOffset = 0;

  for (let dy = 0; dy < context.linesInChunk; dy++) {
    const y = context.chunkY + dy;
    if (y > yMax) {
      break;
    }
    if (y < yMin) {
      continue;
    }

    for (const channel of channels) {
      if (channel.wordsPerRow === 0 || channel.sampledRows === 0) {
        continue;
      }
      if (!isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
        continue;
      }

      if (channel.wordCursor + channel.wordsPerRow > channel.wordEnd) {
        throw new Error('Invalid PIZ channel plane bounds.');
      }

      for (let i = 0; i < channel.wordsPerRow; i++) {
        const value = outBuffer[channel.wordCursor + i];
        output[outputOffset++] = value & 0xff;
        output[outputOffset++] = (value >>> 8) & 0xff;
      }

      channel.wordCursor += channel.wordsPerRow;
    }
  }

  if (outputOffset !== output.byteLength) {
    throw new Error('Invalid PIZ output layout.');
  }

  return output;
}

export function decodePizBlock(context: PizDecodeContext): Uint8Array {
  try {
    return decodePizChunk(context);
  } catch (error) {
    if (error instanceof ExrError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress PIZ chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
      reason,
    });
  }
}
