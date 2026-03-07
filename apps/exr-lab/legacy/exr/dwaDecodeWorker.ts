import { decodeDwaBlock } from '../../core/exr/dwa';
import type { ExrPart } from '../../core/exr/types';

interface DwaInitMessage {
  type: 'init';
  part: ExrPart;
  partId: number;
}

interface DwaDecodeMessage {
  type: 'decode';
  id: number;
  compressed: ArrayBuffer;
  chunkIndex: number;
  chunkY: number;
  linesInChunk: number;
}

type DwaWorkerMessage = DwaInitMessage | DwaDecodeMessage;

interface DwaDecodeSuccess {
  id: number;
  ok: true;
  decoded: ArrayBuffer;
}

interface DwaDecodeFailure {
  id: number;
  ok: false;
  error: string;
}

type DwaWorkerResponse = DwaDecodeSuccess | DwaDecodeFailure;

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

let part: ExrPart | null = null;
let partId = 0;

function transferSafeBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer;
  }

  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

ctx.onmessage = (event: MessageEvent<DwaWorkerMessage>) => {
  const message = event.data;

  if (message.type === 'init') {
    part = message.part;
    partId = message.partId;
    return;
  }

  try {
    if (!part) {
      throw new Error('DWA worker is not initialized.');
    }

    const decoded = decodeDwaBlock({
      buffer: message.compressed,
      dataPtr: 0,
      dataSize: message.compressed.byteLength,
      part,
      partId,
      chunkIndex: message.chunkIndex,
      chunkY: message.chunkY,
      linesInChunk: message.linesInChunk,
    });

    const response: DwaDecodeSuccess = {
      id: message.id,
      ok: true,
      decoded: transferSafeBuffer(decoded),
    };
    ctx.postMessage(response, [response.decoded]);
  } catch (error) {
    const response: DwaDecodeFailure = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(response);
  }
};

export {};
