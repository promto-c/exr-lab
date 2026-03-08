import { decodeDwaBlock } from '../reader/compression/dwa';
import type { ExrPart } from '../shared/types';

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

const scope = self as DedicatedWorkerGlobalScope;

let part: ExrPart | null = null;
let partId = 0;

function toTransferBuffer(view: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(view.byteLength);
  output.set(view);
  return output.buffer;
}

scope.onmessage = (event: MessageEvent<DwaWorkerMessage>) => {
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

    const transfer = toTransferBuffer(decoded);
    const response: DwaDecodeSuccess = {
      id: message.id,
      ok: true,
      decoded: transfer,
    };
    scope.postMessage(response, [transfer]);
  } catch (error) {
    const response: DwaDecodeFailure = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response as DwaWorkerResponse);
  }
};

export {};
