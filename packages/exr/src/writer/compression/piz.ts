import { ExrError } from '../../shared/errors';
import { PartWriteMeta } from '../meta';
import { isSampledCoordinate } from '../sampling';

const USHORT_RANGE = 1 << 16;
const BITMAP_SIZE = USHORT_RANGE >> 3;

const HUF_ENCBITS = 16;
const HUF_ENCSIZE = (1 << HUF_ENCBITS) + 1;

const SHORT_ZEROCODE_RUN = 59;
const LONG_ZEROCODE_RUN = 63;
const SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;
const LONGEST_LONG_RUN = 255 + SHORTEST_LONG_RUN;

const NBITS = 16;
const A_OFFSET = 1 << (NBITS - 1);
const M_OFFSET = 1 << (NBITS - 1);
const MOD_MASK = (1 << NBITS) - 1;

const MAX_SAFE_HUF_CODE_LENGTH = 30;

interface PizChannelLayout {
  channel: PartWriteMeta['channels'][number];
  sampledWidth: number;
  sampledRows: number;
  wordsPerSample: number;
  wordsPerRow: number;
  wordStart: number;
  wordEnd: number;
  wordCursor: number;
}

interface HuffmanEncoding {
  minSymbol: number;
  maxSymbol: number;
  tableBytes: Uint8Array;
  nBits: number;
  dataBytes: Uint8Array;
}

interface HuffmanNode {
  index: number;
  frequency: number;
  symbol: number;
  left: number;
  right: number;
  tieBreaker: number;
}

class BitWriter {
  private readonly bytes: number[] = [];
  private bitBuffer = 0;
  private bitCount = 0;
  private bitLength = 0;

  public writeBits(nBits: number, bits: number): void {
    if (nBits <= 0) {
      return;
    }

    const maskedBits = bits & ((1 << nBits) - 1);
    this.bitBuffer = this.bitBuffer * 2 ** nBits + maskedBits;
    this.bitCount += nBits;
    this.bitLength += nBits;

    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      this.bytes.push(Math.floor(this.bitBuffer / 2 ** this.bitCount) & 0xff);
    }

    if (this.bitCount === 0) {
      this.bitBuffer = 0;
    } else {
      this.bitBuffer &= (1 << this.bitCount) - 1;
    }
  }

  public finish(): { bytes: Uint8Array; bitLength: number } {
    if (this.bitCount > 0) {
      this.bytes.push((this.bitBuffer << (8 - this.bitCount)) & 0xff);
      this.bitCount = 0;
      this.bitBuffer = 0;
    }

    return {
      bytes: Uint8Array.from(this.bytes),
      bitLength: this.bitLength,
    };
  }
}

function uint16(value: number): number {
  return value & 0xffff;
}

function int16(value: number): number {
  const clamped = uint16(value);
  return clamped > 0x7fff ? clamped - 0x10000 : clamped;
}

function wenc14(a: number, b: number): { l: number; h: number } {
  const as = int16(a);
  const bs = int16(b);

  const ms = (as + bs) >> 1;
  const ds = as - bs;

  return {
    l: uint16(ms),
    h: uint16(ds),
  };
}

function wenc16(a: number, b: number): { l: number; h: number } {
  const ao = (uint16(a) + A_OFFSET) & MOD_MASK;
  let m = (ao + uint16(b)) >> 1;
  let d = ao - uint16(b);

  if (d < 0) {
    m = (m + M_OFFSET) & MOD_MASK;
  }

  d &= MOD_MASK;

  return {
    l: uint16(m),
    h: uint16(d),
  };
}

function wav2Encode(
  buffer: Uint16Array,
  channelOffset: number,
  nx: number,
  ox: number,
  ny: number,
  oy: number,
  maxValue: number,
): void {
  if (nx <= 0 || ny <= 0) {
    return;
  }

  const wavelet14 = maxValue < 1 << 14;
  const minDim = nx > ny ? ny : nx;
  let p = 1;
  let p2 = 2;

  while (p2 <= minDim) {
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
          const r00 = wenc14(buffer[channelOffset + px], buffer[channelOffset + p01]);
          const r10 = wenc14(buffer[channelOffset + p10], buffer[channelOffset + p11]);
          const top = wenc14(r00.l, r10.l);
          const bottom = wenc14(r00.h, r10.h);

          buffer[channelOffset + px] = top.l;
          buffer[channelOffset + p10] = top.h;
          buffer[channelOffset + p01] = bottom.l;
          buffer[channelOffset + p11] = bottom.h;
        } else {
          const r00 = wenc16(buffer[channelOffset + px], buffer[channelOffset + p01]);
          const r10 = wenc16(buffer[channelOffset + p10], buffer[channelOffset + p11]);
          const top = wenc16(r00.l, r10.l);
          const bottom = wenc16(r00.h, r10.h);

          buffer[channelOffset + px] = top.l;
          buffer[channelOffset + p10] = top.h;
          buffer[channelOffset + p01] = bottom.l;
          buffer[channelOffset + p11] = bottom.h;
        }
      }

      if (nx & p) {
        const p10 = px + oy1;
        const result = wavelet14
          ? wenc14(buffer[channelOffset + px], buffer[channelOffset + p10])
          : wenc16(buffer[channelOffset + px], buffer[channelOffset + p10]);
        buffer[channelOffset + px] = result.l;
        buffer[channelOffset + p10] = result.h;
      }
    }

    if (ny & p) {
      let px = py;
      const ex = py + ox * (nx - p2);

      for (; px <= ex; px += ox2) {
        const p01 = px + ox1;
        const result = wavelet14
          ? wenc14(buffer[channelOffset + px], buffer[channelOffset + p01])
          : wenc16(buffer[channelOffset + px], buffer[channelOffset + p01]);
        buffer[channelOffset + px] = result.l;
        buffer[channelOffset + p01] = result.h;
      }
    }

    p = p2;
    p2 <<= 1;
  }
}

function bitmapFromData(data: Uint16Array): { bitmap: Uint8Array; minNonZero: number; maxNonZero: number } {
  const bitmap = new Uint8Array(BITMAP_SIZE);
  let minNonZero = BITMAP_SIZE - 1;
  let maxNonZero = 0;

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    bitmap[value >> 3] |= 1 << (value & 7);
  }

  // Zero is always implied and never explicitly stored in bitmap payload.
  bitmap[0] &= ~1;

  for (let i = 0; i < BITMAP_SIZE; i++) {
    if (bitmap[i] !== 0) {
      if (i < minNonZero) minNonZero = i;
      if (i > maxNonZero) maxNonZero = i;
    }
  }

  return { bitmap, minNonZero, maxNonZero };
}

function forwardLutFromBitmap(bitmap: Uint8Array): { lut: Uint16Array; maxValue: number } {
  const lut = new Uint16Array(USHORT_RANGE);
  let k = 0;

  for (let i = 0; i < USHORT_RANGE; i++) {
    if (i === 0 || (bitmap[i >> 3] & (1 << (i & 7))) !== 0) {
      lut[i] = k++;
    } else {
      lut[i] = 0;
    }
  }

  return { lut, maxValue: k - 1 };
}

function applyLut(lut: Uint16Array, data: Uint16Array): void {
  for (let i = 0; i < data.length; i++) {
    data[i] = lut[data[i]];
  }
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

function buildChannelLayouts(
  part: PartWriteMeta,
  chunkY: number,
  linesInChunk: number,
): { layouts: PizChannelLayout[]; totalWords: number } {
  const layouts: PizChannelLayout[] = [];
  let totalWords = 0;

  for (const channel of part.channels) {
    const sampledRows = countSampledRowsInChunk(channel, chunkY, linesInChunk);
    const wordsPerSample = channel.pixelType === 1 ? 1 : 2;
    const wordsPerRow = channel.sampledWidth * wordsPerSample;
    const wordCount = wordsPerRow * sampledRows;

    layouts.push({
      channel,
      sampledWidth: channel.sampledWidth,
      sampledRows,
      wordsPerSample,
      wordsPerRow,
      wordStart: totalWords,
      wordEnd: totalWords + wordCount,
      wordCursor: totalWords,
    });

    totalWords += wordCount;
  }

  return { layouts, totalWords };
}

function rawToWordPlanes(
  raw: Uint8Array,
  part: PartWriteMeta,
  chunkY: number,
  linesInChunk: number,
  layouts: PizChannelLayout[],
  totalWords: number,
): Uint16Array {
  const out = new Uint16Array(totalWords);
  const rawView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let rawPtr = 0;

  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;

    for (const layout of layouts) {
      const channel = layout.channel;
      if (!isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
        continue;
      }

      const rowByteLength = channel.rowByteLength;
      if (rawPtr + rowByteLength > raw.byteLength) {
        throw new ExrError(
          'ENCODING_FAILED',
          'Failed to split raw PIZ chunk into channel word planes.',
          {
            consumed: rawPtr,
            expected: raw.byteLength,
            rowByteLength,
          },
        );
      }

      const rowWordLength = layout.wordsPerRow;
      if (layout.wordCursor + rowWordLength > layout.wordEnd) {
        throw new ExrError('ENCODING_FAILED', 'PIZ channel plane cursor exceeded expected bounds.', {
          channel: channel.name,
          cursor: layout.wordCursor,
          rowWordLength,
          wordEnd: layout.wordEnd,
        });
      }

      for (let i = 0; i < rowWordLength; i++) {
        out[layout.wordCursor + i] = rawView.getUint16(rawPtr + i * 2, true);
      }

      layout.wordCursor += rowWordLength;
      rawPtr += rowByteLength;
    }
  }

  if (rawPtr !== raw.byteLength) {
    throw new ExrError('ENCODING_FAILED', 'PIZ raw split consumed an unexpected number of bytes.', {
      consumed: rawPtr,
      expected: raw.byteLength,
    });
  }

  for (const layout of layouts) {
    if (layout.wordCursor !== layout.wordEnd) {
      throw new ExrError('ENCODING_FAILED', 'PIZ channel plane fill did not reach expected bounds.', {
        channel: layout.channel.name,
        cursor: layout.wordCursor,
        wordEnd: layout.wordEnd,
      });
    }
  }

  return out;
}

function swapHeapEntries(heap: number[], i: number, j: number): void {
  const temp = heap[i];
  heap[i] = heap[j];
  heap[j] = temp;
}

function compareNodes(a: HuffmanNode, b: HuffmanNode): number {
  if (a.frequency !== b.frequency) {
    return a.frequency - b.frequency;
  }
  return a.tieBreaker - b.tieBreaker;
}

function heapPush(heap: number[], nodes: HuffmanNode[], nodeIndex: number): void {
  heap.push(nodeIndex);
  let i = heap.length - 1;

  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (compareNodes(nodes[heap[parent]], nodes[heap[i]]) <= 0) {
      break;
    }
    swapHeapEntries(heap, parent, i);
    i = parent;
  }
}

function heapPop(heap: number[], nodes: HuffmanNode[]): number {
  const root = heap[0];
  const last = heap.pop();
  if (heap.length === 0 || last === undefined) {
    return root;
  }

  heap[0] = last;

  let i = 0;
  let siftDown = true;
  while (siftDown) {
    const left = i * 2 + 1;
    const right = left + 1;
    let smallest = i;

    if (
      left < heap.length &&
      compareNodes(nodes[heap[left]], nodes[heap[smallest]]) < 0
    ) {
      smallest = left;
    }
    if (
      right < heap.length &&
      compareNodes(nodes[heap[right]], nodes[heap[smallest]]) < 0
    ) {
      smallest = right;
    }
    if (smallest === i) {
      siftDown = false;
      continue;
    }

    swapHeapEntries(heap, i, smallest);
    i = smallest;
  }

  return root;
}

function buildHuffmanCodeLengths(
  frequencies: Uint32Array,
  minSymbol: number,
  maxSymbol: number,
): Uint8Array | null {
  const nodes: HuffmanNode[] = [];
  const heap: number[] = [];
  let nextNodeId = 0;

  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    const frequency = frequencies[symbol];
    if (frequency === 0) {
      continue;
    }

    const node: HuffmanNode = {
      index: nodes.length,
      frequency,
      symbol,
      left: -1,
      right: -1,
      tieBreaker: nextNodeId++,
    };
    nodes.push(node);
    heapPush(heap, nodes, node.index);
  }

  if (heap.length === 0) {
    return null;
  }

  if (heap.length === 1) {
    const lengths = new Uint8Array(HUF_ENCSIZE);
    lengths[nodes[heap[0]].symbol] = 1;
    return lengths;
  }

  while (heap.length > 1) {
    const leftIndex = heapPop(heap, nodes);
    const rightIndex = heapPop(heap, nodes);
    const left = nodes[leftIndex];
    const right = nodes[rightIndex];

    const parent: HuffmanNode = {
      index: nodes.length,
      frequency: left.frequency + right.frequency,
      symbol: -1,
      left: leftIndex,
      right: rightIndex,
      tieBreaker: nextNodeId++,
    };

    nodes.push(parent);
    heapPush(heap, nodes, parent.index);
  }

  const root = heap[0];
  const lengths = new Uint8Array(HUF_ENCSIZE);
  const stack: Array<{ nodeIndex: number; depth: number }> = [{ nodeIndex: root, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const node = nodes[current.nodeIndex];
    if (node.symbol >= 0) {
      lengths[node.symbol] = current.depth === 0 ? 1 : current.depth;
      continue;
    }

    if (node.right >= 0) {
      stack.push({ nodeIndex: node.right, depth: current.depth + 1 });
    }
    if (node.left >= 0) {
      stack.push({ nodeIndex: node.left, depth: current.depth + 1 });
    }
  }

  let maxLength = 0;
  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    if (lengths[symbol] > maxLength) {
      maxLength = lengths[symbol];
    }
  }

  if (maxLength <= 0 || maxLength > 58 || maxLength > MAX_SAFE_HUF_CODE_LENGTH) {
    return null;
  }

  return lengths;
}

function buildCanonicalCodes(
  lengths: Uint8Array,
  minSymbol: number,
  maxSymbol: number,
): Uint32Array | null {
  const counts = new Uint32Array(59);

  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    const length = lengths[symbol];
    if (length >= counts.length) {
      return null;
    }
    counts[length] += 1;
  }

  let code = 0;
  for (let i = counts.length - 1; i > 0; i--) {
    const nextCode = (code + counts[i]) >> 1;
    counts[i] = code;
    code = nextCode;
  }

  const codes = new Uint32Array(HUF_ENCSIZE);
  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    const length = lengths[symbol];
    if (length > 0) {
      codes[symbol] = counts[length]++;
    }
  }

  return codes;
}

function hufPackEncTable(lengths: Uint8Array, minSymbol: number, maxSymbol: number): Uint8Array {
  const writer = new BitWriter();

  for (let symbol = minSymbol; symbol <= maxSymbol; symbol++) {
    const length = lengths[symbol];

    if (length === 0) {
      let zeroRun = 1;
      while (
        symbol < maxSymbol &&
        zeroRun < LONGEST_LONG_RUN &&
        lengths[symbol + 1] === 0
      ) {
        symbol++;
        zeroRun++;
      }

      if (zeroRun >= 2) {
        if (zeroRun >= SHORTEST_LONG_RUN) {
          writer.writeBits(6, LONG_ZEROCODE_RUN);
          writer.writeBits(8, zeroRun - SHORTEST_LONG_RUN);
        } else {
          writer.writeBits(6, SHORT_ZEROCODE_RUN + zeroRun - 2);
        }
        continue;
      }
    }

    writer.writeBits(6, length);
  }

  return writer.finish().bytes;
}

function hufEncodeData(
  values: Uint16Array,
  lengths: Uint8Array,
  codes: Uint32Array,
  runLengthSymbol: number,
): { bytes: Uint8Array; nBits: number } | null {
  if (values.length === 0) {
    return { bytes: new Uint8Array(0), nBits: 0 };
  }

  const runLengthCodeLength = lengths[runLengthSymbol];
  const runLengthCode = codes[runLengthSymbol];

  if (runLengthCodeLength === 0) {
    return null;
  }

  const writer = new BitWriter();

  function emitSymbolRun(symbol: number, runCount: number): boolean {
    const symbolCodeLength = lengths[symbol];
    const symbolCode = codes[symbol];

    if (symbolCodeLength === 0) {
      return false;
    }

    if (symbolCodeLength + runLengthCodeLength + 8 < symbolCodeLength * runCount) {
      writer.writeBits(symbolCodeLength, symbolCode);
      writer.writeBits(runLengthCodeLength, runLengthCode);
      writer.writeBits(8, runCount);
      return true;
    }

    for (let count = runCount; count >= 0; count--) {
      writer.writeBits(symbolCodeLength, symbolCode);
    }

    return true;
  }

  let symbol = values[0];
  let runCount = 0;

  for (let i = 1; i < values.length; i++) {
    const next = values[i];
    if (runCount === 255 || symbol !== next) {
      if (!emitSymbolRun(symbol, runCount)) {
        return null;
      }
      symbol = next;
      runCount = 0;
    } else {
      runCount++;
    }
  }

  if (!emitSymbolRun(symbol, runCount)) {
    return null;
  }

  const result = writer.finish();
  return { bytes: result.bytes, nBits: result.bitLength };
}

function encodeHuffman(values: Uint16Array): HuffmanEncoding | null {
  if (values.length === 0) {
    return {
      minSymbol: 0,
      maxSymbol: 0,
      tableBytes: new Uint8Array(0),
      nBits: 0,
      dataBytes: new Uint8Array(0),
    };
  }

  const frequencies = new Uint32Array(HUF_ENCSIZE);
  let minSymbol = HUF_ENCSIZE;
  let maxDataSymbol = 0;

  for (let i = 0; i < values.length; i++) {
    const symbol = values[i];
    frequencies[symbol] += 1;
    if (symbol < minSymbol) minSymbol = symbol;
    if (symbol > maxDataSymbol) maxDataSymbol = symbol;
  }

  const runLengthSymbol = maxDataSymbol + 1;
  if (runLengthSymbol >= HUF_ENCSIZE) {
    return null;
  }

  frequencies[runLengthSymbol] = 1;
  if (runLengthSymbol < minSymbol) {
    minSymbol = runLengthSymbol;
  }
  const maxSymbol = runLengthSymbol;

  const lengths = buildHuffmanCodeLengths(frequencies, minSymbol, maxSymbol);
  if (!lengths) {
    return null;
  }

  const codes = buildCanonicalCodes(lengths, minSymbol, maxSymbol);
  if (!codes) {
    return null;
  }

  const tableBytes = hufPackEncTable(lengths, minSymbol, maxSymbol);
  const encodedData = hufEncodeData(values, lengths, codes, runLengthSymbol);
  if (!encodedData) {
    return null;
  }

  return {
    minSymbol,
    maxSymbol,
    tableBytes,
    nBits: encodedData.nBits,
    dataBytes: encodedData.bytes,
  };
}

function buildHuffmanPayload(values: Uint16Array): Uint8Array | null {
  const huffman = encodeHuffman(values);
  if (!huffman) {
    return null;
  }

  const totalLength = 20 + huffman.tableBytes.byteLength + huffman.dataBytes.byteLength;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);

  view.setUint32(0, huffman.minSymbol, true);
  view.setUint32(4, huffman.maxSymbol, true);
  view.setUint32(8, huffman.tableBytes.byteLength, true);
  view.setUint32(12, huffman.nBits, true);
  view.setUint32(16, 0, true);

  out.set(huffman.tableBytes, 20);
  out.set(huffman.dataBytes, 20 + huffman.tableBytes.byteLength);

  return out;
}

function buildPizPayload(raw: Uint8Array, part: PartWriteMeta, chunkY: number): Uint8Array | null {
  const linesInChunk = Math.max(0, Math.min(part.linesPerBlock, part.dataWindow.yMax - chunkY + 1));
  const { layouts, totalWords } = buildChannelLayouts(part, chunkY, linesInChunk);

  if (totalWords === 0) {
    return new Uint8Array(0);
  }

  const words = rawToWordPlanes(raw, part, chunkY, linesInChunk, layouts, totalWords);
  const { bitmap, minNonZero, maxNonZero } = bitmapFromData(words);
  const { lut, maxValue } = forwardLutFromBitmap(bitmap);

  applyLut(lut, words);

  for (const layout of layouts) {
    for (let component = 0; component < layout.wordsPerSample; component++) {
      wav2Encode(
        words,
        layout.wordStart + component,
        layout.sampledWidth,
        layout.wordsPerSample,
        layout.sampledRows,
        layout.sampledWidth * layout.wordsPerSample,
        maxValue,
      );
    }
  }

  const huffmanPayload = buildHuffmanPayload(words);
  if (!huffmanPayload) {
    return null;
  }

  const bitmapLength = minNonZero <= maxNonZero ? maxNonZero - minNonZero + 1 : 0;
  const payloadLength = 4 + bitmapLength + 4 + huffmanPayload.byteLength;
  const payload = new Uint8Array(payloadLength);
  const view = new DataView(payload.buffer);

  view.setUint16(0, minNonZero, true);
  view.setUint16(2, maxNonZero, true);

  let offset = 4;
  if (bitmapLength > 0) {
    payload.set(bitmap.subarray(minNonZero, maxNonZero + 1), offset);
    offset += bitmapLength;
  }

  view.setUint32(offset, huffmanPayload.byteLength, true);
  offset += 4;
  payload.set(huffmanPayload, offset);

  return payload;
}

export function encodePizChunk(raw: Uint8Array, part: PartWriteMeta, chunkY: number): Uint8Array {
  if (raw.byteLength === 0) {
    return raw;
  }

  const encoded = buildPizPayload(raw, part, chunkY);
  if (!encoded || encoded.byteLength >= raw.byteLength) {
    return raw;
  }

  return encoded;
}
