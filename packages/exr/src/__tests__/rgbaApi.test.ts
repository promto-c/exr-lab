import { describe, expect, it } from 'vitest';
import {
  decodeExrRgba,
  encodeExrRgba,
  ExrError,
  inspectExrImage,
  readExr,
  writeExr,
} from '../index';
import { decodeExrRgbaWithWorkers } from '../browser';

function expectExrError(action: () => unknown, code: ExrError['code']): void {
  expect(action).toThrowError(ExrError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExrError);
    expect((error as ExrError).code).toBe(code);
  }
}

describe('RGBA convenience API', () => {
  it('inspects the preferred image part without decoding pixels', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 0,
          dataWindow: { xMin: 10, yMin: -2, xMax: 11, yMax: -2 },
          displayWindow: { xMin: 0, yMin: 0, xMax: 15, yMax: 7 },
          channels: [{ name: 'R', pixelType: 2, data: new Float32Array([1, 2]) }],
        },
      ],
    });

    const info = inspectExrImage(encoded);
    expect(info.partId).toBe(0);
    expect(info.width).toBe(2);
    expect(info.height).toBe(1);
    expect(info.dataWindow).toEqual({ xMin: 10, yMin: -2, xMax: 11, yMax: -2 });
    expect(info.displayWindow).toEqual({ xMin: 0, yMin: 0, xMax: 15, yMax: 7 });
  });

  it('resolves layered RGB aliases and luminance fallback into straight RGBA', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 0,
          dataWindow: { xMin: -1, yMin: 5, xMax: 0, yMax: 5 },
          channels: [
            { name: 'beauty.R', pixelType: 2, data: new Float32Array([0.25, 2]) },
            { name: 'beauty.Y', pixelType: 2, data: new Float32Array([0.5, 0.75]) },
            { name: 'beauty.A', pixelType: 2, data: new Float32Array([-0.25, 0.5]) },
          ],
        },
      ],
    });

    const decoded = decodeExrRgba(encoded);
    expect(decoded.dataWindow).toEqual({ xMin: -1, yMin: 5, xMax: 0, yMax: 5 });
    expect(Array.from(decoded.rgba)).toEqual([0.25, 0.5, 0.5, 0, 2, 0.75, 0.75, 0.5]);
  });

  it('expands sampled channels before RGBA assembly', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 0,
          dataWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 0 },
          channels: [
            {
              name: 'R',
              pixelType: 2,
              xSampling: 2,
              data: new Float32Array([1, 3]),
            },
          ],
        },
      ],
    });

    const decoded = decodeExrRgba(encoded);
    expect(Array.from(decoded.rgba)).toEqual([1, 1, 1, 1, 3, 3, 3, 1, 3, 3, 3, 1, 3, 3, 3, 1]);
  });

  it('encodes RGBA, named channels, metadata, and non-zero data windows', () => {
    const encoded = encodeExrRgba(
      {
        width: 2,
        height: 1,
        rgba: new Float32Array([-0.5, 0.25, 2, 1, 4, 0.5, 1.5, 0.75]),
        dataWindow: { xMin: 10, yMin: 20, xMax: 11, yMax: 20 },
        displayWindow: { xMin: 0, yMin: 0, xMax: 31, yMax: 31 },
        namedChannels: [{ name: 'depth.Z', data: new Float32Array([-0.25, 65536.5]) }],
      },
      {
        precision: 'half',
        includeAlpha: true,
        attributes: { ocioColorSpace: { type: 'string', value: 'ACEScg' } },
      },
    );

    const decoded = readExr(encoded);
    expect(decoded.structure.parts[0].dataWindow).toEqual({
      xMin: 10,
      yMin: 20,
      xMax: 11,
      yMax: 20,
    });
    expect(decoded.structure.parts[0].displayWindow).toEqual({
      xMin: 0,
      yMin: 0,
      xMax: 31,
      yMax: 31,
    });
    expect(decoded.structure.parts[0].attributes.ocioColorSpace).toBe('ACEScg');
    expect(decoded.structure.parts[0].channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'R', pixelType: 1 }),
        expect.objectContaining({ name: 'A', pixelType: 1 }),
        expect.objectContaining({ name: 'depth.Z', pixelType: 2 }),
      ]),
    );
    expect(Array.from(decoded.part.channels['depth.Z'].data)).toEqual([-0.25, 65536.5]);
  });

  it('rejects invalid RGBA and named-channel inputs with typed errors', () => {
    expectExrError(
      () =>
        encodeExrRgba(
          { width: 1, height: 1, rgba: new Float32Array(3) },
          { precision: 'half', includeAlpha: false },
        ),
      'INVALID_WRITE_INPUT',
    );

    expectExrError(
      () =>
        encodeExrRgba(
          {
            width: 1,
            height: 1,
            rgba: new Float32Array([0, 0, 0, 1]),
            namedChannels: [{ name: 'R', data: new Float32Array([1]) }],
          },
          { precision: 'half', includeAlpha: false },
        ),
      'INVALID_WRITE_INPUT',
    );
  });

  it('provides worker-backed RGBA decode with the same semantic output', async () => {
    const encoded = encodeExrRgba(
      {
        width: 1,
        height: 1,
        rgba: new Float32Array([-0.5, 0.25, 2, 0.75]),
      },
      { precision: 'float', includeAlpha: true, compression: 0 },
    );

    const decoded = await decodeExrRgbaWithWorkers(encoded);
    expect(Array.from(decoded.rgba)).toEqual([-0.5, 0.25, 2, 0.75]);
  });
});
