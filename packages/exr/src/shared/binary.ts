export type ExrBinaryInput = ArrayBuffer | Uint8Array;

export function toArrayBuffer(input: ExrBinaryInput): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }

  const output = new Uint8Array(input.byteLength);
  output.set(input);
  return output.buffer;
}
