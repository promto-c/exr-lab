import { decodeExrPart } from '../../core/exr';
import type { ExrPart, ExrStructure } from '../../core/exr';
import { RawDecodeResult } from '../render/types';
import { DecodingOptions, LogEntry, LogStatus } from '../../types';
import { mapExrErrorToLogEntry, mapExrEventToLogEntry } from './logAdapter';

const ZIPS_COMPRESSION = 2;
const ZIP_COMPRESSION = 3;
const DWAA_COMPRESSION = 8;
const DWAB_COMPRESSION = 9;
const PARALLEL_ZIP_MIN_CHUNKS = 8;
const PARALLEL_DWA_MIN_CHUNKS = 2;
const MAX_PARALLEL_WORKERS = 8;

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

interface ParallelZipDecodeResult {
  blocks: Map<number, Uint8Array>;
  workers: number;
  ms: number;
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

interface ParallelDwaDecodeResult {
  blocks: Map<number, Uint8Array>;
  workers: number;
  ms: number;
}

interface ZipChannelMeta {
  ySampling: number;
  sampleOriginY: number;
  sampledWidth: number;
  sampledHeight: number;
  rowByteLength: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function getScanlineLinesPerBlock(compression: number): number {
  switch (compression) {
    case 0:
    case 1:
    case 2:
      return 1;
    case 3:
    case 5:
      return 16;
    case 4:
    case 6:
    case 7:
    case 8:
      return 32;
    case 9:
      return 256;
    default:
      return 1;
  }
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

function buildNearestSampleMap(
  length: number,
  worldMin: number,
  sampleOrigin: number,
  sampling: number,
  sampledLength: number,
): Int32Array {
  const output = new Int32Array(length);
  if (sampledLength <= 0) return output;

  for (let i = 0; i < length; i++) {
    const world = worldMin + i;
    const sample = Math.round((world - sampleOrigin) / sampling);
    output[i] = clamp(sample, 0, sampledLength - 1);
  }

  return output;
}

function expandChannelToFullResolution(
  width: number,
  height: number,
  xMin: number,
  yMin: number,
  channel: {
    data: Float32Array;
    xSampling: number;
    ySampling: number;
    sampledWidth: number;
    sampledHeight: number;
    sampleOriginX: number;
    sampleOriginY: number;
  },
): Float32Array {
  if (channel.sampledWidth === 0 || channel.sampledHeight === 0 || channel.data.length === 0) {
    return new Float32Array(width * height);
  }

  const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
  const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;

  if (
    xSampling === 1 &&
    ySampling === 1 &&
    channel.sampledWidth === width &&
    channel.sampledHeight === height &&
    channel.sampleOriginX === xMin &&
    channel.sampleOriginY === yMin
  ) {
    return channel.data;
  }

  const output = new Float32Array(width * height);
  const xSampleMap = buildNearestSampleMap(width, xMin, channel.sampleOriginX, xSampling, channel.sampledWidth);
  const ySampleMap = buildNearestSampleMap(height, yMin, channel.sampleOriginY, ySampling, channel.sampledHeight);

  for (let y = 0; y < height; y++) {
    const sampleY = ySampleMap[y];
    const targetRow = y * width;
    const sourceRow = sampleY * channel.sampledWidth;

    for (let x = 0; x < width; x++) {
      output[targetRow + x] = channel.data[sourceRow + xSampleMap[x]];
    }
  }

  return output;
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

function canUseParallelChunkDecode(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getParallelWorkerCount(taskCount: number): number {
  const hardware =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;

  const target = hardware > 1 ? hardware - 1 : 1;
  return Math.max(1, Math.min(taskCount, target, MAX_PARALLEL_WORKERS));
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

    // OpenEXR may store raw chunks when compression is ineffective.
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

async function decodeZipTasksInWorkers(
  buffer: ArrayBuffer,
  tasks: CompressedChunkTask[],
): Promise<ParallelZipDecodeResult> {
  if (tasks.length === 0) {
    return {
      blocks: new Map<number, Uint8Array>(),
      workers: 0,
      ms: 0,
    };
  }

  const t0 = nowMs();
  const workerCount = getParallelWorkerCount(tasks.length);
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
      resolve({
        blocks,
        workers: workerCount,
        ms: nowMs() - t0,
      });
    };

    const dispatchNextTask = (worker: Worker) => {
      if (settled || nextTaskIndex >= tasks.length) {
        return;
      }

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
      const worker = new Worker(new URL('./zipDecodeWorker.ts', import.meta.url), {
        type: 'module',
      });
      workers.push(worker);

      worker.onmessage = (event: MessageEvent<ZipWorkerResponse>) => {
        if (settled) return;
        const response = event.data;
        const task = taskByMessageId.get(response.id);
        if (!task) {
          fail(new Error('Received worker response for unknown task.'));
          return;
        }
        taskByMessageId.delete(response.id);

        if (!response.ok) {
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
): Promise<ParallelDwaDecodeResult> {
  if (tasks.length === 0) {
    return {
      blocks: new Map<number, Uint8Array>(),
      workers: 0,
      ms: 0,
    };
  }

  const t0 = nowMs();
  const workerCount = getParallelWorkerCount(tasks.length);
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
      resolve({
        blocks,
        workers: workerCount,
        ms: nowMs() - t0,
      });
    };

    const dispatchNextTask = (worker: Worker) => {
      if (settled || nextTaskIndex >= tasks.length) {
        return;
      }

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
      const worker = new Worker(new URL('./dwaDecodeWorker.ts', import.meta.url), {
        type: 'module',
      });
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
          fail(new Error('Received worker response for unknown task.'));
          return;
        }
        taskByMessageId.delete(response.id);

        if (!response.ok) {
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

export class ExrDecoder {
  constructor(
    private readonly buffer: ArrayBuffer,
    private readonly structure: ExrStructure,
    private readonly onLog: (log: LogEntry) => void,
  ) {}

  /**
   * Backward-compatible adapter over the reusable EXR core API.
   */
  public async decode(options: DecodingOptions): Promise<RawDecodeResult | null> {
    const partIndex = this.structure.parts.findIndex((candidate) => candidate.id === options.partId);
    const part = partIndex >= 0 ? this.structure.parts[partIndex] : null;
    if (!part?.dataWindow) {
      this.onLog(mapExrErrorToLogEntry(new Error('Part dataWindow is missing.'), 'decode.error'));
      return null;
    }

    try {
      const tDecodeStart = nowMs();
      const compression = part.compression ?? 0;
      let predecodedZipBlocks: Map<number, Uint8Array> | undefined;
      let predecodedDwaBlocks: Map<number, Uint8Array> | undefined;
      let workerMs = 0;
      let workerChunks = 0;
      let workerCount = 0;
      let workerCodec = '';

      if ((compression === ZIPS_COMPRESSION || compression === ZIP_COMPRESSION) && canUseParallelChunkDecode()) {
        try {
          const tasks = collectCompressedChunkTasks(this.buffer, this.structure, part, partIndex);
          if (tasks.length >= PARALLEL_ZIP_MIN_CHUNKS) {
            const parallel = await decodeZipTasksInWorkers(this.buffer, tasks);
            predecodedZipBlocks = parallel.blocks;
            workerMs = parallel.ms;
            workerChunks = tasks.length;
            workerCount = parallel.workers;
            workerCodec = 'ZIP';

            this.onLog({
              id: uid('decode-parallel'),
              stepId: 'decode.parallel',
              title: 'Parallel ZIP Decode',
              status: LogStatus.Ok,
              ms: parallel.ms,
              metrics: [
                { label: 'Workers', value: parallel.workers },
                { label: 'Chunks', value: tasks.length },
              ],
            });
          }
        } catch (error) {
          this.onLog({
            id: uid('decode-parallel'),
            stepId: 'decode.parallel',
            title: 'Parallel ZIP Decode Fallback',
            status: LogStatus.Warn,
            ms: 0,
            metrics: [],
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if ((compression === DWAA_COMPRESSION || compression === DWAB_COMPRESSION) && canUseParallelChunkDecode()) {
        try {
          const tasks = collectCompressedChunkTasks(this.buffer, this.structure, part, partIndex);
          if (tasks.length >= PARALLEL_DWA_MIN_CHUNKS) {
            const parallel = await decodeDwaTasksInWorkers(this.buffer, tasks, part);
            predecodedDwaBlocks = parallel.blocks;
            workerMs = parallel.ms;
            workerChunks = tasks.length;
            workerCount = parallel.workers;
            workerCodec = 'DWA';

            this.onLog({
              id: uid('decode-parallel'),
              stepId: 'decode.parallel',
              title: 'Parallel DWA Decode',
              status: LogStatus.Ok,
              ms: parallel.ms,
              metrics: [
                { label: 'Workers', value: parallel.workers },
                { label: 'Chunks', value: tasks.length },
              ],
            });
          }
        } catch (error) {
          this.onLog({
            id: uid('decode-parallel'),
            stepId: 'decode.parallel',
            title: 'Parallel DWA Decode Fallback',
            status: LogStatus.Warn,
            ms: 0,
            metrics: [],
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const tCoreStart = nowMs();
      const decoded = decodeExrPart(this.buffer, this.structure, {
        partId: options.partId,
        predecodedZipBlocks,
        predecodedDwaBlocks,
        onEvent: (event) => this.onLog(mapExrEventToLogEntry(event)),
      });
      const coreDecodeMs = nowMs() - tCoreStart;

      const channels: Record<string, Float32Array> = {};
      const channelInfo: RawDecodeResult['channelInfo'] = {};
      const tExpandStart = nowMs();

      for (const [name, channel] of Object.entries(decoded.channels)) {
        channels[name] = expandChannelToFullResolution(
          decoded.width,
          decoded.height,
          part.dataWindow.xMin,
          part.dataWindow.yMin,
          channel,
        );

        channelInfo[name] = {
          pixelType: channel.pixelType,
          xSampling: channel.xSampling,
          ySampling: channel.ySampling,
          sampledWidth: channel.sampledWidth,
          sampledHeight: channel.sampledHeight,
          sampleOriginX: channel.sampleOriginX,
          sampleOriginY: channel.sampleOriginY,
        };
      }
      const expansionMs = nowMs() - tExpandStart;
      const totalMs = nowMs() - tDecodeStart;

      this.onLog({
        id: uid('decode-e2e'),
        stepId: 'decode.e2e',
        title: 'Decode End-to-End',
        status: LogStatus.Ok,
        ms: totalMs,
        metrics: [
          { label: 'Part', value: options.partId },
          { label: 'Worker ms', value: Number(workerMs.toFixed(3)) },
          { label: 'Core ms', value: Number(coreDecodeMs.toFixed(3)) },
          { label: 'Expand ms', value: Number(expansionMs.toFixed(3)) },
          { label: 'Workers', value: workerCount },
          { label: 'Parallel chunks', value: workerChunks },
          { label: 'Worker codec', value: workerCodec || 'none' },
        ],
        description: 'Includes worker predecode, core decode, and channel expansion.',
      });

      return {
        width: decoded.width,
        height: decoded.height,
        channels,
        channelInfo,
      };
    } catch (error) {
      this.onLog(mapExrErrorToLogEntry(error, 'decode.error'));
      return null;
    }
  }
}
