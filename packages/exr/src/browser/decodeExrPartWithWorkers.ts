import { decodeExrPart } from '../reader/decodeExrPart';
import { getScanlineLinesPerBlock } from '../reader/compression/scanline';
import { toArrayBuffer } from '../shared/binary';
import { DecodeExrPartOptions, DecodedPart, ExrPart, ExrStructure } from '../shared/types';

const ZIPS_COMPRESSION = 2;
const ZIP_COMPRESSION = 3;
const DWAA_COMPRESSION = 8;
const DWAB_COMPRESSION = 9;

const DEFAULT_MIN_ZIP_CHUNKS = 8;
const DEFAULT_MIN_DWA_CHUNKS = 2;
const DEFAULT_MAX_WORKERS = 8;

interface CompressedChunkTask {
  chunkIndex: number;
  dataPtr: number;
  dataSize: number;
  expectedUncompressedSize: number;
  chunkY: number;
  linesInChunk: number;
}

interface ZipWorkerRequest {
  id: number;
  compressed: ArrayBuffer;
  expectedUncompressedSize: number;
}

interface ZipWorkerSuccess {
  id: number;
  ok: true;
  decoded: ArrayBuffer;
}

interface ZipWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

type ZipWorkerResponse = ZipWorkerSuccess | ZipWorkerFailure;

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

interface DwaWorkerSuccess {
  id: number;
  ok: true;
  decoded: ArrayBuffer;
}

interface DwaWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

type DwaWorkerResponse = DwaWorkerSuccess | DwaWorkerFailure;

interface ZipChannelMeta {
  ySampling: number;
  sampleOriginY: number;
  sampledWidth: number;
  sampledHeight: number;
  rowByteLength: number;
}

export interface WorkerFactory {
  createZipWorker: () => Worker;
  createDwaWorker: () => Worker;
}

export interface DecodeExrPartWithWorkersOptions extends DecodeExrPartOptions {
  minZipChunks?: number;
  minDwaChunks?: number;
  maxWorkers?: number;
  workerFactory?: WorkerFactory;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function modulo(value: number, base: number): number {
  const result = value % base;
  return result < 0 ? result + base : result;
}

function firstSampleCoordinate(min: number, sampling: number): number {
  if (sampling <= 1) return min;
  const remainder = modulo(min, sampling);
  return remainder === 0 ? min : min + (sampling - remainder);
}

function countSamplesInRange(min: number, max: number, sampling: number): number {
  if (sampling <= 0 || max < min) return 0;
  const first = firstSampleCoordinate(min, sampling);
  if (first > max) return 0;
  return Math.floor((max - first) / sampling) + 1;
}

function isSampledCoordinate(value: number, firstSample: number, sampling: number): boolean {
  if (sampling <= 1) return true;
  if (value < firstSample) return false;
  return (value - firstSample) % sampling === 0;
}

function toNumberOffset(low: number, high: number): number {
  if (high <= 0x1fffff) {
    return high * 4294967296 + low;
  }

  const combined = BigInt(low) + (BigInt(high) << 32n);
  if (combined > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Chunk offset exceeds safe integer range.');
  }

  return Number(combined);
}

function buildZipChannelMeta(part: ExrPart): ZipChannelMeta[] {
  if (!part.dataWindow) return [];
  const { xMin, xMax, yMin, yMax } = part.dataWindow;

  return part.channels.map((channel) => {
    const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
    const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;
    const sampledWidth = countSamplesInRange(xMin, xMax, xSampling);
    const sampledHeight = countSamplesInRange(yMin, yMax, ySampling);
    const bytesPerSample = channel.pixelType === 1 ? 2 : 4;

    return {
      ySampling,
      sampleOriginY: firstSampleCoordinate(yMin, ySampling),
      sampledWidth,
      sampledHeight,
      rowByteLength: sampledWidth * bytesPerSample,
    };
  });
}

function getExpectedUncompressedChunkSize(
  part: ExrPart,
  channelMeta: ZipChannelMeta[],
  chunkY: number,
  linesInChunk: number,
): number {
  if (!part.dataWindow) return 0;
  let expected = 0;

  for (let dy = 0; dy < linesInChunk; dy++) {
    const y = chunkY + dy;
    if (y < part.dataWindow.yMin) {
      continue;
    }

    for (const meta of channelMeta) {
      if (meta.sampledWidth === 0 || meta.sampledHeight === 0) {
        continue;
      }
      if (!isSampledCoordinate(y, meta.sampleOriginY, meta.ySampling)) {
        continue;
      }
      expected += meta.rowByteLength;
    }
  }

  return expected;
}

function getParallelWorkerCount(taskCount: number, maxWorkers: number): number {
  const hardware =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;

  const target = hardware > 1 ? hardware - 1 : 1;
  return Math.max(1, Math.min(taskCount, target, maxWorkers));
}

function collectCompressedChunkTasks(
  buffer: ArrayBuffer,
  structure: ExrStructure,
  part: ExrPart,
  partIndex: number,
): CompressedChunkTask[] {
  if (!part.dataWindow) return [];
  const compression = part.compression ?? 0;
  if (
    compression !== ZIPS_COMPRESSION &&
    compression !== ZIP_COMPRESSION &&
    compression !== DWAA_COMPRESSION &&
    compression !== DWAB_COMPRESSION
  ) {
    return [];
  }

  const view = new DataView(buffer);
  const linesPerBlock = getScanlineLinesPerBlock(compression);
  const height = part.dataWindow.yMax - part.dataWindow.yMin + 1;
  const chunkCount = Math.ceil(height / linesPerBlock);

  let offsetTablePtr = structure.headerEndOffset;
  for (let i = 0; i < partIndex; i++) {
    const prior = structure.parts[i];
    if (!prior.dataWindow) continue;
    const priorHeight = prior.dataWindow.yMax - prior.dataWindow.yMin + 1;
    const priorChunks = Math.ceil(priorHeight / getScanlineLinesPerBlock(prior.compression ?? 0));
    offsetTablePtr += priorChunks * 8;
  }

  if (offsetTablePtr < 0 || offsetTablePtr + chunkCount * 8 > view.byteLength) {
    throw new Error('Offset table is truncated or invalid.');
  }

  const chunkOffsets: number[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const low = view.getUint32(offsetTablePtr + i * 8, true);
    const high = view.getUint32(offsetTablePtr + i * 8 + 4, true);
    chunkOffsets[i] = toNumberOffset(low, high);
  }

  const channelMeta = buildZipChannelMeta(part);
  const tasks: CompressedChunkTask[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex++) {
    const chunkOffset = chunkOffsets[chunkIndex];
    const chunkHeaderSize = structure.isMultipart ? 12 : 8;

    if (chunkOffset < 0 || chunkOffset + chunkHeaderSize > view.byteLength) {
      throw new Error(`Chunk ${chunkIndex} header is outside file bounds.`);
    }

    let chunkY = 0;
    let dataSize = 0;
    let dataPtr = chunkOffset;

    if (structure.isMultipart) {
      const partNumber = view.getInt32(chunkOffset, true);
      chunkY = view.getInt32(chunkOffset + 4, true);
      dataSize = view.getInt32(chunkOffset + 8, true);
      dataPtr = chunkOffset + 12;

      if (partNumber !== part.id) {
        continue;
      }
    } else {
      chunkY = view.getInt32(chunkOffset, true);
      dataSize = view.getInt32(chunkOffset + 4, true);
      dataPtr = chunkOffset + 8;
    }

    if (dataSize < 0 || dataPtr < 0 || dataPtr + dataSize > view.byteLength) {
      throw new Error(`Chunk ${chunkIndex} payload is outside file bounds.`);
    }

    const linesInChunk = Math.max(0, Math.min(linesPerBlock, part.dataWindow.yMax - chunkY + 1));
    const expectedUncompressedSize = getExpectedUncompressedChunkSize(
      part,
      channelMeta,
      chunkY,
      linesInChunk,
    );

    if (dataSize !== expectedUncompressedSize) {
      tasks.push({
        chunkIndex,
        dataPtr,
        dataSize,
        expectedUncompressedSize,
        chunkY,
        linesInChunk,
      });
    }
  }

  return tasks;
}

function getDefaultWorkerFactory(): WorkerFactory {
  return {
    createZipWorker: () =>
      new Worker(new URL('./zipDecodeWorker.ts', import.meta.url), { type: 'module' }),
    createDwaWorker: () =>
      new Worker(new URL('./dwaDecodeWorker.ts', import.meta.url), { type: 'module' }),
  };
}

async function decodeZipTasksInWorkers(
  buffer: ArrayBuffer,
  tasks: CompressedChunkTask[],
  maxWorkers: number,
  workerFactory: WorkerFactory,
): Promise<Map<number, Uint8Array>> {
  if (tasks.length === 0) {
    return new Map<number, Uint8Array>();
  }

  const workerCount = getParallelWorkerCount(tasks.length, maxWorkers);
  const workers: Worker[] = [];
  const taskByMessageId = new Map<number, CompressedChunkTask>();
  const blocks = new Map<number, Uint8Array>();

  return new Promise((resolve, reject) => {
    let completed = 0;
    let nextTaskIndex = 0;
    let nextMessageId = 1;
    let settled = false;

    const cleanup = () => {
      for (const worker of workers) {
        worker.terminate();
      }
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishIfDone = () => {
      if (settled || completed !== tasks.length) return;
      settled = true;
      cleanup();
      resolve(blocks);
    };

    const dispatchNextTask = (worker: Worker) => {
      if (settled || nextTaskIndex >= tasks.length) return;

      const task = tasks[nextTaskIndex++];
      const messageId = nextMessageId++;
      taskByMessageId.set(messageId, task);

      const compressed = new Uint8Array(task.dataSize);
      compressed.set(new Uint8Array(buffer, task.dataPtr, task.dataSize));

      const request: ZipWorkerRequest = {
        id: messageId,
        compressed: compressed.buffer,
        expectedUncompressedSize: task.expectedUncompressedSize,
      };

      worker.postMessage(request, [request.compressed]);
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = workerFactory.createZipWorker();
      workers.push(worker);

      worker.onmessage = (event: MessageEvent<ZipWorkerResponse>) => {
        if (settled) return;
        const response = event.data;
        const task = taskByMessageId.get(response.id);
        if (!task) {
          fail(new Error('Received worker response for unknown ZIP task.'));
          return;
        }
        taskByMessageId.delete(response.id);

        if (response.ok === false) {
          fail(new Error(response.error || 'ZIP worker failed.'));
          return;
        }

        blocks.set(task.chunkIndex, new Uint8Array(response.decoded));
        completed += 1;
        dispatchNextTask(worker);
        finishIfDone();
      };

      worker.onerror = (event: ErrorEvent) => {
        fail(event.error || new Error(event.message || 'ZIP worker error.'));
      };

      dispatchNextTask(worker);
    }
  });
}

async function decodeDwaTasksInWorkers(
  buffer: ArrayBuffer,
  tasks: CompressedChunkTask[],
  part: ExrPart,
  maxWorkers: number,
  workerFactory: WorkerFactory,
): Promise<Map<number, Uint8Array>> {
  if (tasks.length === 0) {
    return new Map<number, Uint8Array>();
  }

  const workerCount = getParallelWorkerCount(tasks.length, maxWorkers);
  const workers: Worker[] = [];
  const taskByMessageId = new Map<number, CompressedChunkTask>();
  const blocks = new Map<number, Uint8Array>();

  return new Promise((resolve, reject) => {
    let completed = 0;
    let nextTaskIndex = 0;
    let nextMessageId = 1;
    let settled = false;

    const cleanup = () => {
      for (const worker of workers) {
        worker.terminate();
      }
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishIfDone = () => {
      if (settled || completed !== tasks.length) return;
      settled = true;
      cleanup();
      resolve(blocks);
    };

    const dispatchNextTask = (worker: Worker) => {
      if (settled || nextTaskIndex >= tasks.length) return;

      const task = tasks[nextTaskIndex++];
      const messageId = nextMessageId++;
      taskByMessageId.set(messageId, task);

      const compressed = new Uint8Array(task.dataSize);
      compressed.set(new Uint8Array(buffer, task.dataPtr, task.dataSize));

      const request: DwaWorkerDecodeMessage = {
        type: 'decode',
        id: messageId,
        compressed: compressed.buffer,
        chunkIndex: task.chunkIndex,
        chunkY: task.chunkY,
        linesInChunk: task.linesInChunk,
      };

      worker.postMessage(request, [request.compressed]);
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = workerFactory.createDwaWorker();
      workers.push(worker);

      const initMessage: DwaWorkerInitMessage = {
        type: 'init',
        part,
        partId: part.id,
      };
      worker.postMessage(initMessage);

      worker.onmessage = (event: MessageEvent<DwaWorkerResponse>) => {
        if (settled) return;
        const response = event.data;
        const task = taskByMessageId.get(response.id);
        if (!task) {
          fail(new Error('Received worker response for unknown DWA task.'));
          return;
        }
        taskByMessageId.delete(response.id);

        if (response.ok === false) {
          fail(new Error(response.error || 'DWA worker failed.'));
          return;
        }

        blocks.set(task.chunkIndex, new Uint8Array(response.decoded));
        completed += 1;
        dispatchNextTask(worker);
        finishIfDone();
      };

      worker.onerror = (event: ErrorEvent) => {
        fail(event.error || new Error(event.message || 'DWA worker error.'));
      };

      dispatchNextTask(worker);
    }
  });
}

function canUseParallelChunkDecode(): boolean {
  return typeof Worker !== 'undefined';
}

function mergePredecodedMaps(
  base: Map<number, Uint8Array> | undefined,
  patch: Map<number, Uint8Array> | undefined,
): Map<number, Uint8Array> | undefined {
  if (!base && !patch) return undefined;
  const merged = new Map<number, Uint8Array>();
  for (const [k, v] of base ?? []) merged.set(k, v);
  for (const [k, v] of patch ?? []) merged.set(k, v);
  return merged;
}

export async function decodeExrPartWithWorkers(
  bufferInput: ArrayBuffer | Uint8Array,
  structure: ExrStructure,
  options: DecodeExrPartWithWorkersOptions,
): Promise<DecodedPart> {
  const buffer = toArrayBuffer(bufferInput);
  const partIndex = structure.parts.findIndex((candidate) => candidate.id === options.partId);
  const part = partIndex >= 0 ? structure.parts[partIndex] : null;
  if (!part?.dataWindow) {
    return decodeExrPart(buffer, structure, options);
  }

  const maxWorkers = clamp(options.maxWorkers ?? DEFAULT_MAX_WORKERS, 1, DEFAULT_MAX_WORKERS);
  const minZipChunks = Math.max(1, options.minZipChunks ?? DEFAULT_MIN_ZIP_CHUNKS);
  const minDwaChunks = Math.max(1, options.minDwaChunks ?? DEFAULT_MIN_DWA_CHUNKS);

  let predecodedZipBlocks: Map<number, Uint8Array> | undefined;
  let predecodedDwaBlocks: Map<number, Uint8Array> | undefined;
  const compression = part.compression ?? 0;
  const workerFactory = options.workerFactory ?? getDefaultWorkerFactory();

  if (canUseParallelChunkDecode()) {
    if (compression === ZIPS_COMPRESSION || compression === ZIP_COMPRESSION) {
      const tasks = collectCompressedChunkTasks(buffer, structure, part, partIndex);
      if (tasks.length >= minZipChunks) {
        predecodedZipBlocks = await decodeZipTasksInWorkers(
          buffer,
          tasks,
          maxWorkers,
          workerFactory,
        );
      }
    }

    if (compression === DWAA_COMPRESSION || compression === DWAB_COMPRESSION) {
      const tasks = collectCompressedChunkTasks(buffer, structure, part, partIndex);
      if (tasks.length >= minDwaChunks) {
        predecodedDwaBlocks = await decodeDwaTasksInWorkers(
          buffer,
          tasks,
          part,
          maxWorkers,
          workerFactory,
        );
      }
    }
  }

  const mergedZipBlocks = mergePredecodedMaps(options.predecodedZipBlocks, predecodedZipBlocks);
  const mergedDwaBlocks = mergePredecodedMaps(options.predecodedDwaBlocks, predecodedDwaBlocks);

  return decodeExrPart(buffer, structure, {
    partId: options.partId,
    onEvent: options.onEvent,
    predecodedZipBlocks: mergedZipBlocks,
    predecodedDwaBlocks: mergedDwaBlocks,
  });
}
