import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXR_EVENT_CODES, parseExr, readExr } from '../index';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const output = new Uint8Array(buffer.byteLength);
  output.set(buffer);
  return output.buffer;
}

describe('diagnostics contract', () => {
  it('exposes a stable event code catalog', () => {
    expect(EXR_EVENT_CODES).toContain('parse.complete');
    expect(EXR_EVENT_CODES).toContain('decode.complete');
  });

  it('emits only documented event codes during parse/decode', () => {
    const codes = new Set<string>();
    const fixturePath = resolve(__dirname, 'fixtures', 'stripes.piz.exr');
    const buffer = toArrayBuffer(readFileSync(fixturePath));

    parseExr(buffer, {
      onEvent: (event) => codes.add(event.code),
    });

    readExr(buffer, {
      onEvent: (event) => codes.add(event.code),
    });

    for (const code of codes) {
      expect(EXR_EVENT_CODES).toContain(code as (typeof EXR_EVENT_CODES)[number]);
    }
  });
});
