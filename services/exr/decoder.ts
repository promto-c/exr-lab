import { decodeExrPart, ExrStructure } from '../../core/exr';
import { RawDecodeResult } from '../render/types';
import { DecodingOptions, LogEntry } from '../../types';
import { mapExrErrorToLogEntry, mapExrEventToLogEntry } from './logAdapter';

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
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
    const part = this.structure.parts.find((candidate) => candidate.id === options.partId);
    if (!part?.dataWindow) {
      this.onLog(mapExrErrorToLogEntry(new Error('Part dataWindow is missing.'), 'decode.error'));
      return null;
    }

    try {
      const decoded = decodeExrPart(this.buffer, this.structure, {
        partId: options.partId,
        onEvent: (event) => this.onLog(mapExrEventToLogEntry(event)),
      });

      const channels: Record<string, Float32Array> = {};
      const channelInfo: RawDecodeResult['channelInfo'] = {};

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
