export function interleave(data: Uint8Array): Uint8Array {
  const length = data.length;
  const half = Math.floor((length + 1) / 2);
  const out = new Uint8Array(length);

  let even = 0;
  let odd = half;
  for (let i = 0; i < length; i++) {
    if ((i & 1) === 0) {
      out[even++] = data[i];
    } else {
      out[odd++] = data[i];
    }
  }

  return out;
}

export function applyPredictor(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  const out = new Uint8Array(data.length);
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = (data[i] - data[i - 1] + 128) & 0xff;
  }
  return out;
}
