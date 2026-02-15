// Fast Half-Float to Float32 conversion
// Based on standard OpenEXR implementation tables

const exponentTable = new Uint32Array(64);
const offsetTable = new Uint32Array(64);
const mantissaTable = new Uint32Array(2048);

function initTables() {
    // 1. Exponent Table
    exponentTable[0] = 0;
    for (let i = 1; i < 31; i++) {
        exponentTable[i] = i << 23;
    }
    exponentTable[31] = 0x47800000;
    exponentTable[32] = 0x80000000;
    for (let i = 33; i < 63; i++) {
        exponentTable[i] = 0x80000000 + ((i - 32) << 23);
    }
    exponentTable[63] = 0xC7800000;

    // 2. Offset Table
    offsetTable[0] = 0;
    for (let i = 1; i < 64; i++) {
        if (i === 32) {
            offsetTable[i] = 0;
        } else {
            offsetTable[i] = 1024;
        }
    }

    // 3. Mantissa Table
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
}

// Initialize once
initTables();

const buffer = new ArrayBuffer(4);
const floatView = new Float32Array(buffer);
const uint32View = new Uint32Array(buffer);

/**
 * Converts a 16-bit half precision float to a standard 32-bit float number.
 * @param h - The 16-bit integer representation of the half float.
 * @returns The 32-bit floating point value.
 */
export function float16ToFloat32(h: number): number {
    const offset = offsetTable[h >> 10];
    const mantissa = mantissaTable[offset + (h & 0x3ff)];
    const exponent = exponentTable[h >> 10];
    
    uint32View[0] = mantissa + exponent;
    return floatView[0];
}

/**
 * Bulk convert a buffer of uint16 halfs to float32
 */
export function decodeHalfBlock(dataView: DataView, offset: number, count: number): Float32Array {
    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        // Read Uint16 (little endian)
        const h = dataView.getUint16(offset + i * 2, true);
        output[i] = float16ToFloat32(h);
    }
    return output;
}