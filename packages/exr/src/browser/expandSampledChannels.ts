import { DecodedChannel, DecodedPart, ExrWindow } from '../shared/types';

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

export function expandSampledChannel(
  width: number,
  height: number,
  xMin: number,
  yMin: number,
  channel: DecodedChannel,
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
  const xSampleMap = buildNearestSampleMap(
    width,
    xMin,
    channel.sampleOriginX,
    xSampling,
    channel.sampledWidth,
  );
  const ySampleMap = buildNearestSampleMap(
    height,
    yMin,
    channel.sampleOriginY,
    ySampling,
    channel.sampledHeight,
  );

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

export function expandDecodedPartChannels(
  decoded: DecodedPart,
  dataWindow: ExrWindow,
): Record<string, Float32Array> {
  const output: Record<string, Float32Array> = {};
  for (const [name, channel] of Object.entries(decoded.channels)) {
    output[name] = expandSampledChannel(
      decoded.width,
      decoded.height,
      dataWindow.xMin,
      dataWindow.yMin,
      channel,
    );
  }
  return output;
}
