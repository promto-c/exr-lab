import { describe, expect, it } from 'vitest';
import { decodeExrPart, ExrError, parseExrStructure, writeExr } from '../index';

function expectCloseArray(actual: Float32Array, expected: number[], epsilon = 1e-6) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], Math.max(0, Math.floor(-Math.log10(epsilon))));
  }
}

function expectRelativeClose(
  actual: number,
  expected: number,
  relativeTolerance: number,
  absoluteTolerance = 2e-2,
) {
  const delta = Math.abs(actual - expected);
  const allowed = Math.max(absoluteTolerance, Math.abs(expected) * relativeTolerance);
  expect(delta).toBeLessThanOrEqual(allowed);
}

function float32ToUint32Bits(value: number): number {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, true);
  return scratch.getUint32(0, true);
}

function uint32BitsToFloat32(value: number): number {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setUint32(0, value >>> 0, true);
  return scratch.getFloat32(0, true);
}

function floatBitsToFloat24Bits(bits: number): number {
  const sign = bits & 0x80000000;
  const exponent = bits & 0x7f800000;
  const mantissa = bits & 0x007fffff;

  let reduced = 0;
  if (exponent === 0x7f800000) {
    if (mantissa !== 0) {
      const shrunkMantissa = mantissa >>> 8;
      reduced = (exponent >>> 8) | shrunkMantissa | (shrunkMantissa === 0 ? 1 : 0);
    } else {
      reduced = exponent >>> 8;
    }
  } else {
    reduced = ((exponent | mantissa) + (mantissa & 0x00000080)) >>> 8;
    if (reduced >= 0x7f8000) {
      reduced = (exponent | mantissa) >>> 8;
    }
  }

  return ((sign >>> 8) | reduced) >>> 0;
}

function pxr24QuantizeFloat(value: number): number {
  const bits = float32ToUint32Bits(value);
  const pxr24 = floatBitsToFloat24Bits(bits);
  return uint32BitsToFloat32((pxr24 << 8) >>> 0);
}

function readFirstChunkDataSize(encoded: Uint8Array, headerEndOffset: number): number {
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const firstOffsetLow = view.getUint32(headerEndOffset, true);
  const firstOffsetHigh = view.getUint32(headerEndOffset + 4, true);
  const chunkOffset = firstOffsetHigh * 4294967296 + firstOffsetLow;
  return view.getInt32(chunkOffset + 4, true);
}

describe('writeExr', () => {
  it('roundtrips typed custom attributes', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 0,
          dataWindow: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
          channels: [{ name: 'R', pixelType: 2, data: new Float32Array([0.18]) }],
          attributes: {
            ocioColorSpace: { type: 'string', value: 'ACES2065-1' },
            acesImageContainerFlag: { type: 'int', value: 1 },
            whiteLuminance: { type: 'float', value: 100 },
            chromaticities: {
              type: 'chromaticities',
              value: {
                redX: 0.7347,
                redY: 0.2653,
                greenX: 0,
                greenY: 1,
                blueX: 0.0001,
                blueY: -0.077,
                whiteX: 0.32168,
                whiteY: 0.33767,
              },
            },
          },
        },
      ],
    });

    expect(parseExrStructure(encoded).parts[0].attributes).toMatchObject({
      ocioColorSpace: 'ACES2065-1',
      acesImageContainerFlag: 1,
      whiteLuminance: 100,
      chromaticities: {
        redX: expect.closeTo(0.7347, 5),
        redY: expect.closeTo(0.2653, 5),
        greenX: 0,
        greenY: 1,
        blueX: expect.closeTo(0.0001, 5),
        blueY: expect.closeTo(-0.077, 5),
        whiteX: expect.closeTo(0.32168, 5),
        whiteY: expect.closeTo(0.33767, 5),
      },
    });
  });

  it('rejects custom attributes that collide with writer-managed headers', () => {
    expect(() =>
      writeExr({
        parts: [
          {
            compression: 0,
            dataWindow: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
            channels: [{ name: 'R', pixelType: 2, data: new Float32Array([0.18]) }],
            attributes: {
              channels: { type: 'string', value: 'override' },
            },
          },
        ],
      }),
    ).toThrow('Attribute channels is managed by the EXR writer.');
  });

  it('roundtrips single-part data across supported writer compressions', () => {
    const sourceR = [0.25, 1.25, 10.25, 11.25];

    for (const compression of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const encoded = writeExr({
        parts: [
          {
            compression,
            dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
            channels: [
              {
                name: 'R',
                pixelType: 2,
                data: new Float32Array(sourceR),
              },
              {
                name: 'H',
                pixelType: 1,
                data: new Float32Array([0, 1, 1, 0]),
              },
              {
                name: 'U',
                pixelType: 0,
                data: new Float32Array([1, 0, 0, 1]),
              },
            ],
          },
        ],
      });

      const structure = parseExrStructure(encoded);
      expect(structure.parts).toHaveLength(1);
      expect(structure.parts[0].compression).toBe(compression);

      const decoded = decodeExrPart(encoded, structure, { partId: 0 });
      expectCloseArray(
        decoded.channels.R.data,
        compression === 5 ? sourceR.map((value) => pxr24QuantizeFloat(value)) : sourceR,
      );
      expectCloseArray(decoded.channels.H.data, [0, 1, 1, 0]);
      expectCloseArray(decoded.channels.U.data, [1, 0, 0, 1]);
    }
  });

  it('encodes compressed PIZ chunks when payload is reducible', () => {
    const source = new Float32Array(16 * 16).fill(0.5);
    const encoded = writeExr({
      parts: [
        {
          compression: 4,
          dataWindow: { xMin: 0, yMin: 0, xMax: 15, yMax: 15 },
          channels: [{ name: 'H', pixelType: 1, data: source }],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const dataSize = readFirstChunkDataSize(encoded, structure.headerEndOffset);
    expect(dataSize).toBeLessThan(source.length * 2);

    const decoded = decodeExrPart(encoded, structure, { partId: 0 });
    expectCloseArray(decoded.channels.H.data, Array.from(source));
  });

  it('roundtrips large PIZ chunks without Huffman bit-count failures', () => {
    const width = 256;
    const height = 64;
    const source = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        source[y * width + x] = ((x * 13 + y * 7) % 97) / 96;
      }
    }

    const encoded = writeExr({
      parts: [
        {
          compression: 4,
          dataWindow: { xMin: 0, yMin: 0, xMax: width - 1, yMax: height - 1 },
          channels: [{ name: 'H', pixelType: 1, data: source }],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const decoded = decodeExrPart(encoded, structure, { partId: 0 });

    expect(decoded.channels.H.data.length).toBe(source.length);
    for (let i = 0; i < source.length; i += 997) {
      expect(decoded.channels.H.data[i]).toBeCloseTo(source[i], 3);
    }
  });

  it('encodes compressed B44 chunks for HALF channels', () => {
    const source = new Float32Array(16).fill(1);
    const encoded = writeExr({
      parts: [
        {
          compression: 6,
          dataWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 3 },
          channels: [{ name: 'H', pixelType: 1, data: source }],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const dataSize = readFirstChunkDataSize(encoded, structure.headerEndOffset);
    expect(dataSize).toBeLessThan(32);

    const decoded = decodeExrPart(encoded, structure, { partId: 0 });
    expectCloseArray(decoded.channels.H.data, Array.from(source));
  });

  it('encodes compressed B44A flat chunks for HALF channels', () => {
    const source = new Float32Array(16).fill(0.5);
    const encoded = writeExr({
      parts: [
        {
          compression: 7,
          dataWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 3 },
          channels: [{ name: 'H', pixelType: 1, data: source }],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const dataSize = readFirstChunkDataSize(encoded, structure.headerEndOffset);
    expect(dataSize).toBeLessThan(32);

    const decoded = decodeExrPart(encoded, structure, { partId: 0 });
    expectCloseArray(decoded.channels.H.data, Array.from(source));
  });

  it('encodes B44 pLinear HALF blocks through linear-domain mapping', () => {
    const source = [1, 2, 4, 8, 16, 24, 32, 40, 3, 6, 12, 18, 28, 36, 48, 64];

    const encoded = writeExr({
      parts: [
        {
          compression: 6,
          dataWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 3 },
          channels: [
            {
              name: 'H',
              pixelType: 1,
              pLinear: 1,
              data: new Float32Array(source),
            },
          ],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const decoded = decodeExrPart(encoded, structure, { partId: 0 });

    expect(decoded.channels.H.data.length).toBe(source.length);
    for (let i = 0; i < source.length; i++) {
      expectRelativeClose(decoded.channels.H.data[i], source[i], 0.55);
    }
  });

  it('preserves sampled channel metadata and compact sampled layout', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 0,
          dataWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 3 },
          channels: [
            {
              name: 'S',
              pixelType: 2,
              xSampling: 2,
              ySampling: 2,
              data: new Float32Array([0, 2, 20, 22]),
            },
          ],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const decoded = decodeExrPart(encoded, structure, { partId: 0 });
    expect(decoded.channels.S.xSampling).toBe(2);
    expect(decoded.channels.S.ySampling).toBe(2);
    expect(decoded.channels.S.sampledWidth).toBe(2);
    expect(decoded.channels.S.sampledHeight).toBe(2);
    expectCloseArray(decoded.channels.S.data, [0, 2, 20, 22]);
  });

  it('writes multipart files with layered channel names', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 3,
          dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
          channels: [
            { name: 'beauty.R', pixelType: 2, data: new Float32Array([0, 1, 2, 3]) },
            { name: 'beauty.G', pixelType: 2, data: new Float32Array([4, 5, 6, 7]) },
            { name: 'beauty.B', pixelType: 2, data: new Float32Array([8, 9, 10, 11]) },
          ],
        },
        {
          compression: 1,
          dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
          channels: [{ name: 'depth.Z', pixelType: 2, data: new Float32Array([1, 2, 3, 4]) }],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    expect(structure.isMultipart).toBe(true);
    expect(structure.parts).toHaveLength(2);

    const beauty = decodeExrPart(encoded, structure, { partId: 0 });
    const depth = decodeExrPart(encoded, structure, { partId: 1 });

    expectCloseArray(beauty.channels['beauty.R'].data, [0, 1, 2, 3]);
    expectCloseArray(beauty.channels['beauty.G'].data, [4, 5, 6, 7]);
    expectCloseArray(beauty.channels['beauty.B'].data, [8, 9, 10, 11]);
    expectCloseArray(depth.channels['depth.Z'].data, [1, 2, 3, 4]);
  });

  it('throws typed errors for unsupported write compression', () => {
    expect(() =>
      writeExr({
        parts: [
          {
            compression: 8,
            dataWindow: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
            channels: [{ name: 'R', pixelType: 2, data: new Float32Array([1]) }],
          },
        ],
      }),
    ).toThrowError(ExrError);

    try {
      writeExr({
        parts: [
          {
            compression: 8,
            dataWindow: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
            channels: [{ name: 'R', pixelType: 2, data: new Float32Array([1]) }],
          },
        ],
      });
    } catch (error) {
      expect((error as ExrError).code).toBe('UNSUPPORTED_WRITE_COMPRESSION');
    }
  });

  it('throws typed errors for invalid channel sample lengths', () => {
    expect(() =>
      writeExr({
        parts: [
          {
            compression: 0,
            dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
            channels: [{ name: 'R', pixelType: 2, data: new Float32Array([1, 2, 3]) }],
          },
        ],
      }),
    ).toThrowError(ExrError);

    try {
      writeExr({
        parts: [
          {
            compression: 0,
            dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
            channels: [{ name: 'R', pixelType: 2, data: new Float32Array([1, 2, 3]) }],
          },
        ],
      });
    } catch (error) {
      expect((error as ExrError).code).toBe('INVALID_WRITE_INPUT');
    }
  });

  it('emits structured encode events', () => {
    const codes: string[] = [];

    writeExr(
      {
        parts: [
          {
            compression: 0,
            dataWindow: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
            channels: [{ name: 'R', pixelType: 2, data: new Float32Array([0.5]) }],
          },
        ],
      },
      {
        onEvent: (event) => codes.push(event.code),
      },
    );

    expect(codes).toContain('encode.setup');
    expect(codes).toContain('encode.part.complete');
    expect(codes).toContain('encode.complete');
  });
});
