import { ExrError } from './errors';
import { ExrEvent, ExrEventCallback } from './events';
import { COMPRESSION_NAMES, EXR_MAGIC } from './constants';
import { ExrChannel, ExrPart, ExrStructure, ParseExrOptions } from './types';

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

class BinaryReader {
  private readonly view: DataView;
  public offset = 0;

  constructor(private readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  get byteLength() {
    return this.view.byteLength;
  }

  public ensureAvailable(count: number, code: string, context: string) {
    if (count < 0 || this.offset + count > this.view.byteLength) {
      throw new ExrError('TRUNCATED_FILE', `Unexpected EOF while reading ${context}.`, {
        code,
        offset: this.offset,
        requested: count,
        size: this.view.byteLength,
      });
    }
  }

  public peekUint8(): number {
    this.ensureAvailable(1, 'peek_u8', 'byte');
    return this.view.getUint8(this.offset);
  }

  public readUint8(): number {
    this.ensureAvailable(1, 'u8', 'byte');
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  public readInt32(): number {
    this.ensureAvailable(4, 'i32', 'int32');
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  public readUint32(): number {
    this.ensureAvailable(4, 'u32', 'uint32');
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  public readCString(context: string): string {
    let value = '';
    while (this.offset < this.view.byteLength) {
      const ch = this.readUint8();
      if (ch === 0) return value;
      value += String.fromCharCode(ch);
    }

    throw new ExrError('TRUNCATED_FILE', `Unterminated string while reading ${context}.`, {
      offset: this.offset,
    });
  }

  public readCStringWithin(limit: number, context: string): string {
    if (limit < this.offset || limit > this.view.byteLength) {
      throw new ExrError('MALFORMED_HEADER', `Invalid bounded read while parsing ${context}.`, {
        offset: this.offset,
        limit,
      });
    }

    let value = '';
    while (this.offset < limit) {
      const ch = this.readUint8();
      if (ch === 0) return value;
      value += String.fromCharCode(ch);
    }

    throw new ExrError('MALFORMED_HEADER', `Unterminated string while reading ${context}.`, {
      offset: this.offset,
      limit,
    });
  }

  public skip(count: number, context: string) {
    this.ensureAvailable(count, 'skip', context);
    this.offset += count;
  }
}

function emit(onEvent: ExrEventCallback | undefined, event: ExrEvent) {
  onEvent?.(event);
}

function ensureExactAttributeSize(name: string, type: string, size: number, expected: number) {
  if (size !== expected) {
    throw new ExrError('MALFORMED_HEADER', `Invalid ${type} attribute size for ${name}.`, {
      attribute: name,
      expected,
      actual: size,
    });
  }
}

function parsePartHeader(reader: BinaryReader, index: number): ExrPart | null {
  if (reader.peekUint8() === 0) {
    return null;
  }

  const attributes: Record<string, unknown> = {};
  const channels: ExrChannel[] = [];

  while (reader.offset < reader.byteLength) {
    const name = reader.readCString('attribute name');
    if (name === '') {
      break;
    }

    const type = reader.readCString(`attribute type for ${name}`);
    const size = reader.readInt32();

    if (size < 0) {
      throw new ExrError('MALFORMED_HEADER', `Negative attribute size for ${name}.`, {
        attribute: name,
        size,
      });
    }

    const valueStart = reader.offset;
    reader.ensureAvailable(size, 'attribute_size', `attribute payload for ${name}`);

    let value: unknown;

    if (type === 'chlist') {
      const channelEnd = valueStart + size;
      let sawChannelListTerminator = false;

      while (reader.offset < channelEnd) {
        const channelName = reader.readCStringWithin(channelEnd, 'channel name');
        if (channelName === '') {
          sawChannelListTerminator = true;
          break;
        }

        if (reader.offset + 16 > channelEnd) {
          throw new ExrError('MALFORMED_HEADER', `Truncated channel record for ${channelName}.`, {
            attribute: name,
            channel: channelName,
            offset: reader.offset,
            channelEnd,
          });
        }

        const pixelType = reader.readInt32();
        const pLinear = reader.readUint8();
        reader.skip(3, 'channel reserved bytes');
        const xSampling = reader.readInt32();
        const ySampling = reader.readInt32();

        channels.push({
          name: channelName,
          pixelType,
          pLinear,
          xSampling,
          ySampling,
        });
      }

      if (!sawChannelListTerminator) {
        throw new ExrError('MALFORMED_HEADER', 'Channel list payload is missing terminator.', {
          attribute: name,
          size,
        });
      }

      if (reader.offset !== channelEnd) {
        throw new ExrError('MALFORMED_HEADER', 'Channel list payload had trailing bytes.', {
          attribute: name,
          offset: reader.offset,
          expectedEnd: channelEnd,
        });
      }

      value = `(${channels.length} channels)`;
    } else if (type === 'compression') {
      ensureExactAttributeSize(name, type, size, 1);
      value = reader.readUint8();
    } else if (type === 'box2i') {
      ensureExactAttributeSize(name, type, size, 16);
      value = {
        xMin: reader.readInt32(),
        yMin: reader.readInt32(),
        xMax: reader.readInt32(),
        yMax: reader.readInt32(),
      };
    } else if (type === 'string') {
      let stringValue = '';
      for (let i = 0; i < size; i++) {
        const charCode = reader.readUint8();
        if (charCode === 0) break;
        stringValue += String.fromCharCode(charCode);
      }
      value = stringValue;
    } else if (type === 'int') {
      ensureExactAttributeSize(name, type, size, 4);
      value = reader.readInt32();
    } else if (type === 'float') {
      ensureExactAttributeSize(name, type, size, 4);
      const asInt = reader.readUint32();
      const scratch = new DataView(new ArrayBuffer(4));
      scratch.setUint32(0, asInt, true);
      value = scratch.getFloat32(0, true);
    } else {
      reader.skip(size, `unknown attribute ${name}`);
      value = `<${type} data>`;
    }

    // Honor declared payload size even when parsing known attributes.
    reader.offset = valueStart + size;
    attributes[name] = value;
  }

  return {
    id: index,
    attributes,
    channels,
    dataWindow: attributes.dataWindow as ExrPart['dataWindow'],
    displayWindow: attributes.displayWindow as ExrPart['displayWindow'],
    compression: attributes.compression as number | undefined,
    type: attributes.type as string | undefined,
  };
}

export function parseExrStructure(buffer: ArrayBuffer, options: ParseExrOptions = {}): ExrStructure {
  const onEvent = options.onEvent;
  const t0 = nowMs();

  if (buffer.byteLength < 8) {
    throw new ExrError('BUFFER_TOO_SMALL', 'Buffer is too small to be an EXR file.', {
      size: buffer.byteLength,
    });
  }

  const reader = new BinaryReader(buffer);

  const tMagic = nowMs();
  const magic = reader.readUint32();
  if (magic !== EXR_MAGIC) {
    emit(onEvent, {
      phase: 'parse',
      level: 'error',
      code: 'parse.magic.invalid',
      message: 'Invalid EXR magic number.',
      metrics: {
        expected: `0x${EXR_MAGIC.toString(16)}`,
        actual: `0x${magic.toString(16)}`,
      },
    });
    throw new ExrError('INVALID_MAGIC', 'Invalid EXR magic number.', {
      expected: EXR_MAGIC,
      actual: magic,
    });
  }

  emit(onEvent, {
    phase: 'parse',
    level: 'info',
    code: 'parse.magic.ok',
    message: 'Parsed EXR magic number.',
    metrics: {
      ms: (nowMs() - tMagic).toFixed(3),
      magic: `0x${EXR_MAGIC.toString(16)}`,
    },
  });

  const tVersion = nowMs();
  const versionField = reader.readUint32();
  const version = versionField & 0xff;
  const flags = versionField >> 8;
  const isMultipart = (flags & 0x10) !== 0;

  emit(onEvent, {
    phase: 'parse',
    level: 'info',
    code: 'parse.version.ok',
    message: 'Parsed EXR version and flags.',
    metrics: {
      ms: (nowMs() - tVersion).toFixed(3),
      version,
      flags,
      multipart: isMultipart ? 1 : 0,
    },
  });

  const parts: ExrPart[] = [];
  let partIndex = 0;

  while (reader.offset < reader.byteLength) {
    const tHeader = nowMs();
    const part = parsePartHeader(reader, partIndex);

    if (!part) {
      if (isMultipart) {
        reader.skip(1, 'multipart header terminator');
      }
      break;
    }

    parts.push(part);

    emit(onEvent, {
      phase: 'parse',
      level: 'info',
      code: 'parse.part.ok',
      message: `Parsed part ${part.id} header.`,
      metrics: {
        ms: (nowMs() - tHeader).toFixed(3),
        partId: part.id,
        channels: part.channels.length,
        compression: COMPRESSION_NAMES[part.compression ?? -1] || 'UNKNOWN',
      },
    });

    partIndex += 1;

    if (!isMultipart) {
      break;
    }

    if (reader.offset >= reader.byteLength) {
      throw new ExrError('TRUNCATED_FILE', 'Unexpected EOF while reading multipart headers.', {
        offset: reader.offset,
      });
    }

    if (reader.peekUint8() === 0) {
      reader.skip(1, 'multipart headers terminator');
      break;
    }
  }

  if (parts.length === 0) {
    throw new ExrError('MALFORMED_HEADER', 'No EXR headers were parsed.', {
      offset: reader.offset,
    });
  }

  const structure: ExrStructure = {
    magic,
    version,
    flags,
    isMultipart,
    parts,
    headerEndOffset: reader.offset,
  };

  emit(onEvent, {
    phase: 'parse',
    level: 'info',
    code: 'parse.complete',
    message: 'EXR structure parsed.',
    metrics: {
      ms: (nowMs() - t0).toFixed(3),
      parts: parts.length,
      headerEndOffset: structure.headerEndOffset,
    },
  });

  return structure;
}
