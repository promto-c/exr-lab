import { EXR_MAGIC } from '../shared/constants';
import { ExrError } from '../shared/errors';
import { ExrEvent, ExrEventCallback } from '../shared/events';
import { float32ToFloat16 } from '../shared/half';
import {
  ExrChromaticities,
  ExrWindow,
  WriteExrAttribute,
  WriteExrChannelInput,
  WriteExrInput,
  WriteExrOptions,
  WriteExrPartInput,
} from '../shared/types';
import { ChannelWriteMeta, PartWriteMeta } from './meta';
import {
  getWriteCompressionHandler,
  SUPPORTED_WRITE_COMPRESSION_TEXT,
} from './compression/handlers';
import { countSamplesInRange, firstSampleCoordinate, isSampledCoordinate } from './sampling';

const EXR_VERSION = 2;
const EXR_MULTIPART_FLAG = 0x10;

const UINT32_MAX = 4294967295;
const UTF8_ENCODER = new TextEncoder();
const RESERVED_ATTRIBUTE_NAMES = new Set([
  'channels',
  'compression',
  'dataWindow',
  'displayWindow',
  'lineOrder',
  'name',
  'type',
]);
const CHROMATICITY_FIELDS = [
  'redX',
  'redY',
  'greenX',
  'greenY',
  'blueX',
  'blueY',
  'whiteX',
  'whiteY',
] as const satisfies readonly (keyof ExrChromaticities)[];

class ByteWriter {
  private readonly bytes: number[] = [];

  public get length(): number {
    return this.bytes.length;
  }

  public writeUint8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  public writeInt32(value: number): void {
    const v = value | 0;
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  public writeUint32(value: number): void {
    const v = value >>> 0;
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  public writeBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      this.bytes.push(bytes[i]);
    }
  }

  public writeCString(text: string): void {
    const encoded = UTF8_ENCODER.encode(text);
    this.writeBytes(encoded);
    this.writeUint8(0);
  }

  public patchUint64LE(offset: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new ExrError('ENCODING_FAILED', 'Attempted to patch an invalid chunk offset.', {
        offset,
      });
    }

    const low = value >>> 0;
    const high = Math.floor(value / 4294967296) >>> 0;
    this.patchUint32LE(offset, low);
    this.patchUint32LE(offset + 4, high);
  }

  public toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private patchUint32LE(offset: number, value: number): void {
    if (offset < 0 || offset + 4 > this.bytes.length) {
      throw new ExrError('ENCODING_FAILED', 'Failed to patch bytes outside output bounds.', {
        offset,
        size: this.bytes.length,
      });
    }

    const v = value >>> 0;
    this.bytes[offset + 0] = v & 0xff;
    this.bytes[offset + 1] = (v >> 8) & 0xff;
    this.bytes[offset + 2] = (v >> 16) & 0xff;
    this.bytes[offset + 3] = (v >> 24) & 0xff;
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function emit(onEvent: ExrEventCallback | undefined, event: ExrEvent): void {
  onEvent?.(event);
}

function ensureFiniteInteger(
  value: number,
  field: string,
  details: Record<string, number | string>,
): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ExrError('INVALID_WRITE_INPUT', `Expected integer value for ${field}.`, details);
  }
}

function ensureWindow(window: ExrWindow, field: string, partId: number): ExrWindow {
  ensureFiniteInteger(window.xMin, `${field}.xMin`, { partId });
  ensureFiniteInteger(window.yMin, `${field}.yMin`, { partId });
  ensureFiniteInteger(window.xMax, `${field}.xMax`, { partId });
  ensureFiniteInteger(window.yMax, `${field}.yMax`, { partId });

  if (window.xMax < window.xMin || window.yMax < window.yMin) {
    throw new ExrError('INVALID_WRITE_INPUT', `${field} has invalid extents.`, {
      partId,
      xMin: window.xMin,
      yMin: window.yMin,
      xMax: window.xMax,
      yMax: window.yMax,
    });
  }

  return window;
}

function unsupportedCompressionError(compression: number): ExrError {
  return new ExrError(
    'UNSUPPORTED_WRITE_COMPRESSION',
    `Writer currently supports ${SUPPORTED_WRITE_COMPRESSION_TEXT} compression only.`,
    { compression },
  );
}

function normalizeChannel(
  channel: WriteExrChannelInput,
  partId: number,
  dataWindow: ExrWindow,
): ChannelWriteMeta {
  if (!channel.name) {
    throw new ExrError('INVALID_WRITE_INPUT', 'Channel name must be non-empty.', { partId });
  }

  const pixelType = channel.pixelType;
  if (pixelType !== 0 && pixelType !== 1 && pixelType !== 2) {
    throw new ExrError(
      'INVALID_WRITE_INPUT',
      `Unsupported channel pixel type for ${channel.name}.`,
      {
        partId,
      },
    );
  }

  const xSampling = channel.xSampling ?? 1;
  const ySampling = channel.ySampling ?? 1;
  ensureFiniteInteger(xSampling, `${channel.name}.xSampling`, { partId });
  ensureFiniteInteger(ySampling, `${channel.name}.ySampling`, { partId });

  if (xSampling <= 0 || ySampling <= 0) {
    throw new ExrError('INVALID_WRITE_INPUT', `Sampling must be positive for ${channel.name}.`, {
      partId,
    });
  }

  const pLinear = channel.pLinear ?? 0;
  ensureFiniteInteger(pLinear, `${channel.name}.pLinear`, { partId });

  const sampleOriginX = firstSampleCoordinate(dataWindow.xMin, xSampling);
  const sampleOriginY = firstSampleCoordinate(dataWindow.yMin, ySampling);
  const sampledWidth = countSamplesInRange(dataWindow.xMin, dataWindow.xMax, xSampling);
  const sampledHeight = countSamplesInRange(dataWindow.yMin, dataWindow.yMax, ySampling);
  const expectedLength = sampledWidth * sampledHeight;

  if (!(channel.data instanceof Float32Array)) {
    throw new ExrError(
      'INVALID_WRITE_INPUT',
      `Channel ${channel.name} data must be Float32Array.`,
      {
        partId,
      },
    );
  }

  if (channel.data.length !== expectedLength) {
    throw new ExrError('INVALID_WRITE_INPUT', `Channel ${channel.name} has invalid data length.`, {
      partId,
      expected: expectedLength,
      actual: channel.data.length,
    });
  }

  const bytesPerSample = pixelType === 1 ? 2 : 4;

  return {
    name: channel.name,
    pixelType,
    pLinear,
    xSampling,
    ySampling,
    sampleOriginX,
    sampleOriginY,
    sampledWidth,
    sampledHeight,
    rowByteLength: sampledWidth * bytesPerSample,
    data: channel.data,
  };
}

function normalizeParts(input: WriteExrInput): PartWriteMeta[] {
  if (!input || !Array.isArray(input.parts) || input.parts.length === 0) {
    throw new ExrError('INVALID_WRITE_INPUT', 'writeExr requires at least one part.', {});
  }

  const isMultipart = input.parts.length > 1;

  return input.parts.map((part, index) => {
    if (!part || !Array.isArray(part.channels) || part.channels.length === 0) {
      throw new ExrError('INVALID_WRITE_INPUT', 'Each part must contain at least one channel.', {
        partId: index,
      });
    }

    const compression = part.compression;
    const compressionHandler = getWriteCompressionHandler(compression);
    if (!compressionHandler) {
      throw unsupportedCompressionError(compression);
    }

    const linesPerBlock = compressionHandler.linesPerBlock;
    const dataWindow = ensureWindow(part.dataWindow, 'dataWindow', index);
    const displayWindow = ensureWindow(part.displayWindow ?? dataWindow, 'displayWindow', index);
    const channels = part.channels.map((channel) => normalizeChannel(channel, index, dataWindow));
    const height = dataWindow.yMax - dataWindow.yMin + 1;
    const chunkCount = Math.ceil(height / linesPerBlock);

    const includeNameAttribute = isMultipart || typeof part.name === 'string';
    const includeTypeAttribute = isMultipart || typeof part.type === 'string';
    const attributes = normalizeAttributes(part.attributes, index);

    return {
      id: index,
      compression,
      dataWindow,
      displayWindow,
      name: part.name ?? `part_${index}`,
      type: part.type ?? 'scanlineimage',
      channels,
      linesPerBlock,
      chunkCount,
      includeNameAttribute,
      includeTypeAttribute,
      attributes,
    };
  });
}

function normalizeAttributes(
  attributes: WriteExrPartInput['attributes'],
  partId: number,
): ReadonlyArray<readonly [string, WriteExrAttribute]> {
  if (attributes === undefined) return [];
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new ExrError('INVALID_WRITE_INPUT', 'Part attributes must be an object.', { partId });
  }

  return Object.entries(attributes).map(([name, attribute]) => {
    if (!name || name.includes('\0')) {
      throw new ExrError('INVALID_WRITE_INPUT', 'Attribute names must be non-empty C strings.', {
        partId,
        attribute: name,
      });
    }
    if (RESERVED_ATTRIBUTE_NAMES.has(name)) {
      throw new ExrError('INVALID_WRITE_INPUT', `Attribute ${name} is managed by the EXR writer.`, {
        partId,
        attribute: name,
      });
    }
    validateAttribute(name, attribute, partId);
    return [name, attribute] as const;
  });
}

function validateFiniteAttributeNumber(
  name: string,
  value: number,
  partId: number,
  field = 'value',
): void {
  if (!Number.isFinite(value)) {
    throw new ExrError('INVALID_WRITE_INPUT', `Attribute ${name}.${field} must be finite.`, {
      partId,
      attribute: name,
      field,
    });
  }
}

function validateAttribute(name: string, attribute: WriteExrAttribute, partId: number): void {
  if (!attribute || typeof attribute !== 'object') {
    throw new ExrError('INVALID_WRITE_INPUT', `Attribute ${name} is invalid.`, {
      partId,
      attribute: name,
    });
  }

  if (attribute.type === 'string') {
    if (typeof attribute.value !== 'string') {
      throw new ExrError('INVALID_WRITE_INPUT', `Attribute ${name}.value must be a string.`, {
        partId,
        attribute: name,
      });
    }
    return;
  }
  if (attribute.type === 'int') {
    validateFiniteAttributeNumber(name, attribute.value, partId);
    if (
      !Number.isInteger(attribute.value) ||
      attribute.value < -2147483648 ||
      attribute.value > 2147483647
    ) {
      throw new ExrError('INVALID_WRITE_INPUT', `Attribute ${name}.value must be an int32.`, {
        partId,
        attribute: name,
      });
    }
    return;
  }
  if (attribute.type === 'float') {
    validateFiniteAttributeNumber(name, attribute.value, partId);
    return;
  }
  if (attribute.type === 'chromaticities') {
    if (!attribute.value || typeof attribute.value !== 'object') {
      throw new ExrError(
        'INVALID_WRITE_INPUT',
        `Attribute ${name}.value must contain chromaticities.`,
        { partId, attribute: name },
      );
    }
    for (const field of CHROMATICITY_FIELDS) {
      validateFiniteAttributeNumber(name, attribute.value[field], partId, field);
    }
    return;
  }

  throw new ExrError('INVALID_WRITE_INPUT', `Attribute ${name} has an unsupported type.`, {
    partId,
    attribute: name,
  });
}

function writeAttribute(writer: ByteWriter, name: string, type: string, payload: Uint8Array): void {
  writer.writeCString(name);
  writer.writeCString(type);
  writer.writeInt32(payload.byteLength);
  writer.writeBytes(payload);
}

function writeInt32Payload(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setInt32(i * 4, values[i], true);
  }
  return out;
}

function writeFloat32Payload(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true);
  }
  return out;
}

function writeCompressionPayload(compression: number): Uint8Array {
  return Uint8Array.of(compression & 0xff);
}

function writeStringPayload(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value);
}

function writeCustomAttribute(
  writer: ByteWriter,
  name: string,
  attribute: WriteExrAttribute,
): void {
  if (attribute.type === 'string') {
    writeAttribute(writer, name, attribute.type, writeStringPayload(attribute.value));
    return;
  }
  if (attribute.type === 'int') {
    writeAttribute(writer, name, attribute.type, writeInt32Payload([attribute.value]));
    return;
  }
  if (attribute.type === 'float') {
    writeAttribute(writer, name, attribute.type, writeFloat32Payload([attribute.value]));
    return;
  }

  const value: ExrChromaticities = attribute.value;
  writeAttribute(
    writer,
    name,
    attribute.type,
    writeFloat32Payload([
      value.redX,
      value.redY,
      value.greenX,
      value.greenY,
      value.blueX,
      value.blueY,
      value.whiteX,
      value.whiteY,
    ]),
  );
}

function writeChannelsPayload(channels: ChannelWriteMeta[]): Uint8Array {
  const writer = new ByteWriter();

  for (const channel of channels) {
    writer.writeCString(channel.name);
    writer.writeInt32(channel.pixelType);
    writer.writeUint8(channel.pLinear);
    writer.writeUint8(0);
    writer.writeUint8(0);
    writer.writeUint8(0);
    writer.writeInt32(channel.xSampling);
    writer.writeInt32(channel.ySampling);
  }

  writer.writeUint8(0);
  return writer.toUint8Array();
}

function writePartHeader(writer: ByteWriter, part: PartWriteMeta): void {
  writeAttribute(writer, 'channels', 'chlist', writeChannelsPayload(part.channels));
  writeAttribute(writer, 'compression', 'compression', writeCompressionPayload(part.compression));
  writeAttribute(
    writer,
    'dataWindow',
    'box2i',
    writeInt32Payload([
      part.dataWindow.xMin,
      part.dataWindow.yMin,
      part.dataWindow.xMax,
      part.dataWindow.yMax,
    ]),
  );
  writeAttribute(
    writer,
    'displayWindow',
    'box2i',
    writeInt32Payload([
      part.displayWindow.xMin,
      part.displayWindow.yMin,
      part.displayWindow.xMax,
      part.displayWindow.yMax,
    ]),
  );
  writeAttribute(writer, 'lineOrder', 'lineOrder', Uint8Array.of(0));

  if (part.includeNameAttribute) {
    writeAttribute(writer, 'name', 'string', writeStringPayload(part.name));
  }

  if (part.includeTypeAttribute) {
    writeAttribute(writer, 'type', 'string', writeStringPayload(part.type));
  }

  for (const [name, attribute] of part.attributes) {
    writeCustomAttribute(writer, name, attribute);
  }

  writer.writeUint8(0);
}

function getRawChunkSize(part: PartWriteMeta, chunkY: number, linesInChunk: number): number {
  let expected = 0;

  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;
    for (const channel of part.channels) {
      if (!isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
        continue;
      }
      expected += channel.rowByteLength;
    }
  }

  return expected;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function buildRawChunk(part: PartWriteMeta, chunkY: number): Uint8Array {
  const linesInChunk = Math.max(0, Math.min(part.linesPerBlock, part.dataWindow.yMax - chunkY + 1));
  const raw = new Uint8Array(getRawChunkSize(part, chunkY, linesInChunk));
  const view = new DataView(raw.buffer);
  let ptr = 0;

  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;

    for (const channel of part.channels) {
      if (!isSampledCoordinate(y, channel.sampleOriginY, channel.ySampling)) {
        continue;
      }

      const sampledRow = Math.floor((y - channel.sampleOriginY) / channel.ySampling);
      const rowOffset = sampledRow * channel.sampledWidth;

      for (let x = 0; x < channel.sampledWidth; x++) {
        const value = channel.data[rowOffset + x];
        if (channel.pixelType === 1) {
          view.setUint16(ptr, float32ToFloat16(value), true);
          ptr += 2;
          continue;
        }

        if (channel.pixelType === 2) {
          view.setFloat32(ptr, value, true);
          ptr += 4;
          continue;
        }

        const quantized = Math.round(clamp01(value) * UINT32_MAX) >>> 0;
        view.setUint32(ptr, quantized, true);
        ptr += 4;
      }
    }
  }

  return raw;
}

function encodeChunk(
  raw: Uint8Array,
  part: PartWriteMeta,
  chunkY: number,
  chunkIndex: number,
): Uint8Array {
  const compressionHandler = getWriteCompressionHandler(part.compression);
  if (!compressionHandler) {
    throw unsupportedCompressionError(part.compression);
  }

  try {
    return compressionHandler.encodeChunk(raw, part, chunkY);
  } catch {
    throw new ExrError('ENCODING_FAILED', 'Failed to compress EXR chunk payload.', {
      partId: part.id,
      chunkIndex,
      compression: part.compression,
    });
  }
}

export function writeExr(input: WriteExrInput, options: WriteExrOptions = {}): Uint8Array {
  const onEvent = options.onEvent;
  const t0 = nowMs();
  const parts = normalizeParts(input);
  const isMultipart = parts.length > 1;

  emit(onEvent, {
    phase: 'encode',
    level: 'info',
    code: 'encode.setup',
    message: 'Writer setup complete.',
    metrics: {
      parts: parts.length,
      multipart: isMultipart ? 1 : 0,
    },
  });

  const writer = new ByteWriter();

  writer.writeUint32(EXR_MAGIC);
  const versionField = EXR_VERSION | ((isMultipart ? EXR_MULTIPART_FLAG : 0) << 8);
  writer.writeUint32(versionField);

  for (const part of parts) {
    writePartHeader(writer, part);
  }

  if (isMultipart) {
    writer.writeUint8(0);
  }

  const offsetSlots = parts.map((part) => {
    const offsets: number[] = [];
    for (let chunk = 0; chunk < part.chunkCount; chunk++) {
      offsets.push(writer.length);
      writer.writeUint32(0);
      writer.writeUint32(0);
    }
    return offsets;
  });

  for (const part of parts) {
    const tPart = nowMs();

    for (let chunkIndex = 0; chunkIndex < part.chunkCount; chunkIndex++) {
      const chunkOffset = writer.length;
      writer.patchUint64LE(offsetSlots[part.id][chunkIndex], chunkOffset);

      const chunkY = part.dataWindow.yMin + chunkIndex * part.linesPerBlock;
      const raw = buildRawChunk(part, chunkY);
      const encoded = encodeChunk(raw, part, chunkY, chunkIndex);

      if (isMultipart) {
        writer.writeInt32(part.id);
      }

      writer.writeInt32(chunkY);
      writer.writeInt32(encoded.byteLength);
      writer.writeBytes(encoded);
    }

    emit(onEvent, {
      phase: 'encode',
      level: 'info',
      code: 'encode.part.complete',
      message: `Encoded part ${part.id}.`,
      metrics: {
        partId: part.id,
        chunks: part.chunkCount,
        compression: part.compression,
        ms: (nowMs() - tPart).toFixed(3),
      },
    });
  }

  const out = writer.toUint8Array();

  emit(onEvent, {
    phase: 'encode',
    level: 'info',
    code: 'encode.complete',
    message: 'EXR encode complete.',
    metrics: {
      parts: parts.length,
      bytes: out.byteLength,
      totalMs: (nowMs() - t0).toFixed(3),
    },
  });

  return out;
}
