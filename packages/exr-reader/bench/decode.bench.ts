import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bench, describe } from 'vitest';
import { decodeExrPart, parseExr } from '../src';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const output = new Uint8Array(buffer.byteLength);
  output.set(buffer);
  return output.buffer;
}

function loadFixture(name: string): ArrayBuffer {
  return toArrayBuffer(readFileSync(resolve(__dirname, '../src/__tests__/fixtures', name)));
}

describe('exr decode benchmarks', () => {
  const piz = loadFixture('stripes.piz.exr');
  const dwaa = loadFixture('comp_dwaa_v2.exr');
  const dwab = loadFixture('comp_dwab_v2.exr');

  bench('parse + decode PIZ', () => {
    const structure = parseExr(piz);
    decodeExrPart(piz, structure, { partId: structure.parts[0].id });
  });

  bench('parse + decode DWAA', () => {
    const structure = parseExr(dwaa);
    decodeExrPart(dwaa, structure, { partId: structure.parts[0].id });
  });

  bench('parse + decode DWAB', () => {
    const structure = parseExr(dwab);
    decodeExrPart(dwab, structure, { partId: structure.parts[0].id });
  });
});
