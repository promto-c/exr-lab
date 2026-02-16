import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { decodeExrPart, ExrError, parseExrStructure } from '../index';

type PixelType = 0 | 1 | 2;

interface TestChannel {
  name: string;
  pixelType: PixelType;
  xSampling?: number;
  ySampling?: number;
  valueAt: (x: number, y: number) => number;
}

interface BuildOptions {
  width: number;
  height: number;
  compression: number;
  channels: TestChannel[];
  extraAttributes?: Array<{
    name: string;
    type: string;
    payload: number[];
  }>;
}

const UINT32_MAX = 4294967295;

function pushInt32LE(target: number[], value: number) {
  target.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function pushUint32LE(target: number[], value: number) {
  const v = value >>> 0;
  target.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}

function writeCString(target: number[], text: string) {
  for (let i = 0; i < text.length; i++) {
    target.push(text.charCodeAt(i));
  }
  target.push(0);
}

function readCString(source: Uint8Array, offset: number): { value: string; nextOffset: number } {
  let value = '';
  let cursor = offset;
  while (cursor < source.length) {
    const ch = source[cursor];
    cursor += 1;
    if (ch === 0) {
      return { value, nextOffset: cursor };
    }
    value += String.fromCharCode(ch);
  }
  throw new Error('Malformed test buffer: unterminated C string.');
}

function readInt32LE(source: Uint8Array, offset: number): number {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  return view.getInt32(offset, true);
}

function writeInt32LE(source: Uint8Array, offset: number, value: number) {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  view.setInt32(offset, value, true);
}

interface HeaderAttributeInfo {
  name: string;
  type: string;
  size: number;
  sizeOffset: number;
  payloadOffset: number;
  payloadEnd: number;
}

function listHeaderAttributes(buffer: ArrayBuffer): HeaderAttributeInfo[] {
  const bytes = new Uint8Array(buffer);
  let offset = 8;
  const result: HeaderAttributeInfo[] = [];

  while (offset < bytes.length) {
    const nameInfo = readCString(bytes, offset);
    offset = nameInfo.nextOffset;
    if (nameInfo.value === '') {
      break;
    }

    const typeInfo = readCString(bytes, offset);
    offset = typeInfo.nextOffset;
    const sizeOffset = offset;
    const size = readInt32LE(bytes, sizeOffset);
    offset += 4;

    const payloadOffset = offset;
    const payloadEnd = payloadOffset + size;

    result.push({
      name: nameInfo.value,
      type: typeInfo.value,
      size,
      sizeOffset,
      payloadOffset,
      payloadEnd,
    });

    offset = payloadEnd;
  }

  return result;
}

function getHeaderAttribute(buffer: ArrayBuffer, name: string): HeaderAttributeInfo {
  const attribute = listHeaderAttributes(buffer).find((candidate) => candidate.name === name);
  if (!attribute) {
    throw new Error(`Test attribute ${name} not found.`);
  }
  return attribute;
}

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

function arrayBufferFromNodeBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function expectExrErrorCode(action: () => unknown, code: ExrError['code']) {
  expect(action).toThrowError(ExrError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExrError);
    expect((error as ExrError).code).toBe(code);
  }
}

function firstSampleCoordinate(min: number, sampling: number): number {
  if (sampling <= 1) return min;
  const rem = ((min % sampling) + sampling) % sampling;
  return rem === 0 ? min : min + (sampling - rem);
}

function sampleCount(min: number, max: number, sampling: number): number {
  if (sampling <= 0 || max < min) return 0;
  const first = firstSampleCoordinate(min, sampling);
  if (first > max) return 0;
  return Math.floor((max - first) / sampling) + 1;
}

function interleave(data: Uint8Array): Uint8Array {
  const length = data.length;
  const half = Math.floor((length + 1) / 2);
  const out = new Uint8Array(length);

  let even = 0;
  let odd = half;
  for (let i = 0; i < length; i++) {
    if ((i & 1) === 0) {
      out[even++] = data[i];
    } else {
      out[odd++] = data[i];
    }
  }

  return out;
}

function applyPredictor(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  const out = new Uint8Array(data.length);
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = (data[i] - data[i - 1] + 128) & 0xff;
  }
  return out;
}

function rleCompress(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const end = data.length;
  let runs = 0;
  let rune = runs + 1;

  while (runs < end) {
    let count = 0;
    while (rune < end && data[runs] === data[rune] && count < 127) {
      rune++;
      count++;
    }

    if (count >= 2) {
      out.push(count & 0xff);
      out.push(data[runs]);
      runs = rune;
    } else {
      count++;
      while (
        rune < end &&
        ((rune + 1 >= end || data[rune] !== data[rune + 1]) ||
          (rune + 2 >= end || data[rune + 1] !== data[rune + 2])) &&
        count < 127
      ) {
        count++;
        rune++;
      }

      out.push((-count) & 0xff);
      while (runs < rune) {
        out.push(data[runs++]);
      }
    }

    rune++;
  }

  return Uint8Array.from(out);
}

function float32ToFloat16(value: number): number {
  if (Object.is(value, 0)) return 0;

  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = value;

  const bits = intView[0];
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

function float32ToBytes(value: number): number[] {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, true);
  return [scratch.getUint8(0), scratch.getUint8(1), scratch.getUint8(2), scratch.getUint8(3)];
}

function encodeB44TransformedHalf(halfValue: number): number {
  if ((halfValue & 0x7c00) === 0x7c00) {
    return 0x8000;
  }
  if ((halfValue & 0x8000) !== 0) {
    return (~halfValue) & 0xffff;
  }
  return halfValue | 0x8000;
}

function encodeFlatB44Block14(halfValue: number): number[] {
  const transformed = encodeB44TransformedHalf(halfValue);
  return [
    (transformed >> 8) & 0xff,
    transformed & 0xff,
    0x02,
    0x08,
    0x20,
    0x82,
    0x08,
    0x20,
    0x82,
    0x08,
    0x20,
    0x82,
    0x08,
    0x20,
  ];
}

function encodeFlatB44ABlock3(halfValue: number): number[] {
  const transformed = encodeB44TransformedHalf(halfValue);
  return [(transformed >> 8) & 0xff, transformed & 0xff, 0xfc];
}

function buildSinglePartFlatB44Exr(options: {
  width: number;
  height: number;
  compression: 6 | 7;
  value: number;
  includeFloat?: boolean;
}): ArrayBuffer {
  const { width, height, compression, value, includeFloat = false } = options;
  const xMin = 0;
  const yMin = 0;
  const xMax = width - 1;
  const yMax = height - 1;

  const bytes: number[] = [];

  pushUint32LE(bytes, 20000630); // magic
  pushUint32LE(bytes, 2); // version 2, no flags

  const chlist: number[] = [];
  writeCString(chlist, 'H');
  pushInt32LE(chlist, 1); // HALF
  chlist.push(0, 0, 0, 0); // pLinear + reserved
  pushInt32LE(chlist, 1);
  pushInt32LE(chlist, 1);
  if (includeFloat) {
    writeCString(chlist, 'F');
    pushInt32LE(chlist, 2); // FLOAT
    chlist.push(0, 0, 0, 0); // pLinear + reserved
    pushInt32LE(chlist, 1);
    pushInt32LE(chlist, 1);
  }
  chlist.push(0);

  const writeAttribute = (name: string, type: string, payload: number[]) => {
    writeCString(bytes, name);
    writeCString(bytes, type);
    pushInt32LE(bytes, payload.length);
    bytes.push(...payload);
  };

  const windowPayload: number[] = [];
  pushInt32LE(windowPayload, xMin);
  pushInt32LE(windowPayload, yMin);
  pushInt32LE(windowPayload, xMax);
  pushInt32LE(windowPayload, yMax);

  writeAttribute('channels', 'chlist', chlist);
  writeAttribute('compression', 'compression', [compression]);
  writeAttribute('dataWindow', 'box2i', windowPayload);
  writeAttribute('displayWindow', 'box2i', windowPayload);
  writeAttribute('lineOrder', 'lineOrder', [0, 0, 0, 0]);
  bytes.push(0); // end-of-header marker

  const linesPerBlock = 32;
  const chunkCount = Math.ceil(height / linesPerBlock);
  const offsetTableStart = bytes.length;

  for (let i = 0; i < chunkCount; i++) {
    bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  }

  const chunkOffsets: number[] = [];
  const halfValue = float32ToFloat16(value);

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const chunkY = yMin + chunkIndex * linesPerBlock;
    const linesInChunk = Math.max(0, Math.min(linesPerBlock, yMax - chunkY + 1));
    const blockCountX = Math.ceil(width / 4);
    const blockCountY = Math.ceil(linesInChunk / 4);
    const block =
      compression === 7 ? encodeFlatB44ABlock3(halfValue) : encodeFlatB44Block14(halfValue);

    const payload: number[] = [];
    for (let i = 0; i < blockCountX * blockCountY; i++) {
      payload.push(...block);
    }
    if (includeFloat) {
      for (let y = 0; y < linesInChunk; y++) {
        const worldY = chunkY + y;
        for (let x = 0; x < width; x++) {
          payload.push(...float32ToBytes(x + worldY * 10 + 0.25));
        }
      }
    }

    const chunkOffset = bytes.length;
    chunkOffsets.push(chunkOffset);
    pushInt32LE(bytes, chunkY);
    pushInt32LE(bytes, payload.length);
    bytes.push(...payload);
  }

  for (let i = 0; i < chunkOffsets.length; i++) {
    const ptr = offsetTableStart + i * 8;
    const offset = chunkOffsets[i];
    bytes[ptr + 0] = offset & 0xff;
    bytes[ptr + 1] = (offset >> 8) & 0xff;
    bytes[ptr + 2] = (offset >> 16) & 0xff;
    bytes[ptr + 3] = (offset >> 24) & 0xff;
    bytes[ptr + 4] = 0;
    bytes[ptr + 5] = 0;
    bytes[ptr + 6] = 0;
    bytes[ptr + 7] = 0;
  }

  return Uint8Array.from(bytes).buffer;
}

function buildSinglePartRawB44LikeExr(options: {
  width: number;
  height: number;
  compression: 6 | 7;
  channels: TestChannel[];
}): ArrayBuffer {
  const { width, height, compression, channels } = options;
  const xMin = 0;
  const yMin = 0;
  const xMax = width - 1;
  const yMax = height - 1;

  const bytes: number[] = [];
  pushUint32LE(bytes, 20000630); // magic
  pushUint32LE(bytes, 2); // version 2, no flags

  const chlist: number[] = [];
  for (const channel of channels) {
    writeCString(chlist, channel.name);
    pushInt32LE(chlist, channel.pixelType);
    chlist.push(0, 0, 0, 0); // pLinear + reserved
    pushInt32LE(chlist, channel.xSampling ?? 1);
    pushInt32LE(chlist, channel.ySampling ?? 1);
  }
  chlist.push(0);

  const writeAttribute = (name: string, type: string, payload: number[]) => {
    writeCString(bytes, name);
    writeCString(bytes, type);
    pushInt32LE(bytes, payload.length);
    bytes.push(...payload);
  };

  const windowPayload: number[] = [];
  pushInt32LE(windowPayload, xMin);
  pushInt32LE(windowPayload, yMin);
  pushInt32LE(windowPayload, xMax);
  pushInt32LE(windowPayload, yMax);

  writeAttribute('channels', 'chlist', chlist);
  writeAttribute('compression', 'compression', [compression]);
  writeAttribute('dataWindow', 'box2i', windowPayload);
  writeAttribute('displayWindow', 'box2i', windowPayload);
  writeAttribute('lineOrder', 'lineOrder', [0, 0, 0, 0]);
  bytes.push(0); // end-of-header marker

  const linesPerBlock = 32;
  const chunkCount = Math.ceil(height / linesPerBlock);
  const offsetTableStart = bytes.length;

  for (let i = 0; i < chunkCount; i++) {
    bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  }

  const chunkOffsets: number[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const chunkY = yMin + chunkIndex * linesPerBlock;
    const rawBlock: number[] = [];

    for (let dy = 0; dy < linesPerBlock; dy++) {
      const y = chunkY + dy;
      if (y > yMax) break;

      for (const channel of channels) {
        const xSampling = channel.xSampling ?? 1;
        const ySampling = channel.ySampling ?? 1;
        const originY = firstSampleCoordinate(yMin, ySampling);

        if (y < originY || (y - originY) % ySampling !== 0) {
          continue;
        }

        const originX = firstSampleCoordinate(xMin, xSampling);
        const count = sampleCount(xMin, xMax, xSampling);

        for (let sx = 0; sx < count; sx++) {
          const x = originX + sx * xSampling;
          const value = channel.valueAt(x, y);

          if (channel.pixelType === 1) {
            const encoded = float32ToFloat16(value);
            rawBlock.push(encoded & 0xff, (encoded >> 8) & 0xff);
          } else if (channel.pixelType === 2) {
            rawBlock.push(...float32ToBytes(value));
          } else {
            const asUint = Math.round(Math.max(0, Math.min(1, value)) * UINT32_MAX);
            pushUint32LE(rawBlock, asUint);
          }
        }
      }
    }

    const chunkOffset = bytes.length;
    chunkOffsets.push(chunkOffset);
    pushInt32LE(bytes, chunkY);
    pushInt32LE(bytes, rawBlock.length);
    bytes.push(...rawBlock);
  }

  for (let i = 0; i < chunkOffsets.length; i++) {
    const ptr = offsetTableStart + i * 8;
    const offset = chunkOffsets[i];
    bytes[ptr + 0] = offset & 0xff;
    bytes[ptr + 1] = (offset >> 8) & 0xff;
    bytes[ptr + 2] = (offset >> 16) & 0xff;
    bytes[ptr + 3] = (offset >> 24) & 0xff;
    bytes[ptr + 4] = 0;
    bytes[ptr + 5] = 0;
    bytes[ptr + 6] = 0;
    bytes[ptr + 7] = 0;
  }

  return Uint8Array.from(bytes).buffer;
}

function buildSinglePartExr(options: BuildOptions): ArrayBuffer {
  const { width, height, compression, channels, extraAttributes = [] } = options;
  const xMin = 0;
  const yMin = 0;
  const xMax = width - 1;
  const yMax = height - 1;

  const bytes: number[] = [];

  pushUint32LE(bytes, 20000630); // magic
  pushUint32LE(bytes, 2); // version 2, no flags

  const chlist: number[] = [];
  for (const channel of channels) {
    writeCString(chlist, channel.name);
    pushInt32LE(chlist, channel.pixelType);
    chlist.push(0, 0, 0, 0); // pLinear + reserved
    pushInt32LE(chlist, channel.xSampling ?? 1);
    pushInt32LE(chlist, channel.ySampling ?? 1);
  }
  chlist.push(0);

  const compressionPayload = [compression & 0xff];

  const dataWindowPayload: number[] = [];
  pushInt32LE(dataWindowPayload, xMin);
  pushInt32LE(dataWindowPayload, yMin);
  pushInt32LE(dataWindowPayload, xMax);
  pushInt32LE(dataWindowPayload, yMax);

  const displayWindowPayload = [...dataWindowPayload];

  const lineOrderPayload = [0, 0, 0, 0];

  const writeAttribute = (name: string, type: string, payload: number[]) => {
    writeCString(bytes, name);
    writeCString(bytes, type);
    pushInt32LE(bytes, payload.length);
    bytes.push(...payload);
  };

  writeAttribute('channels', 'chlist', chlist);
  writeAttribute('compression', 'compression', compressionPayload);
  writeAttribute('dataWindow', 'box2i', dataWindowPayload);
  writeAttribute('displayWindow', 'box2i', displayWindowPayload);
  writeAttribute('lineOrder', 'lineOrder', lineOrderPayload);
  for (const attribute of extraAttributes) {
    writeAttribute(attribute.name, attribute.type, attribute.payload);
  }

  bytes.push(0); // end-of-header marker

  const linesPerBlock = compression === 3 ? 16 : 1;
  const chunkCount = Math.ceil(height / linesPerBlock);
  const offsetTableStart = bytes.length;

  for (let i = 0; i < chunkCount; i++) {
    bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  }

  const chunkOffsets: number[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const chunkY = yMin + chunkIndex * linesPerBlock;
    const rawBlock: number[] = [];

    for (let dy = 0; dy < linesPerBlock; dy++) {
      const y = chunkY + dy;
      if (y > yMax) break;

      for (const channel of channels) {
        const xSampling = channel.xSampling ?? 1;
        const ySampling = channel.ySampling ?? 1;
        const originY = firstSampleCoordinate(yMin, ySampling);

        if (y < originY || (y - originY) % ySampling !== 0) {
          continue;
        }

        const originX = firstSampleCoordinate(xMin, xSampling);
        const count = sampleCount(xMin, xMax, xSampling);

        for (let sx = 0; sx < count; sx++) {
          const x = originX + sx * xSampling;
          const value = channel.valueAt(x, y);

          if (channel.pixelType === 1) {
            const encoded = float32ToFloat16(value);
            rawBlock.push(encoded & 0xff, (encoded >> 8) & 0xff);
          } else if (channel.pixelType === 2) {
            const scratch = new DataView(new ArrayBuffer(4));
            scratch.setFloat32(0, value, true);
            rawBlock.push(scratch.getUint8(0), scratch.getUint8(1), scratch.getUint8(2), scratch.getUint8(3));
          } else {
            const asUint = Math.round(Math.max(0, Math.min(1, value)) * UINT32_MAX);
            pushUint32LE(rawBlock, asUint);
          }
        }
      }
    }

    let dataBytes: Uint8Array;
    if (compression === 0) {
      dataBytes = Uint8Array.from(rawBlock);
    } else if (compression === 1) {
      const raw = Uint8Array.from(rawBlock);
      const interleaved = interleave(Uint8Array.from(rawBlock));
      const predicted = applyPredictor(interleaved);
      const compressed = rleCompress(predicted);
      dataBytes = compressed.byteLength >= raw.byteLength ? raw : compressed;
    } else {
      const interleaved = interleave(Uint8Array.from(rawBlock));
      const predicted = applyPredictor(interleaved);
      dataBytes = zlibSync(predicted);
    }

    const chunkOffset = bytes.length;
    chunkOffsets.push(chunkOffset);

    pushInt32LE(bytes, chunkY);
    pushInt32LE(bytes, dataBytes.length);
    bytes.push(...dataBytes);
  }

  for (let i = 0; i < chunkOffsets.length; i++) {
    const ptr = offsetTableStart + i * 8;
    const offset = chunkOffsets[i];
    bytes[ptr + 0] = offset & 0xff;
    bytes[ptr + 1] = (offset >> 8) & 0xff;
    bytes[ptr + 2] = (offset >> 16) & 0xff;
    bytes[ptr + 3] = (offset >> 24) & 0xff;
    bytes[ptr + 4] = 0;
    bytes[ptr + 5] = 0;
    bytes[ptr + 6] = 0;
    bytes[ptr + 7] = 0;
  }

  return Uint8Array.from(bytes).buffer;
}

describe('core EXR parser/decoder', () => {
  it('decodes a real PIZ scanline fixture', () => {
    const fixturePath = resolve(__dirname, 'fixtures', 'stripes.piz.exr');
    const fixture = readFileSync(fixturePath);
    const buffer = arrayBufferFromNodeBuffer(fixture);

    const structure = parseExrStructure(buffer);
    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].compression).toBe(4);

    const decoded = decodeExrPart(buffer, structure, { partId: 0 });
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);

    const channels = Object.values(decoded.channels);
    expect(channels.length).toBeGreaterThan(0);

    for (const channel of channels) {
      expect(channel.data.length).toBe(channel.sampledWidth * channel.sampledHeight);
      for (const value of channel.data) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('decodes real DWAA/DWAB scanline fixtures', () => {
    const fixtures = [
      { name: 'comp_dwaa_v2.exr', compression: 8 },
      { name: 'comp_dwab_v2.exr', compression: 9 },
    ];

    for (const fixtureInfo of fixtures) {
      const fixturePath = resolve(__dirname, 'fixtures', fixtureInfo.name);
      const fixture = readFileSync(fixturePath);
      const buffer = arrayBufferFromNodeBuffer(fixture);

      const structure = parseExrStructure(buffer);
      expect(structure.parts).toHaveLength(1);
      expect(structure.parts[0].compression).toBe(fixtureInfo.compression);

      const decoded = decodeExrPart(buffer, structure, { partId: 0 });
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);

      const channels = Object.values(decoded.channels);
      expect(channels.length).toBeGreaterThan(0);

      for (const channel of channels) {
        expect(channel.data.length).toBe(channel.sampledWidth * channel.sampledHeight);
        for (const value of channel.data) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  }, 90000);

  it('decodes a synthetic B44 scanline fixture', () => {
    const buffer = buildSinglePartFlatB44Exr({
      width: 2,
      height: 2,
      compression: 6,
      value: 1,
    });

    const structure = parseExrStructure(buffer);
    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].compression).toBe(6);

    const decoded = decodeExrPart(buffer, structure, { partId: 0 });
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.channels.H.data)).toEqual([1, 1, 1, 1]);
  });

  it('decodes a synthetic B44 scanline fixture with mixed HALF/FLOAT channels', () => {
    const buffer = buildSinglePartFlatB44Exr({
      width: 2,
      height: 2,
      compression: 6,
      value: 1,
      includeFloat: true,
    });

    const structure = parseExrStructure(buffer);
    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].compression).toBe(6);
    expect(structure.parts[0].channels).toHaveLength(2);

    const decoded = decodeExrPart(buffer, structure, { partId: 0 });
    expect(Array.from(decoded.channels.H.data)).toEqual([1, 1, 1, 1]);
    expect(Array.from(decoded.channels.F.data)).toEqual([0.25, 1.25, 10.25, 11.25]);
  });

  it('decodes a synthetic B44A scanline fixture', () => {
    const buffer = buildSinglePartFlatB44Exr({
      width: 2,
      height: 2,
      compression: 7,
      value: 0.5,
    });

    const structure = parseExrStructure(buffer);
    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].compression).toBe(7);

    const decoded = decodeExrPart(buffer, structure, { partId: 0 });
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.channels.H.data)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('treats B44A chunks as raw scanline payload when packed size matches expected size', () => {
    const buffer = buildSinglePartRawB44LikeExr({
      width: 3,
      height: 3,
      compression: 7,
      channels: [
        {
          name: 'B',
          pixelType: 2,
          valueAt: (x, y) => x + y * 10 + 0.25,
        },
        {
          name: 'G',
          pixelType: 2,
          valueAt: (x, y) => x + y * 10 + 0.5,
        },
        {
          name: 'R',
          pixelType: 2,
          valueAt: (x, y) => x + y * 10 + 0.75,
        },
      ],
    });

    const structure = parseExrStructure(buffer);
    expect(structure.parts).toHaveLength(1);
    expect(structure.parts[0].compression).toBe(7);

    const decoded = decodeExrPart(buffer, structure, { partId: 0 });
    expect(Array.from(decoded.channels.B.data)).toEqual([
      0.25, 1.25, 2.25,
      10.25, 11.25, 12.25,
      20.25, 21.25, 22.25,
    ]);
    expect(Array.from(decoded.channels.G.data)).toEqual([
      0.5, 1.5, 2.5,
      10.5, 11.5, 12.5,
      20.5, 21.5, 22.5,
    ]);
    expect(Array.from(decoded.channels.R.data)).toEqual([
      0.75, 1.75, 2.75,
      10.75, 11.75, 12.75,
      20.75, 21.75, 22.75,
    ]);
  });

  it('parses structure and decodes HALF/FLOAT/UINT channels across supported compressions', () => {
    for (const compression of [0, 1, 2, 3]) {
      const buffer = buildSinglePartExr({
        width: 2,
        height: 2,
        compression,
        channels: [
          {
            name: 'H',
            pixelType: 1,
            valueAt: (x, y) => (x + y) % 2,
          },
          {
            name: 'F',
            pixelType: 2,
            valueAt: (x, y) => x + y * 10 + 0.25,
          },
          {
            name: 'U',
            pixelType: 0,
            valueAt: (x, y) => ((x + y) % 2 === 0 ? 1 : 0),
          },
        ],
      });

      const structure = parseExrStructure(buffer);
      expect(structure.parts).toHaveLength(1);
      expect(structure.parts[0].channels).toHaveLength(3);

      const decoded = decodeExrPart(buffer, structure, { partId: 0 });

      expect(decoded.width).toBe(2);
      expect(decoded.height).toBe(2);
      expect(decoded.channels.H.sampledWidth).toBe(2);
      expect(decoded.channels.H.sampledHeight).toBe(2);

      expect(Array.from(decoded.channels.H.data)).toEqual([0, 1, 1, 0]);
      expect(Array.from(decoded.channels.F.data)).toEqual([0.25, 1.25, 10.25, 11.25]);
      expect(Array.from(decoded.channels.U.data)).toEqual([1, 0, 0, 1]);
    }
  });

  it('decodes subsampled channels with compact sampled layout metadata', () => {
    const buffer = buildSinglePartExr({
      width: 4,
      height: 4,
      compression: 0,
      channels: [
        {
          name: 'S',
          pixelType: 2,
          xSampling: 2,
          ySampling: 2,
          valueAt: (x, y) => x + y * 10,
        },
      ],
    });

    const structure = parseExrStructure(buffer);
    const decoded = decodeExrPart(buffer, structure, { partId: 0 });

    const channel = decoded.channels.S;
    expect(channel.xSampling).toBe(2);
    expect(channel.ySampling).toBe(2);
    expect(channel.sampledWidth).toBe(2);
    expect(channel.sampledHeight).toBe(2);
    expect(Array.from(channel.data)).toEqual([0, 2, 20, 22]);
  });

  it('emits structured parse/decode events', () => {
    const events: string[] = [];

    const buffer = buildSinglePartExr({
      width: 1,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: () => 0.5,
        },
      ],
    });

    const structure = parseExrStructure(buffer, {
      onEvent: (event) => events.push(event.code),
    });

    decodeExrPart(buffer, structure, {
      partId: 0,
      onEvent: (event) => events.push(event.code),
    });

    expect(events).toContain('parse.complete');
    expect(events).toContain('decode.complete');
  });

  it('throws typed errors for malformed chunk payload bounds', () => {
    const valid = buildSinglePartExr({
      width: 2,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: (x) => x,
        },
      ],
    });

    const truncated = valid.slice(0, valid.byteLength - 1);
    const structure = parseExrStructure(truncated);
    expectExrErrorCode(() => decodeExrPart(truncated, structure, { partId: 0 }), 'MALFORMED_CHUNK');
  });

  it('fails strict parsing when chlist channel names are unterminated within payload bounds', () => {
    const valid = buildSinglePartExr({
      width: 1,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: () => 0.5,
        },
      ],
    });

    const mutated = cloneBuffer(valid);
    const bytes = new Uint8Array(mutated);
    const channels = getHeaderAttribute(mutated, 'channels');
    bytes[channels.payloadEnd - 1] = 'x'.charCodeAt(0);

    expectExrErrorCode(() => parseExrStructure(mutated), 'MALFORMED_HEADER');
  });

  it('fails strict parsing on truncated chlist channel records', () => {
    const valid = buildSinglePartExr({
      width: 1,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: () => 0.5,
        },
      ],
    });

    const mutated = cloneBuffer(valid);
    const channels = getHeaderAttribute(mutated, 'channels');
    writeInt32LE(new Uint8Array(mutated), channels.sizeOffset, channels.size - 2);

    expectExrErrorCode(() => parseExrStructure(mutated), 'MALFORMED_HEADER');
  });

  it('fails strict parsing for malformed fixed-size attribute sizes', () => {
    const makeBase = () =>
      buildSinglePartExr({
        width: 1,
        height: 1,
        compression: 0,
        channels: [
          {
            name: 'R',
            pixelType: 2,
            valueAt: () => 1,
          },
        ],
      });

    const compressionSize = cloneBuffer(makeBase());
    writeInt32LE(
      new Uint8Array(compressionSize),
      getHeaderAttribute(compressionSize, 'compression').sizeOffset,
      2,
    );
    expectExrErrorCode(() => parseExrStructure(compressionSize), 'MALFORMED_HEADER');

    const box2iSize = cloneBuffer(makeBase());
    writeInt32LE(
      new Uint8Array(box2iSize),
      getHeaderAttribute(box2iSize, 'dataWindow').sizeOffset,
      15,
    );
    expectExrErrorCode(() => parseExrStructure(box2iSize), 'MALFORMED_HEADER');

    const intBuffer = buildSinglePartExr({
      width: 1,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: () => 1,
        },
      ],
      extraAttributes: [
        {
          name: 'myInt',
          type: 'int',
          payload: [4, 3, 2, 1],
        },
      ],
    });
    const intSize = cloneBuffer(intBuffer);
    writeInt32LE(new Uint8Array(intSize), getHeaderAttribute(intSize, 'myInt').sizeOffset, 3);
    expectExrErrorCode(() => parseExrStructure(intSize), 'MALFORMED_HEADER');

    const floatBuffer = buildSinglePartExr({
      width: 1,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: () => 1,
        },
      ],
      extraAttributes: [
        {
          name: 'myFloat',
          type: 'float',
          payload: float32ToBytes(1.25),
        },
      ],
    });
    const floatSize = cloneBuffer(floatBuffer);
    writeInt32LE(new Uint8Array(floatSize), getHeaderAttribute(floatSize, 'myFloat').sizeOffset, 3);
    expectExrErrorCode(() => parseExrStructure(floatSize), 'MALFORMED_HEADER');
  });

  it('keeps unknown attributes as placeholders without breaking parse/decode', () => {
    const buffer = buildSinglePartExr({
      width: 2,
      height: 1,
      compression: 0,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: (x) => x,
        },
      ],
      extraAttributes: [
        {
          name: 'mystery',
          type: 'opaqueType',
          payload: [1, 2, 3, 4],
        },
      ],
    });

    const structure = parseExrStructure(buffer);
    expect(structure.parts[0].attributes.mystery).toBe('<opaqueType data>');

    const decoded = decodeExrPart(buffer, structure, { partId: 0 });
    expect(Array.from(decoded.channels.R.data)).toEqual([0, 1]);
  });

  it('throws UNSUPPORTED_COMPRESSION when no handler exists for the parsed compression id', () => {
    const buffer = buildSinglePartExr({
      width: 1,
      height: 1,
      compression: 5,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: () => 0.5,
        },
      ],
    });

    const structure = parseExrStructure(buffer);
    expectExrErrorCode(() => decodeExrPart(buffer, structure, { partId: 0 }), 'UNSUPPORTED_COMPRESSION');
  });

  it('uses compression handler lines-per-block metadata for chunk accounting', () => {
    const eventMetrics: Array<Record<string, string | number> | undefined> = [];
    const buffer = buildSinglePartExr({
      width: 1,
      height: 17,
      compression: 3,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: (_x, y) => y,
        },
      ],
    });

    const structure = parseExrStructure(buffer);
    decodeExrPart(buffer, structure, {
      partId: 0,
      onEvent: (event) => {
        if (event.code === 'decode.setup') {
          eventMetrics.push(event.metrics);
        }
      },
    });

    expect(eventMetrics).toHaveLength(1);
    expect(eventMetrics[0]?.chunks).toBe(2);
  });

  it('maps ZIP/ZIPS decompression failures to DECOMPRESSION_FAILED', () => {
    const valid = buildSinglePartExr({
      width: 2,
      height: 1,
      compression: 2,
      channels: [
        {
          name: 'R',
          pixelType: 2,
          valueAt: (x) => x + 0.5,
        },
      ],
    });

    const structure = parseExrStructure(valid);
    const bytes = new Uint8Array(cloneBuffer(valid));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunkOffset = Number(view.getBigUint64(structure.headerEndOffset, true));
    const dataSize = view.getInt32(chunkOffset + 4, true);
    const dataPtr = chunkOffset + 8;

    expect(dataSize).toBeGreaterThan(1);
    bytes[dataPtr] = 0;
    bytes[dataPtr + 1] = 0;

    const corrupted = bytes.buffer;
    const corruptedStructure = parseExrStructure(corrupted);
    expectExrErrorCode(() => decodeExrPart(corrupted, corruptedStructure, { partId: 0 }), 'DECOMPRESSION_FAILED');
  });

  it('maps RLE decompression failures to DECOMPRESSION_FAILED', () => {
    const valid = buildSinglePartExr({
      width: 16,
      height: 1,
      compression: 1,
      channels: [
        {
          name: 'R',
          pixelType: 0,
          valueAt: () => 1,
        },
      ],
    });

    const structure = parseExrStructure(valid);
    const bytes = new Uint8Array(cloneBuffer(valid));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunkOffset = Number(view.getBigUint64(structure.headerEndOffset, true));
    const dataSize = view.getInt32(chunkOffset + 4, true);
    const dataPtr = chunkOffset + 8;

    expect(dataSize).toBeGreaterThan(1);
    bytes[dataPtr] = 127;

    const corrupted = bytes.buffer;
    const corruptedStructure = parseExrStructure(corrupted);
    expectExrErrorCode(() => decodeExrPart(corrupted, corruptedStructure, { partId: 0 }), 'DECOMPRESSION_FAILED');
  });
});
