import { applyPredictor, interleave } from './zipPredictor';

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
        (rune + 1 >= end ||
          data[rune] !== data[rune + 1] ||
          rune + 2 >= end ||
          data[rune + 1] !== data[rune + 2]) &&
        count < 127
      ) {
        count++;
        rune++;
      }

      out.push(-count & 0xff);
      while (runs < rune) {
        out.push(data[runs++]);
      }
    }

    rune++;
  }

  return Uint8Array.from(out);
}

export function encodeRleChunk(raw: Uint8Array): Uint8Array {
  const encoded = rleCompress(applyPredictor(interleave(raw)));
  return encoded.byteLength >= raw.byteLength ? raw : encoded;
}
