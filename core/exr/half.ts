function createHalfToFloatTable(): Float32Array {
  const exponentTable = new Uint32Array(64);
  const offsetTable = new Uint32Array(64);
  const mantissaTable = new Uint32Array(2048);
  const table = new Float32Array(65536);

  exponentTable[0] = 0;
  for (let i = 1; i < 31; i++) {
    exponentTable[i] = i << 23;
  }
  exponentTable[31] = 0x47800000;
  exponentTable[32] = 0x80000000;
  for (let i = 33; i < 63; i++) {
    exponentTable[i] = 0x80000000 + ((i - 32) << 23);
  }
  exponentTable[63] = 0xc7800000;

  offsetTable[0] = 0;
  for (let i = 1; i < 64; i++) {
    offsetTable[i] = i === 32 ? 0 : 1024;
  }

  mantissaTable[0] = 0;
  for (let i = 1; i < 1024; i++) {
    let m = i << 13;
    let e = 0;
    while ((m & 0x00800000) === 0) {
      e -= 0x00800000;
      m <<= 1;
    }
    m &= ~0x00800000;
    e += 0x38800000;
    mantissaTable[i] = m | e;
  }
  for (let i = 1024; i < 2048; i++) {
    mantissaTable[i] = 0x38000000 + ((i - 1024) << 13);
  }

  const scratch = new ArrayBuffer(4);
  const floatView = new Float32Array(scratch);
  const uintView = new Uint32Array(scratch);

  for (let h = 0; h < 65536; h++) {
    const offset = offsetTable[h >> 10];
    const mantissa = mantissaTable[offset + (h & 0x3ff)];
    const exponent = exponentTable[h >> 10];
    uintView[0] = mantissa + exponent;
    table[h] = floatView[0];
  }

  return table;
}

const HALF_TO_FLOAT_TABLE = createHalfToFloatTable();

export function float16ToFloat32(h: number): number {
  return HALF_TO_FLOAT_TABLE[h & 0xffff];
}
