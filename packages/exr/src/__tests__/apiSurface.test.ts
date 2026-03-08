import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeExrPart, parseExr, parseExrStructure, readExr, writeExr } from '../index';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const output = new Uint8Array(buffer.byteLength);
  output.set(buffer);
  return output.buffer;
}

describe('public API surface', () => {
  it('supports parseExr alias and decodeExrPart', () => {
    const fixturePath = resolve(__dirname, 'fixtures', 'stripes.piz.exr');
    const input = toArrayBuffer(readFileSync(fixturePath));

    const parsedByAlias = parseExr(input);
    const parsedByStructureFn = parseExrStructure(input);

    expect(parsedByAlias.parts.length).toBe(parsedByStructureFn.parts.length);

    const decoded = decodeExrPart(input, parsedByAlias, { partId: parsedByAlias.parts[0].id });
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  });

  it('provides readExr convenience API', () => {
    const fixturePath = resolve(__dirname, 'fixtures', 'stripes.piz.exr');
    const input = toArrayBuffer(readFileSync(fixturePath));

    const result = readExr(input);
    expect(result.structure.parts.length).toBeGreaterThan(0);
    expect(result.part.width).toBeGreaterThan(0);
    expect(result.part.height).toBeGreaterThan(0);
  });

  it('provides writeExr convenience API', () => {
    const encoded = writeExr({
      parts: [
        {
          compression: 0,
          dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
          channels: [{ name: 'R', pixelType: 2, data: new Float32Array([0, 1, 2, 3]) }],
        },
      ],
    });

    const structure = parseExrStructure(encoded);
    const decoded = decodeExrPart(encoded, structure, { partId: 0 });
    expect(Array.from(decoded.channels.R.data)).toEqual([0, 1, 2, 3]);
  });
});
