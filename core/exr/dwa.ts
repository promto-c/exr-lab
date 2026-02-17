import { unzlibSync } from 'fflate';
import { ExrError } from './errors';
import { float16ToFloat32 } from './half';
import { ExrPart } from './types';

// Adapted from the DWAA/DWAB decode path in three.js EXRLoader.

const HUF_ENCBITS = 16;
const HUF_DECBITS = 14;
const HUF_ENCSIZE = (1 << HUF_ENCBITS) + 1;
const HUF_DECSIZE = 1 << HUF_DECBITS;
const HUF_DECMASK = HUF_DECSIZE - 1;

const SHORT_ZEROCODE_RUN = 59;
const LONG_ZEROCODE_RUN = 63;
const SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;

const INT16_SIZE = 2;

const STATIC_HUFFMAN = 0;
const DEFLATE = 1;

const UNKNOWN = 0;
const LOSSY_DCT = 1;
const RLE = 2;

const LOG_BASE = Math.pow(2.7182818, 2.2);
const TEXT_DECODER = new TextDecoder();
const DCT_A = 0.5 * Math.cos(Math.PI / 4.0);
const DCT_B = 0.5 * Math.cos(Math.PI / 16.0);
const DCT_C = 0.5 * Math.cos(Math.PI / 8.0);
const DCT_D = 0.5 * Math.cos((3.0 * Math.PI) / 16.0);
const DCT_E = 0.5 * Math.cos((5.0 * Math.PI) / 16.0);
const DCT_F = 0.5 * Math.cos((3.0 * Math.PI) / 8.0);
const DCT_G = 0.5 * Math.cos((7.0 * Math.PI) / 16.0);

const FLOAT32_TO_FLOAT16_SCRATCH = new ArrayBuffer(4);
const FLOAT32_TO_FLOAT16_FLOAT_VIEW = new Float32Array(FLOAT32_TO_FLOAT16_SCRATCH);
const FLOAT32_TO_FLOAT16_INT_VIEW = new Uint32Array(FLOAT32_TO_FLOAT16_SCRATCH);

interface Cursor {
  value: number;
}

interface BitState {
  c: number;
  lc: number;
}

interface HufDecEntry {
  len: number;
  lit: number;
  p: number[] | null;
}

interface DwaHeader {
  version: number;
  unknownUncompressedSize: number;
  unknownCompressedSize: number;
  acCompressedSize: number;
  dcCompressedSize: number;
  rleCompressedSize: number;
  rleUncompressedSize: number;
  rleRawSize: number;
  totalAcUncompressedCount: number;
  totalDcUncompressedCount: number;
  acCompression: number;
}

interface DwaRule {
  name: string;
  compression: number;
  index: number;
  pixelType: number;
  caseInsensitive: boolean;
}

const LEGACY_DWA_RULES: DwaRule[] = [
  { name: 'r', compression: LOSSY_DCT, pixelType: 1, index: 0, caseInsensitive: true },
  { name: 'r', compression: LOSSY_DCT, pixelType: 2, index: 0, caseInsensitive: true },
  { name: 'red', compression: LOSSY_DCT, pixelType: 1, index: 0, caseInsensitive: true },
  { name: 'red', compression: LOSSY_DCT, pixelType: 2, index: 0, caseInsensitive: true },
  { name: 'g', compression: LOSSY_DCT, pixelType: 1, index: 1, caseInsensitive: true },
  { name: 'g', compression: LOSSY_DCT, pixelType: 2, index: 1, caseInsensitive: true },
  { name: 'grn', compression: LOSSY_DCT, pixelType: 1, index: 1, caseInsensitive: true },
  { name: 'grn', compression: LOSSY_DCT, pixelType: 2, index: 1, caseInsensitive: true },
  { name: 'green', compression: LOSSY_DCT, pixelType: 1, index: 1, caseInsensitive: true },
  { name: 'green', compression: LOSSY_DCT, pixelType: 2, index: 1, caseInsensitive: true },
  { name: 'b', compression: LOSSY_DCT, pixelType: 1, index: 2, caseInsensitive: true },
  { name: 'b', compression: LOSSY_DCT, pixelType: 2, index: 2, caseInsensitive: true },
  { name: 'blu', compression: LOSSY_DCT, pixelType: 1, index: 2, caseInsensitive: true },
  { name: 'blu', compression: LOSSY_DCT, pixelType: 2, index: 2, caseInsensitive: true },
  { name: 'blue', compression: LOSSY_DCT, pixelType: 1, index: 2, caseInsensitive: true },
  { name: 'blue', compression: LOSSY_DCT, pixelType: 2, index: 2, caseInsensitive: true },
  { name: 'y', compression: LOSSY_DCT, pixelType: 1, index: -1, caseInsensitive: true },
  { name: 'y', compression: LOSSY_DCT, pixelType: 2, index: -1, caseInsensitive: true },
  { name: 'by', compression: LOSSY_DCT, pixelType: 1, index: -1, caseInsensitive: true },
  { name: 'by', compression: LOSSY_DCT, pixelType: 2, index: -1, caseInsensitive: true },
  { name: 'ry', compression: LOSSY_DCT, pixelType: 1, index: -1, caseInsensitive: true },
  { name: 'ry', compression: LOSSY_DCT, pixelType: 2, index: -1, caseInsensitive: true },
  { name: 'a', compression: RLE, pixelType: 0, index: -1, caseInsensitive: true },
  { name: 'a', compression: RLE, pixelType: 1, index: -1, caseInsensitive: true },
  { name: 'a', compression: RLE, pixelType: 2, index: -1, caseInsensitive: true },
];

interface DwaChannelData {
  name: string;
  compression: number;
  decoded: boolean;
  pixelType: number;
  sampleWords: number;
  pLinear: number;
  width: number;
  height: number;
}

interface DwaCscSet {
  idx: Array<number | undefined>;
}

interface DecodeUsage {
  acConsumed: number;
  dcConsumed: number;
}

export interface DwaDecodeContext {
  buffer: ArrayBuffer;
  dataPtr: number;
  dataSize: number;
  part: ExrPart;
  partId: number;
  chunkIndex: number;
  chunkY: number;
  linesInChunk: number;
}

function ensureAvailable(totalLength: number, cursor: Cursor, size: number, context: string) {
  if (size < 0 || cursor.value < 0 || cursor.value + size > totalLength) {
    throw new Error(`Truncated DWA payload while reading ${context}.`);
  }
}

function ensureSafeInteger(value: bigint, context: string): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const min = BigInt(Number.MIN_SAFE_INTEGER);
  if (value > max || value < min) {
    throw new Error(`DWA value exceeded safe integer range while reading ${context}.`);
  }
  return Number(value);
}

function readUint8(view: DataView, cursor: Cursor): number {
  ensureAvailable(view.byteLength, cursor, 1, 'uint8');
  const value = view.getUint8(cursor.value);
  cursor.value += 1;
  return value;
}

function readUint16(view: DataView, cursor: Cursor): number {
  ensureAvailable(view.byteLength, cursor, 2, 'uint16');
  const value = view.getUint16(cursor.value, true);
  cursor.value += 2;
  return value;
}

function readUint32(view: DataView, cursor: Cursor): number {
  ensureAvailable(view.byteLength, cursor, 4, 'uint32');
  const value = view.getUint32(cursor.value, true);
  cursor.value += 4;
  return value;
}

function readInt64(view: DataView, cursor: Cursor): number {
  ensureAvailable(view.byteLength, cursor, 8, 'int64');

  let value: number;
  if ('getBigInt64' in DataView.prototype) {
    value = ensureSafeInteger(view.getBigInt64(cursor.value, true), 'int64');
  } else {
    const low = BigInt(view.getUint32(cursor.value, true));
    const high = BigInt(view.getInt32(cursor.value + 4, true));
    value = ensureSafeInteger((high << 32n) + low, 'int64');
  }

  cursor.value += 8;
  return value;
}

function readUint8FromArray(input: Uint8Array, cursor: Cursor): number {
  if (cursor.value < 0 || cursor.value >= input.length) {
    throw new Error('Truncated DWA Huffman payload.');
  }
  const value = input[cursor.value];
  cursor.value += 1;
  return value;
}

function readCStringWithin(input: Uint8Array, cursor: Cursor, limit: number, context: string): string {
  if (limit < cursor.value || limit > input.length) {
    throw new Error(`Invalid DWA bounded read while parsing ${context}.`);
  }

  const start = cursor.value;
  while (cursor.value < limit) {
    if (input[cursor.value] === 0) {
      const value = TEXT_DECODER.decode(input.subarray(start, cursor.value));
      cursor.value += 1;
      return value;
    }
    cursor.value += 1;
  }

  throw new Error(`Unterminated DWA string while parsing ${context}.`);
}

// --- Huffman helpers --------------------------------------------------------

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

function hufLength(code: number): number {
  return code & 63;
}

function hufCode(code: number): number {
  return code >>> 6;
}

function hufCanonicalCodeTable(hcode: Int32Array) {
  HUF_TABLE_BUFFER.fill(0);

  for (let i = 0; i < HUF_ENCSIZE; i++) {
    HUF_TABLE_BUFFER[hcode[i]] += 1;
  }

  let c = 0;
  for (let i = 58; i > 0; i--) {
    const next = (c + HUF_TABLE_BUFFER[i]) >> 1;
    HUF_TABLE_BUFFER[i] = c;
    c = next;
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
      throw new Error('Invalid DWA Huffman table payload.');
    }

    const length = getBits(6, state, input, cursor);
    hcode[symbol] = length;

    if (length === LONG_ZEROCODE_RUN) {
      if (cursor.value - start > maxTableBytes) {
        throw new Error('Invalid DWA Huffman table payload.');
      }

      let zeroRun = getBits(8, state, input, cursor) + SHORTEST_LONG_RUN;
      if (symbol + zeroRun > maxSymbol + 1) {
        throw new Error('Invalid DWA Huffman zero-run.');
      }

      while (zeroRun-- > 0) {
        hcode[symbol++] = 0;
      }
      symbol--;
    } else if (length >= SHORT_ZEROCODE_RUN) {
      let zeroRun = length - SHORT_ZEROCODE_RUN + 2;
      if (symbol + zeroRun > maxSymbol + 1) {
        throw new Error('Invalid DWA Huffman zero-run.');
      }

      while (zeroRun-- > 0) {
        hcode[symbol++] = 0;
      }
      symbol--;
    }
  }

  hufCanonicalCodeTable(hcode);
}

function hufBuildDecTable(hcode: Int32Array, minSymbol: number, maxSymbol: number, table: HufDecEntry[]) {
  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    const code = hufCode(hcode[symbol]);
    const length = hufLength(hcode[symbol]);

    if (code >>> length) {
      throw new Error('Invalid DWA Huffman code.');
    }

    if (length > HUF_DECBITS) {
      const entry = table[code >>> (length - HUF_DECBITS)];
      if (entry.len) {
        throw new Error('Invalid DWA Huffman decode table entry.');
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
          throw new Error('Invalid DWA Huffman decode table entry.');
        }

        entry.len = length;
        entry.lit = symbol;
      }
    }
  }
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
      throw new Error('Invalid DWA run-length code.');
    }

    const last = outBuffer[outOffset.value - 1];
    while (repeatCount-- > 0) {
      outBuffer[outOffset.value++] = last;
    }
  } else if (outOffset.value < outEnd) {
    outBuffer[outOffset.value++] = symbol;
  } else {
    throw new Error('DWA Huffman decode overflow.');
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
          throw new Error('DWA Huffman decode failed.');
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
          throw new Error('DWA Huffman decode failed.');
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
      throw new Error('DWA Huffman decode failed.');
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
    throw new Error('Invalid DWA Huffman symbol bounds.');
  }

  const encodingTable = new Int32Array(HUF_ENCSIZE);
  const decodingTable: HufDecEntry[] = new Array(HUF_DECSIZE);
  clearHuffmanDecodingTable(decodingTable);

  const tableBytes = nCompressed - (cursor.value - initialOffset);
  if (tableBytes < 0) {
    throw new Error('Invalid DWA Huffman payload size.');
  }

  hufUnpackEncTable(input, cursor, tableBytes, minSymbol, maxSymbol, encodingTable);

  if (nBits > 8 * (nCompressed - (cursor.value - initialOffset))) {
    throw new Error('Invalid DWA Huffman bit count.');
  }

  hufBuildDecTable(encodingTable, minSymbol, maxSymbol, decodingTable);
  hufDecode(encodingTable, decodingTable, input, cursor, nBits, maxSymbol, nRaw, out, outOffset);

  if (outOffset.value !== nRaw) {
    throw new Error('DWA Huffman output size mismatch.');
  }
}

// --- End Huffman helpers ----------------------------------------------------

interface DwaZipScratch {
  inflate: Uint8Array;
  output: Uint8Array;
}

const DWA_DC_SCRATCH: DwaZipScratch = {
  inflate: new Uint8Array(0),
  output: new Uint8Array(0),
};

function undoZipPredictorAndInterleave(data: Uint8Array, output: Uint8Array): Uint8Array {
  const length = data.length;
  if (length === 0) {
    return data;
  }

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

function ensureDwaScratchBuffer(buffer: Uint8Array, size: number): Uint8Array {
  return buffer.byteLength >= size ? buffer.subarray(0, size) : new Uint8Array(size);
}

function uncompressZipStyle(
  input: Uint8Array,
  offset: number,
  size: number,
  expectedUncompressedSize: number,
  scratch: DwaZipScratch,
): Uint8Array {
  if (size < 0 || offset < 0 || offset + size > input.length) {
    throw new Error('Invalid DWA ZIP payload bounds.');
  }

  const compressed = input.subarray(offset, offset + size);
  const inflateOut =
    expectedUncompressedSize > 0
      ? ensureDwaScratchBuffer(scratch.inflate, expectedUncompressedSize)
      : scratch.inflate;
  if (expectedUncompressedSize > 0 && inflateOut !== scratch.inflate) {
    scratch.inflate = inflateOut;
  }

  const raw = expectedUncompressedSize > 0 ? unzlibSync(compressed, { out: inflateOut }) : unzlibSync(compressed);

  const outputBuffer = ensureDwaScratchBuffer(scratch.output, raw.byteLength);
  if (outputBuffer !== scratch.output) {
    scratch.output = outputBuffer;
  }

  return undoZipPredictorAndInterleave(raw, outputBuffer);
}

function decodeRunLength(input: Uint8Array, expectedSize: number): Uint8Array {
  if (expectedSize < 0) {
    throw new Error('Invalid DWA RLE expected size.');
  }

  const out = new Uint8Array(expectedSize);
  let ptr = 0;
  let outPtr = 0;

  while (ptr < input.byteLength) {
    const length = (input[ptr] << 24) >> 24;
    ptr += 1;

    if (length < 0) {
      const count = -length;
      if (ptr + count > input.byteLength || outPtr + count > out.byteLength) {
        throw new Error('Invalid DWA RLE payload bounds.');
      }
      out.set(input.subarray(ptr, ptr + count), outPtr);
      ptr += count;
      outPtr += count;
    } else {
      const count = length + 1;
      if (ptr >= input.byteLength || outPtr + count > out.byteLength) {
        throw new Error('Invalid DWA RLE payload bounds.');
      }
      const value = input[ptr++];
      out.fill(value, outPtr, outPtr + count);
      outPtr += count;
    }
  }

  if (outPtr !== out.byteLength) {
    throw new Error('Invalid DWA RLE payload length.');
  }

  return out;
}

function unRleAC(currAc: Cursor, acBuffer: Uint16Array, halfZigBlock: Uint16Array) {
  let dctComp = 1;

  while (dctComp < 64) {
    if (currAc.value >= acBuffer.length) {
      throw new Error('Invalid DWA AC coefficient bounds.');
    }

    const acValue = acBuffer[currAc.value++];
    if (acValue === 0xff00) {
      dctComp = 64;
    } else if ((acValue >> 8) === 0xff) {
      dctComp += acValue & 0xff;
    } else {
      halfZigBlock[dctComp++] = acValue;
    }
  }
}

function unZigZag(src: Uint16Array, dst: Float32Array) {
  dst[0] = float16ToFloat32(src[0]);
  dst[1] = float16ToFloat32(src[1]);
  dst[2] = float16ToFloat32(src[5]);
  dst[3] = float16ToFloat32(src[6]);
  dst[4] = float16ToFloat32(src[14]);
  dst[5] = float16ToFloat32(src[15]);
  dst[6] = float16ToFloat32(src[27]);
  dst[7] = float16ToFloat32(src[28]);
  dst[8] = float16ToFloat32(src[2]);
  dst[9] = float16ToFloat32(src[4]);

  dst[10] = float16ToFloat32(src[7]);
  dst[11] = float16ToFloat32(src[13]);
  dst[12] = float16ToFloat32(src[16]);
  dst[13] = float16ToFloat32(src[26]);
  dst[14] = float16ToFloat32(src[29]);
  dst[15] = float16ToFloat32(src[42]);
  dst[16] = float16ToFloat32(src[3]);
  dst[17] = float16ToFloat32(src[8]);
  dst[18] = float16ToFloat32(src[12]);
  dst[19] = float16ToFloat32(src[17]);

  dst[20] = float16ToFloat32(src[25]);
  dst[21] = float16ToFloat32(src[30]);
  dst[22] = float16ToFloat32(src[41]);
  dst[23] = float16ToFloat32(src[43]);
  dst[24] = float16ToFloat32(src[9]);
  dst[25] = float16ToFloat32(src[11]);
  dst[26] = float16ToFloat32(src[18]);
  dst[27] = float16ToFloat32(src[24]);
  dst[28] = float16ToFloat32(src[31]);
  dst[29] = float16ToFloat32(src[40]);

  dst[30] = float16ToFloat32(src[44]);
  dst[31] = float16ToFloat32(src[53]);
  dst[32] = float16ToFloat32(src[10]);
  dst[33] = float16ToFloat32(src[19]);
  dst[34] = float16ToFloat32(src[23]);
  dst[35] = float16ToFloat32(src[32]);
  dst[36] = float16ToFloat32(src[39]);
  dst[37] = float16ToFloat32(src[45]);
  dst[38] = float16ToFloat32(src[52]);
  dst[39] = float16ToFloat32(src[54]);

  dst[40] = float16ToFloat32(src[20]);
  dst[41] = float16ToFloat32(src[22]);
  dst[42] = float16ToFloat32(src[33]);
  dst[43] = float16ToFloat32(src[38]);
  dst[44] = float16ToFloat32(src[46]);
  dst[45] = float16ToFloat32(src[51]);
  dst[46] = float16ToFloat32(src[55]);
  dst[47] = float16ToFloat32(src[60]);
  dst[48] = float16ToFloat32(src[21]);
  dst[49] = float16ToFloat32(src[34]);

  dst[50] = float16ToFloat32(src[37]);
  dst[51] = float16ToFloat32(src[47]);
  dst[52] = float16ToFloat32(src[50]);
  dst[53] = float16ToFloat32(src[56]);
  dst[54] = float16ToFloat32(src[59]);
  dst[55] = float16ToFloat32(src[61]);
  dst[56] = float16ToFloat32(src[35]);
  dst[57] = float16ToFloat32(src[36]);
  dst[58] = float16ToFloat32(src[48]);
  dst[59] = float16ToFloat32(src[49]);

  dst[60] = float16ToFloat32(src[57]);
  dst[61] = float16ToFloat32(src[58]);
  dst[62] = float16ToFloat32(src[62]);
  dst[63] = float16ToFloat32(src[63]);
}

function dctInverse(data: Float32Array) {
  for (let row = 0; row < 8; row++) {
    const rowPtr = row * 8;
    const x0 = data[rowPtr + 0];
    const x1 = data[rowPtr + 1];
    const x2 = data[rowPtr + 2];
    const x3 = data[rowPtr + 3];
    const x4 = data[rowPtr + 4];
    const x5 = data[rowPtr + 5];
    const x6 = data[rowPtr + 6];
    const x7 = data[rowPtr + 7];

    const alpha0 = DCT_C * x2;
    const alpha1 = DCT_F * x2;
    const alpha2 = DCT_C * x6;
    const alpha3 = DCT_F * x6;

    const beta0 = DCT_B * x1 + DCT_D * x3 + DCT_E * x5 + DCT_G * x7;
    const beta1 = DCT_D * x1 - DCT_G * x3 - DCT_B * x5 - DCT_E * x7;
    const beta2 = DCT_E * x1 - DCT_B * x3 + DCT_G * x5 + DCT_D * x7;
    const beta3 = DCT_G * x1 - DCT_E * x3 + DCT_D * x5 - DCT_B * x7;

    const theta0 = DCT_A * (x0 + x4);
    const theta1 = alpha0 + alpha3;
    const theta2 = alpha1 - alpha2;
    const theta3 = DCT_A * (x0 - x4);

    const gamma0 = theta0 + theta1;
    const gamma1 = theta3 + theta2;
    const gamma2 = theta3 - theta2;
    const gamma3 = theta0 - theta1;

    data[rowPtr + 0] = gamma0 + beta0;
    data[rowPtr + 1] = gamma1 + beta1;
    data[rowPtr + 2] = gamma2 + beta2;
    data[rowPtr + 3] = gamma3 + beta3;
    data[rowPtr + 4] = gamma3 - beta3;
    data[rowPtr + 5] = gamma2 - beta2;
    data[rowPtr + 6] = gamma1 - beta1;
    data[rowPtr + 7] = gamma0 - beta0;
  }

  for (let column = 0; column < 8; column++) {
    const x0 = data[column];
    const x1 = data[8 + column];
    const x2 = data[16 + column];
    const x3 = data[24 + column];
    const x4 = data[32 + column];
    const x5 = data[40 + column];
    const x6 = data[48 + column];
    const x7 = data[56 + column];

    const alpha0 = DCT_C * x2;
    const alpha1 = DCT_F * x2;
    const alpha2 = DCT_C * x6;
    const alpha3 = DCT_F * x6;

    const beta0 = DCT_B * x1 + DCT_D * x3 + DCT_E * x5 + DCT_G * x7;
    const beta1 = DCT_D * x1 - DCT_G * x3 - DCT_B * x5 - DCT_E * x7;
    const beta2 = DCT_E * x1 - DCT_B * x3 + DCT_G * x5 + DCT_D * x7;
    const beta3 = DCT_G * x1 - DCT_E * x3 + DCT_D * x5 - DCT_B * x7;

    const theta0 = DCT_A * (x0 + x4);
    const theta1 = alpha0 + alpha3;
    const theta2 = alpha1 - alpha2;
    const theta3 = DCT_A * (x0 - x4);

    const gamma0 = theta0 + theta1;
    const gamma1 = theta3 + theta2;
    const gamma2 = theta3 - theta2;
    const gamma3 = theta0 - theta1;

    data[column] = gamma0 + beta0;
    data[8 + column] = gamma1 + beta1;
    data[16 + column] = gamma2 + beta2;
    data[24 + column] = gamma3 + beta3;
    data[32 + column] = gamma3 - beta3;
    data[40 + column] = gamma2 - beta2;
    data[48 + column] = gamma1 - beta1;
    data[56 + column] = gamma0 - beta0;
  }
}

function csc709Inverse(data: [Float32Array, Float32Array, Float32Array]) {
  for (let i = 0; i < 64; i++) {
    const y = data[0][i];
    const cb = data[1][i];
    const cr = data[2][i];

    data[0][i] = y + 1.5747 * cr;
    data[1][i] = y - 0.1873 * cb - 0.4682 * cr;
    data[2][i] = y + 1.8556 * cb;
  }
}

function float32ToFloat16(value: number): number {
  if (Object.is(value, 0)) return 0;

  FLOAT32_TO_FLOAT16_FLOAT_VIEW[0] = value;
  const bits = FLOAT32_TO_FLOAT16_INT_VIEW[0];
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

function toLinear(value: number): number {
  const abs = Math.abs(value);
  if (abs <= 1) {
    const linear = Math.pow(abs, 2.2);
    return value < 0 ? -linear : linear;
  }
  const linear = Math.pow(LOG_BASE, abs - 1.0);
  return value < 0 ? -linear : linear;
}

function convertToHalf(src: Float32Array, dst: Uint16Array, idx: number) {
  for (let i = 0; i < 64; i++) {
    dst[idx + i] = float32ToFloat16(toLinear(src[i]));
  }
}

function lossyDctDecode(
  cscSet: DwaCscSet,
  rowPtrs: Int32Array[],
  channelData: DwaChannelData[],
  acBuffer: Uint16Array,
  dcBuffer: Uint16Array,
  outBuffer: Uint8Array,
  acOffset: number,
  dcOffset: number,
): DecodeUsage {
  const c0 = cscSet.idx[0];
  const c1 = cscSet.idx[1];
  const c2 = cscSet.idx[2];
  if (c0 === undefined || c1 === undefined || c2 === undefined) {
    return { acConsumed: 0, dcConsumed: 0 };
  }

  const cscIndices = [c0, c1, c2];
  const dataView = new DataView(outBuffer.buffer, outBuffer.byteOffset, outBuffer.byteLength);
  const outWords = new Uint16Array(outBuffer.buffer, outBuffer.byteOffset, outBuffer.byteLength >> 1);

  const width = channelData[c0].width;
  const height = channelData[c0].height;

  const numComp = 3;
  const numFullBlocksX = Math.floor(width / 8);
  const numBlocksX = Math.ceil(width / 8);
  const numBlocksY = Math.ceil(height / 8);
  const leftoverX = width - (numBlocksX - 1) * 8;
  const leftoverY = height - (numBlocksY - 1) * 8;

  const currAcComp: Cursor = { value: acOffset };
  const currDcComp = new Array<number>(numComp);
  const dctData = new Array<Float32Array>(numComp);
  const halfZigBlock = new Array<Uint16Array>(numComp);
  const rowBlock = new Array<Uint16Array>(numComp);
  const rowOffsets = new Array<Int32Array>(numComp);

  for (let comp = 0; comp < numComp; comp++) {
    rowOffsets[comp] = rowPtrs[cscIndices[comp]];
    currDcComp[comp] = comp < 1 ? dcOffset : currDcComp[comp - 1] + numBlocksX * numBlocksY;
    dctData[comp] = new Float32Array(64);
    halfZigBlock[comp] = new Uint16Array(64);
    rowBlock[comp] = new Uint16Array(numBlocksX * 64);
  }

  for (let blockY = 0; blockY < numBlocksY; blockY++) {
    let maxY = 8;
    if (blockY === numBlocksY - 1) maxY = leftoverY;

    let maxX = 8;

    for (let blockX = 0; blockX < numBlocksX; blockX++) {
      if (blockX === numBlocksX - 1) maxX = leftoverX;

      for (let comp = 0; comp < numComp; comp++) {
        halfZigBlock[comp].fill(0);

        if (currDcComp[comp] >= dcBuffer.length) {
          throw new Error('Invalid DWA DC coefficient bounds.');
        }
        halfZigBlock[comp][0] = dcBuffer[currDcComp[comp]++];

        unRleAC(currAcComp, acBuffer, halfZigBlock[comp]);
        unZigZag(halfZigBlock[comp], dctData[comp]);
        dctInverse(dctData[comp]);
      }

      csc709Inverse(dctData as [Float32Array, Float32Array, Float32Array]);

      for (let comp = 0; comp < numComp; comp++) {
        convertToHalf(dctData[comp], rowBlock[comp], blockX * 64);
      }
    }

    for (let comp = 0; comp < numComp; comp++) {
      const channelIndex = cscIndices[comp];
      const sampleWords = channelData[channelIndex].sampleWords;

      for (let y = 8 * blockY; y < 8 * blockY + maxY; y++) {
        let offsetWords = rowOffsets[comp][y] >> 1;

        for (let blockX = 0; blockX < numFullBlocksX; blockX++) {
          const src = blockX * 64 + ((y & 0x7) * 8);

          outWords[offsetWords + 0 * sampleWords] = rowBlock[comp][src + 0];
          outWords[offsetWords + 1 * sampleWords] = rowBlock[comp][src + 1];
          outWords[offsetWords + 2 * sampleWords] = rowBlock[comp][src + 2];
          outWords[offsetWords + 3 * sampleWords] = rowBlock[comp][src + 3];
          outWords[offsetWords + 4 * sampleWords] = rowBlock[comp][src + 4];
          outWords[offsetWords + 5 * sampleWords] = rowBlock[comp][src + 5];
          outWords[offsetWords + 6 * sampleWords] = rowBlock[comp][src + 6];
          outWords[offsetWords + 7 * sampleWords] = rowBlock[comp][src + 7];

          offsetWords += 8 * sampleWords;
        }
      }

      if (numFullBlocksX !== numBlocksX) {
        for (let y = 8 * blockY; y < 8 * blockY + maxY; y++) {
          const offsetWords = (rowOffsets[comp][y] >> 1) + 8 * numFullBlocksX * sampleWords;
          const src = numFullBlocksX * 64 + ((y & 0x7) * 8);

          for (let x = 0; x < maxX; x++) {
            outWords[offsetWords + x * sampleWords] = rowBlock[comp][src + x];
          }
        }
      }
    }
  }

  for (let comp = 0; comp < numComp; comp++) {
    const channelIndex = cscIndices[comp];
    const channel = channelData[channelIndex];
    channel.decoded = true;
    if (channel.pixelType !== 2) {
      continue;
    }

    const sampleWords = channel.sampleWords;
    for (let y = 0; y < height; y++) {
      const offset = rowOffsets[comp][y];
      let srcWords = offset >> 1;
      for (let x = 0; x < width; x++) {
        dataView.setFloat32(offset + x * INT16_SIZE * sampleWords, float16ToFloat32(outWords[srcWords]), true);
        srcWords += sampleWords;
      }
    }
  }

  return {
    acConsumed: currAcComp.value - acOffset,
    dcConsumed: currDcComp[numComp - 1] - dcOffset,
  };
}

function lossyDctChannelDecode(
  channelIndex: number,
  rowPtrs: Int32Array[],
  channelData: DwaChannelData[],
  acBuffer: Uint16Array,
  dcBuffer: Uint16Array,
  outBuffer: Uint8Array,
  acOffset: number,
  dcOffset: number,
): DecodeUsage {
  const dataView = new DataView(outBuffer.buffer, outBuffer.byteOffset, outBuffer.byteLength);
  const outWords = new Uint16Array(outBuffer.buffer, outBuffer.byteOffset, outBuffer.byteLength >> 1);
  const channel = channelData[channelIndex];
  const width = channel.width;
  const height = channel.height;

  const numBlocksX = Math.ceil(width / 8);
  const numBlocksY = Math.ceil(height / 8);
  const numFullBlocksX = Math.floor(width / 8);
  const leftoverX = width - (numBlocksX - 1) * 8;
  const leftoverY = height - (numBlocksY - 1) * 8;

  const currAcComp: Cursor = { value: acOffset };
  let currDcComp = dcOffset;
  const dctData = new Float32Array(64);
  const halfZigBlock = new Uint16Array(64);
  const rowBlock = new Uint16Array(numBlocksX * 64);

  for (let blockY = 0; blockY < numBlocksY; blockY++) {
    let maxY = 8;
    if (blockY === numBlocksY - 1) maxY = leftoverY;

    for (let blockX = 0; blockX < numBlocksX; blockX++) {
      halfZigBlock.fill(0);

      if (currDcComp >= dcBuffer.length) {
        throw new Error('Invalid DWA DC coefficient bounds.');
      }

      halfZigBlock[0] = dcBuffer[currDcComp++];
      unRleAC(currAcComp, acBuffer, halfZigBlock);
      unZigZag(halfZigBlock, dctData);
      dctInverse(dctData);
      convertToHalf(dctData, rowBlock, blockX * 64);
    }

    for (let y = 8 * blockY; y < 8 * blockY + maxY; y++) {
      let offsetWords = rowPtrs[channelIndex][y] >> 1;

      for (let blockX = 0; blockX < numFullBlocksX; blockX++) {
        const src = blockX * 64 + ((y & 0x7) * 8);

        for (let x = 0; x < 8; x++) {
          outWords[offsetWords + x * channel.sampleWords] = rowBlock[src + x];
        }
        offsetWords += 8 * channel.sampleWords;
      }

      if (numBlocksX !== numFullBlocksX) {
        const src = numFullBlocksX * 64 + ((y & 0x7) * 8);
        for (let x = 0; x < leftoverX; x++) {
          outWords[offsetWords + x * channel.sampleWords] = rowBlock[src + x];
        }
      }
    }
  }

  if (channel.pixelType === 2) {
    for (let y = 0; y < height; y++) {
      const offset = rowPtrs[channelIndex][y];
      let srcWords = offset >> 1;
      for (let x = 0; x < width; x++) {
        dataView.setFloat32(offset + x * INT16_SIZE * channel.sampleWords, float16ToFloat32(outWords[srcWords]), true);
        srcWords += channel.sampleWords;
      }
    }
  }

  channel.decoded = true;
  return {
    acConsumed: currAcComp.value - acOffset,
    dcConsumed: currDcComp - dcOffset,
  };
}

function suffixForChannel(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1) : name;
}

function matchesRule(channelName: string, rule: DwaRule): boolean {
  if (rule.caseInsensitive) {
    return channelName.localeCompare(rule.name, undefined, { sensitivity: 'accent' }) === 0;
  }
  return channelName === rule.name;
}

function parseDwaHeader(view: DataView, cursor: Cursor): DwaHeader {
  return {
    version: readInt64(view, cursor),
    unknownUncompressedSize: readInt64(view, cursor),
    unknownCompressedSize: readInt64(view, cursor),
    acCompressedSize: readInt64(view, cursor),
    dcCompressedSize: readInt64(view, cursor),
    rleCompressedSize: readInt64(view, cursor),
    rleUncompressedSize: readInt64(view, cursor),
    rleRawSize: readInt64(view, cursor),
    totalAcUncompressedCount: readInt64(view, cursor),
    totalDcUncompressedCount: readInt64(view, cursor),
    acCompression: readInt64(view, cursor),
  };
}

function parseDwaRules(bytes: Uint8Array, view: DataView, cursor: Cursor): DwaRule[] {
  const rulesSize = readUint16(view, cursor);
  if (rulesSize < 2) {
    throw new Error('Invalid DWA channel rules payload size.');
  }

  const rulesEnd = cursor.value + (rulesSize - 2);
  if (rulesEnd > bytes.length) {
    throw new Error('Truncated DWA channel rules payload.');
  }

  const rules: DwaRule[] = [];
  while (cursor.value < rulesEnd) {
    const name = readCStringWithin(bytes, cursor, rulesEnd, 'DWA channel rule name');
    const value = readUint8(view, cursor);
    const compression = (value >> 2) & 0x3;
    const index = (value >> 4) - 1;
    const caseInsensitive = (value & 1) !== 0;
    const pixelType = readUint8(view, cursor);

    rules.push({
      name,
      compression,
      index,
      pixelType,
      caseInsensitive,
    });
  }

  if (cursor.value !== rulesEnd) {
    throw new Error('Invalid DWA channel rules alignment.');
  }

  return rules;
}

function decodeDwaChunk(context: DwaDecodeContext): Uint8Array {
  if (!context.part.dataWindow) {
    throw new Error('Missing DWA part data window.');
  }

  if (context.linesInChunk <= 0) {
    return new Uint8Array(0);
  }

  const xMin = context.part.dataWindow.xMin;
  const xMax = context.part.dataWindow.xMax;
  const columns = xMax - xMin + 1;
  const lines = context.linesInChunk;

  for (const channel of context.part.channels) {
    const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
    const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;
    if (xSampling !== 1 || ySampling !== 1) {
      throw new Error('DWAA/DWAB decoding currently requires xSampling=1 and ySampling=1 for all channels.');
    }
  }

  const bytes = new Uint8Array(context.buffer, context.dataPtr, context.dataSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor: Cursor = { value: 0 };

  const header = parseDwaHeader(view, cursor);
  if (header.version < 1 || header.version > 2) {
    throw new Error(`Unsupported DWA version ${header.version}.`);
  }

  const rules = header.version >= 2 ? parseDwaRules(bytes, view, cursor) : LEGACY_DWA_RULES;

  if (header.unknownCompressedSize > 0 || header.unknownUncompressedSize > 0) {
    throw new Error('DWAA/DWAB UNKNOWN channel blocks are not supported.');
  }

  const channelData: DwaChannelData[] = context.part.channels.map((channel) => ({
    name: channel.name,
    compression: UNKNOWN,
    decoded: false,
    pixelType: channel.pixelType,
    sampleWords: channel.pixelType === 1 ? 1 : 2,
    pLinear: channel.pLinear,
    width: columns,
    height: lines,
  }));

  const cscSet: DwaCscSet = { idx: new Array(3) };
  for (let offset = 0; offset < channelData.length; offset++) {
    const channel = channelData[offset];
    const suffix = suffixForChannel(channel.name);

    for (const rule of rules) {
      if (rule.pixelType !== channel.pixelType) continue;
      if (!matchesRule(suffix, rule)) continue;

      channel.compression = rule.compression;
      if (rule.index >= 0) {
        cscSet.idx[rule.index] = offset;
      }
      break;
    }
  }

  for (const channel of channelData) {
    if (channel.compression !== LOSSY_DCT && channel.compression !== RLE) {
      throw new Error(`Unsupported DWA channel compression for channel ${channel.name}.`);
    }
    if (channel.compression === LOSSY_DCT && channel.pixelType !== 1 && channel.pixelType !== 2) {
      throw new Error(`Unsupported DWA lossy channel pixel type for channel ${channel.name}.`);
    }
  }

  let acBuffer = new Uint16Array(0);
  let dcBuffer = new Uint16Array(0);
  let rleBuffer = new Uint8Array(0);

  if (header.acCompressedSize > 0) {
    if (cursor.value + header.acCompressedSize > bytes.length) {
      throw new Error('Truncated DWA AC payload.');
    }

    switch (header.acCompression) {
      case STATIC_HUFFMAN: {
        acBuffer = new Uint16Array(header.totalAcUncompressedCount);
        const acStart = cursor.value;
        hufUncompress(bytes, view, cursor, header.acCompressedSize, acBuffer, header.totalAcUncompressedCount);
        cursor.value = acStart + header.acCompressedSize;
        break;
      }
      case DEFLATE: {
        const compressed = bytes.subarray(cursor.value, cursor.value + header.acCompressedSize);
        const decoded = unzlibSync(compressed, {
          out: new Uint8Array(header.totalAcUncompressedCount * INT16_SIZE),
        });
        if (decoded.byteLength % 2 !== 0) {
          throw new Error('Invalid DWA AC DEFLATE payload size.');
        }
        const decodedWords = decoded.byteLength / 2;
        if (decodedWords !== header.totalAcUncompressedCount) {
          throw new Error('Invalid DWA AC DEFLATE payload length.');
        }
        acBuffer = new Uint16Array(decoded.buffer, decoded.byteOffset, decodedWords);
        cursor.value += header.acCompressedSize;
        break;
      }
      default:
        throw new Error(`Unsupported DWA AC compression mode ${header.acCompression}.`);
    }
  } else if (header.totalAcUncompressedCount !== 0) {
    throw new Error('Invalid DWA AC payload metadata.');
  }

  if (header.dcCompressedSize > 0) {
    const dcBytes = uncompressZipStyle(
      bytes,
      cursor.value,
      header.dcCompressedSize,
      header.totalDcUncompressedCount * INT16_SIZE,
      DWA_DC_SCRATCH,
    );
    if (dcBytes.byteLength % 2 !== 0) {
      throw new Error('Invalid DWA DC payload size.');
    }

    const dcWords = dcBytes.byteLength / 2;
    if (dcWords !== header.totalDcUncompressedCount) {
      throw new Error('Invalid DWA DC payload length.');
    }

    dcBuffer = new Uint16Array(dcBytes.buffer, dcBytes.byteOffset, dcWords);
    cursor.value += header.dcCompressedSize;
  } else if (header.totalDcUncompressedCount !== 0) {
    throw new Error('Invalid DWA DC payload metadata.');
  }

  if (header.rleRawSize > 0) {
    if (cursor.value + header.rleCompressedSize > bytes.length) {
      throw new Error('Truncated DWA RLE payload.');
    }

    const compressed = bytes.subarray(cursor.value, cursor.value + header.rleCompressedSize);
    const decoded = unzlibSync(compressed, {
      out: new Uint8Array(header.rleUncompressedSize),
    });
    if (decoded.byteLength !== header.rleUncompressedSize) {
      throw new Error('Invalid DWA RLE intermediate payload length.');
    }

    rleBuffer = decodeRunLength(decoded, header.rleRawSize);

    cursor.value += header.rleCompressedSize;
  } else if (header.rleCompressedSize !== 0 || header.rleUncompressedSize !== 0) {
    throw new Error('Invalid DWA RLE payload metadata.');
  }

  let outputSize = 0;
  const rowOffsets: Int32Array[] = new Array(channelData.length);
  for (let i = 0; i < channelData.length; i++) {
    rowOffsets[i] = new Int32Array(lines);
  }

  for (let y = 0; y < lines; y++) {
    for (let chan = 0; chan < channelData.length; chan++) {
      rowOffsets[chan][y] = outputSize;
      outputSize += channelData[chan].width * channelData[chan].sampleWords * INT16_SIZE;
    }
  }

  const outBuffer = new Uint8Array(outputSize);
  let acOffset = 0;
  let dcOffset = 0;

  if (cscSet.idx[0] !== undefined && cscSet.idx[1] !== undefined && cscSet.idx[2] !== undefined) {
    const usage = lossyDctDecode(cscSet, rowOffsets, channelData, acBuffer, dcBuffer, outBuffer, acOffset, dcOffset);
    acOffset += usage.acConsumed;
    dcOffset += usage.dcConsumed;
  }

  let rleOffset = 0;
  for (let i = 0; i < channelData.length; i++) {
    const channel = channelData[i];
    if (channel.decoded) continue;

    switch (channel.compression) {
      case RLE: {
        for (let y = 0; y < lines; y++) {
          let rowOffsetBytes = rowOffsets[i][y];
          for (let x = 0; x < channel.width; x++) {
            for (let byte = 0; byte < channel.sampleWords * INT16_SIZE; byte++) {
              const src = rleOffset + byte * channel.width * channel.height;
              if (src < 0 || src >= rleBuffer.length) {
                throw new Error('Invalid DWA RLE planar bounds.');
              }
              outBuffer[rowOffsetBytes++] = rleBuffer[src];
            }
            rleOffset++;
          }
        }
        channel.decoded = true;
        break;
      }
      case LOSSY_DCT: {
        const usage = lossyDctChannelDecode(i, rowOffsets, channelData, acBuffer, dcBuffer, outBuffer, acOffset, dcOffset);
        acOffset += usage.acConsumed;
        dcOffset += usage.dcConsumed;
        break;
      }
      default:
        throw new Error(`Unsupported DWA channel compression for channel ${channel.name}.`);
    }
  }

  return outBuffer;
}

export function decodeDwaBlock(context: DwaDecodeContext): Uint8Array {
  try {
    return decodeDwaChunk(context);
  } catch (error) {
    if (error instanceof ExrError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new ExrError('DECOMPRESSION_FAILED', 'Failed to decompress DWAA/DWAB chunk.', {
      partId: context.partId,
      chunkIndex: context.chunkIndex,
      size: context.dataSize,
      reason,
    });
  }
}
