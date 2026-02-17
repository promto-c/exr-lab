import { unzlibSync } from 'fflate';

interface ZipDecodeRequest {
  id: number;
  compressed: ArrayBuffer;
  expectedUncompressedSize: number;
}

interface ZipDecodeSuccess {
  id: number;
  ok: true;
  decoded: ArrayBuffer;
}

interface ZipDecodeFailure {
  id: number;
  ok: false;
  error: string;
}

type ZipDecodeResponse = ZipDecodeSuccess | ZipDecodeFailure;

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

let inflateScratch = new Uint8Array(0);
let outputScratch = new Uint8Array(0);

function ensureInflateScratch(size: number): Uint8Array {
  if (inflateScratch.byteLength < size) {
    inflateScratch = new Uint8Array(size);
  }
  return inflateScratch.subarray(0, size);
}

function ensureOutputScratch(size: number): Uint8Array {
  if (outputScratch.byteLength < size) {
    outputScratch = new Uint8Array(size);
  }
  return outputScratch.subarray(0, size);
}

function undoZipPredictorAndInterleave(data: Uint8Array, output: Uint8Array): Uint8Array {
  const length = data.length;
  if (length === 0) return data;

  const half = (length + 1) >> 1;
  let predicted = data[0];
  output[0] = predicted;

  for (let i = 1; i < half; i++) {
    predicted = (predicted + data[i] - 128) & 0xff;
    output[i << 1] = predicted;
  }

  for (let i = half; i < length; i++) {
    predicted = (predicted + data[i] - 128) & 0xff;
    output[((i - half) << 1) + 1] = predicted;
  }

  return output;
}

ctx.onmessage = (event: MessageEvent<ZipDecodeRequest>) => {
  const message = event.data;

  try {
    const compressed = new Uint8Array(message.compressed);
    const raw =
      message.expectedUncompressedSize > 0
        ? unzlibSync(compressed, {
            out: ensureInflateScratch(message.expectedUncompressedSize),
          })
        : unzlibSync(compressed);

    const decodedView = undoZipPredictorAndInterleave(raw, ensureOutputScratch(raw.byteLength));
    const decoded = new Uint8Array(decodedView.byteLength);
    decoded.set(decodedView);

    const response: ZipDecodeSuccess = {
      id: message.id,
      ok: true,
      decoded: decoded.buffer,
    };
    ctx.postMessage(response, [decoded.buffer]);
  } catch (error) {
    const response: ZipDecodeFailure = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(response);
  }
};

export {};
