import { decodeExrPart, ExrStructure } from '../../core/exr';
import { RawDecodeResult } from '../render/types';
import { DecodingOptions, LogEntry } from '../../types';
import { mapExrErrorToLogEntry, mapExrEventToLogEntry } from './logAdapter';

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
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
  const output = new Float32Array(width * height);

  if (channel.sampledWidth === 0 || channel.sampledHeight === 0 || channel.data.length === 0) {
    return output;
  }

  const xSampling = channel.xSampling > 0 ? channel.xSampling : 1;
  const ySampling = channel.ySampling > 0 ? channel.ySampling : 1;

  for (let y = 0; y < height; y++) {
    const worldY = yMin + y;
    const sampleYFloat = (worldY - channel.sampleOriginY) / ySampling;
    const sampleY = clamp(Math.round(sampleYFloat), 0, channel.sampledHeight - 1);
    const targetRow = y * width;
    const sourceRow = sampleY * channel.sampledWidth;

    for (let x = 0; x < width; x++) {
      const worldX = xMin + x;
      const sampleXFloat = (worldX - channel.sampleOriginX) / xSampling;
      const sampleX = clamp(Math.round(sampleXFloat), 0, channel.sampledWidth - 1);
      output[targetRow + x] = channel.data[sourceRow + sampleX];
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
