import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzlibSync, zlibSync } from 'fflate';
import { decodeDwaBlock } from '../dwa';
import { decodeExrPart, parseExr } from '../index';
import { decodeExrPartWithWorkers, WorkerFactory } from '../browser';
import type { ExrPart } from '../types';

interface ZipWorkerRequest {
  id: number;
  compressed: ArrayBuffer;
  expectedUncompressedSize: number;
}

interface DwaWorkerInitMessage {
  type: 'init';
  part: ExrPart;
  partId: number;
}

interface DwaWorkerDecodeMessage {
  type: 'decode';
  id: number;
  compressed: ArrayBuffer;
  chunkIndex: number;
  chunkY: number;
  linesInChunk: number;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const output = new Uint8Array(buffer.byteLength);
  output.set(buffer);
  return output.buffer;
}

function writeCString(target: number[], text: string) {
  for (let i = 0; i < text.length; i++) target.push(text.charCodeAt(i));
  target.push(0);
}

function pushInt32LE(target: number[], value: number) {
  target.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function pushUint32LE(target: number[], value: number) {
  const v = value >>> 0;
  target.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}

function interleave(data: Uint8Array): Uint8Array {
  const length = data.length;
  const half = Math.floor((length + 1) / 2);
  const out = new Uint8Array(length);

  let even = 0;
  let odd = half;
  for (let i = 0; i < length; i++) {
    if ((i & 1) === 0) out[even++] = data[i];
    else out[odd++] = data[i];
  }
  return out;
}

function applyPredictor(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  const out = new Uint8Array(data.length);
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = (data[i] - data[i - 1] + 128) & 0xff;
  }
  return out;
}

function undoZipPredictorAndInterleave(data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.byteLength);
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

function floatToBytes(value: number): number[] {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, true);
  return [scratch.getUint8(0), scratch.getUint8(1), scratch.getUint8(2), scratch.getUint8(3)];
}

function buildZipFixture(): ArrayBuffer {
  const width = 2;
  const height = 2;
  const xMin = 0;
  const yMin = 0;
  const xMax = width - 1;
  const yMax = height - 1;

  const bytes: number[] = [];
  pushUint32LE(bytes, 20000630); // magic
  pushUint32LE(bytes, 2); // version

  const chlist: number[] = [];
  writeCString(chlist, 'R');
  pushInt32LE(chlist, 2); // FLOAT
  chlist.push(0, 0, 0, 0);
  pushInt32LE(chlist, 1);
  pushInt32LE(chlist, 1);
  chlist.push(0);

  const windowPayload: number[] = [];
  pushInt32LE(windowPayload, xMin);
  pushInt32LE(windowPayload, yMin);
  pushInt32LE(windowPayload, xMax);
  pushInt32LE(windowPayload, yMax);

  const writeAttribute = (name: string, type: string, payload: number[]) => {
    writeCString(bytes, name);
    writeCString(bytes, type);
    pushInt32LE(bytes, payload.length);
    bytes.push(...payload);
  };

  writeAttribute('channels', 'chlist', chlist);
  writeAttribute('compression', 'compression', [3]); // ZIP_COMPRESSION
  writeAttribute('dataWindow', 'box2i', windowPayload);
  writeAttribute('displayWindow', 'box2i', windowPayload);
  writeAttribute('lineOrder', 'lineOrder', [0, 0, 0, 0]);
  bytes.push(0); // end header

  const offsetTablePtr = bytes.length;
  bytes.push(0, 0, 0, 0, 0, 0, 0, 0); // one chunk offset

  const rawBlock: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rawBlock.push(...floatToBytes(x + y * 10 + 0.25));
    }
  }

  const predicted = applyPredictor(interleave(Uint8Array.from(rawBlock)));
  const compressed = zlibSync(predicted);

  const chunkOffset = bytes.length;
  pushInt32LE(bytes, 0); // chunk y
  pushInt32LE(bytes, compressed.byteLength);
  bytes.push(...compressed);

  bytes[offsetTablePtr + 0] = chunkOffset & 0xff;
  bytes[offsetTablePtr + 1] = (chunkOffset >> 8) & 0xff;
  bytes[offsetTablePtr + 2] = (chunkOffset >> 16) & 0xff;
  bytes[offsetTablePtr + 3] = (chunkOffset >> 24) & 0xff;

  return Uint8Array.from(bytes).buffer;
}

type WorkerMessageHandler = ((event: MessageEvent<unknown>) => void) | null;
type WorkerErrorHandler = ((event: ErrorEvent) => void) | null;

class ZipMockWorker {
  public onmessage: WorkerMessageHandler = null;
  public onerror: WorkerErrorHandler = null;

  public postMessage(message: unknown): void {
    try {
      const req = message as ZipWorkerRequest;
      const compressed = new Uint8Array(req.compressed);
      const raw =
        req.expectedUncompressedSize > 0
          ? unzlibSync(compressed, { out: new Uint8Array(req.expectedUncompressedSize) })
          : unzlibSync(compressed);
      const decoded = undoZipPredictorAndInterleave(raw);
      const out = new Uint8Array(decoded.byteLength);
      out.set(decoded);
      this.onmessage?.({
        data: { id: req.id, ok: true, decoded: out.buffer },
      } as MessageEvent<unknown>);
    } catch (error) {
      this.onerror?.({
        message: error instanceof Error ? error.message : String(error),
      } as ErrorEvent);
    }
  }

  public terminate(): void {
    // no-op for mock
  }
}

class DwaMockWorker {
  public onmessage: WorkerMessageHandler = null;
  public onerror: WorkerErrorHandler = null;

  private part: ExrPart | null = null;
  private partId = 0;

  public postMessage(message: unknown): void {
    const msg = message as DwaWorkerInitMessage | DwaWorkerDecodeMessage;
    if (msg.type === 'init') {
      this.part = msg.part;
      this.partId = msg.partId;
      return;
    }

    try {
      if (!this.part) {
        throw new Error('DWA mock worker not initialized.');
      }
      const decoded = decodeDwaBlock({
        buffer: msg.compressed,
        dataPtr: 0,
        dataSize: msg.compressed.byteLength,
        part: this.part,
        partId: this.partId,
        chunkIndex: msg.chunkIndex,
        chunkY: msg.chunkY,
        linesInChunk: msg.linesInChunk,
      });

      const out = new Uint8Array(decoded.byteLength);
      out.set(decoded);
      this.onmessage?.({
        data: { id: msg.id, ok: true, decoded: out.buffer },
      } as MessageEvent<unknown>);
    } catch (error) {
      this.onerror?.({
        message: error instanceof Error ? error.message : String(error),
      } as ErrorEvent);
    }
  }

  public terminate(): void {
    // no-op for mock
  }
}

function withWorkerGlobal<T>(fn: () => Promise<T>): Promise<T> {
  const globalRef = globalThis as unknown as { Worker?: unknown };
  const previousWorker = globalRef.Worker;
  globalRef.Worker = class {} as unknown;

  return fn().finally(() => {
    if (typeof previousWorker === 'undefined') {
      delete globalRef.Worker;
    } else {
      globalRef.Worker = previousWorker;
    }
  });
}

describe('browser worker helper parity', () => {
  it('matches core decode for ZIP fixtures via worker predecode path', async () => {
    const fixture = buildZipFixture();
    const structure = parseExr(fixture);

    const expected = decodeExrPart(fixture, structure, { partId: 0 });

    const workerFactory: WorkerFactory = {
      createZipWorker: () => new ZipMockWorker() as unknown as Worker,
      createDwaWorker: () => new DwaMockWorker() as unknown as Worker,
    };

    const actual = await withWorkerGlobal(() =>
      decodeExrPartWithWorkers(fixture, structure, {
        partId: 0,
        minZipChunks: 1,
        workerFactory,
      }),
    );

    expect(Array.from(actual.channels.R.data)).toEqual(Array.from(expected.channels.R.data));
  });

  it('matches core decode for DWAA fixture via worker predecode path', async () => {
    const fixturePath = resolve(__dirname, 'fixtures', 'comp_dwaa_v2.exr');
    const fixture = toArrayBuffer(readFileSync(fixturePath));
    const structure = parseExr(fixture);
    const partId = structure.parts[0]?.id ?? 0;

    const expected = decodeExrPart(fixture, structure, { partId });

    const workerFactory: WorkerFactory = {
      createZipWorker: () => new ZipMockWorker() as unknown as Worker,
      createDwaWorker: () => new DwaMockWorker() as unknown as Worker,
    };

    const actual = await withWorkerGlobal(() =>
      decodeExrPartWithWorkers(fixture, structure, {
        partId,
        minDwaChunks: 1,
        workerFactory,
      }),
    );

    for (const [name, channel] of Object.entries(expected.channels)) {
      expect(Array.from(actual.channels[name].data)).toEqual(Array.from(channel.data));
    }
  }, 90000);
});
