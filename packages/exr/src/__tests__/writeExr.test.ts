import { describe, expect, it } from 'vitest';
import { decodeExrPart, ExrError, parseExrStructure, writeExr } from '../index';

function expectCloseArray(actual: Float32Array, expected: number[], epsilon = 1e-6) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], Math.max(0, Math.floor(-Math.log10(epsilon))));
  }
}

describe('writeExr', () => {
  it('roundtrips single-part data across phase-1 compressions', () => {
    for (const compression of [0, 1, 2, 3]) {
      const encoded = writeExr({
        parts: [
          {
            compression,
            dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
            channels: [
              {
                name: 'R',
                pixelType: 2,
                data: new Float32Array([0.25, 1.25, 10.25, 11.25]),
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
      expectCloseArray(decoded.channels.R.data, [0.25, 1.25, 10.25, 11.25]);
      expectCloseArray(decoded.channels.H.data, [0, 1, 1, 0]);
      expectCloseArray(decoded.channels.U.data, [1, 0, 0, 1]);
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
            compression: 4,
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
            compression: 4,
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
