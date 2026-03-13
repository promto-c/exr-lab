import type { ExrChannel, ExrPart, ExrWindow, WriteExrChannelInput, WriteExrInput } from '@bb-studio/exr';
import type { ChannelMapping, ChannelDecodeInfo, RawDecodeResult } from '../../services/render/types';

export type ExportSourceMode = 'part' | 'layer' | 'channel' | 'view';
export type ExportCompression = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface BuildExportWriteInputOptions {
  part: ExrPart;
  raw: RawDecodeResult;
  scope: ExportSourceMode;
  compression: ExportCompression;
  layerPrefix?: string;
  channelName?: string;
  displayMapping: ChannelMapping;
  alphaChannelName?: string;
}

export interface BuiltExportWriteInput {
  writeInput: WriteExrInput;
  exportedChannelNames: string[];
  sourceLabel: string;
}

function firstSampleCoordinate(min: number, sampling: number): number {
  if (sampling <= 1) return min;
  const rem = ((min % sampling) + sampling) % sampling;
  return rem === 0 ? min : min + (sampling - rem);
}

function countSamplesInRange(min: number, max: number, sampling: number): number {
  if (sampling <= 0 || max < min) return 0;
  const first = firstSampleCoordinate(min, sampling);
  if (first > max) return 0;
  return Math.floor((max - first) / sampling) + 1;
}

function getLayerPrefix(channelName: string): string {
  const parts = channelName.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : '(root)';
}

export function getPartLayerNames(part: ExrPart): string[] {
  const layers = new Set<string>();
  for (const channel of part.channels) {
    layers.add(getLayerPrefix(channel.name));
  }
  return Array.from(layers).sort((a, b) => a.localeCompare(b));
}

export function getLayerChannelNames(part: ExrPart, layerPrefix: string): string[] {
  const prefix = layerPrefix === '(root)' ? '' : `${layerPrefix}.`;
  return part.channels
    .map((channel) => channel.name)
    .filter((name) => (prefix ? name.startsWith(prefix) : !name.includes('.')))
    .sort((a, b) => a.localeCompare(b));
}

function requireDataWindow(part: ExrPart): ExrWindow {
  if (!part.dataWindow) {
    throw new Error('Selected part is missing dataWindow.');
  }
  return part.dataWindow;
}

function pickSampledData(
  full: Float32Array,
  info: ChannelDecodeInfo | undefined,
  channel: ExrChannel | undefined,
  width: number,
  dataWindow: ExrWindow,
): {
  data: Float32Array;
  xSampling: number;
  ySampling: number;
  pLinear: number;
  pixelType: number;
} {
  const xSampling = info?.xSampling ?? channel?.xSampling ?? 1;
  const ySampling = info?.ySampling ?? channel?.ySampling ?? 1;
  const sampleOriginX = info?.sampleOriginX ?? firstSampleCoordinate(dataWindow.xMin, xSampling);
  const sampleOriginY = info?.sampleOriginY ?? firstSampleCoordinate(dataWindow.yMin, ySampling);
  const sampledWidth =
    info?.sampledWidth ?? countSamplesInRange(dataWindow.xMin, dataWindow.xMax, xSampling);
  const sampledHeight =
    info?.sampledHeight ?? countSamplesInRange(dataWindow.yMin, dataWindow.yMax, ySampling);

  if (
    xSampling === 1 &&
    ySampling === 1 &&
    sampledWidth === width &&
    sampledHeight * width === full.length &&
    sampleOriginX === dataWindow.xMin &&
    sampleOriginY === dataWindow.yMin
  ) {
    return {
      data: full,
      xSampling,
      ySampling,
      pLinear: channel?.pLinear ?? 0,
      pixelType: info?.pixelType ?? channel?.pixelType ?? 2,
    };
  }

  const sampled = new Float32Array(sampledWidth * sampledHeight);
  let outPtr = 0;
  const height = sampledHeight > 0 ? Math.floor(full.length / width) : 0;

  for (let sy = 0; sy < sampledHeight; sy++) {
    const y = sampleOriginY + sy * ySampling;
    const localY = y - dataWindow.yMin;

    for (let sx = 0; sx < sampledWidth; sx++) {
      const x = sampleOriginX + sx * xSampling;
      const localX = x - dataWindow.xMin;
      const inBounds = localX >= 0 && localX < width && localY >= 0 && localY < height;
      sampled[outPtr++] = inBounds ? full[localY * width + localX] : 0;
    }
  }

  return {
    data: sampled,
    xSampling,
    ySampling,
    pLinear: channel?.pLinear ?? 0,
    pixelType: info?.pixelType ?? channel?.pixelType ?? 2,
  };
}

function mapSourcesForScope(
  options: BuildExportWriteInputOptions,
): Array<{ sourceName: string; targetName: string }> {
  const { part, scope, layerPrefix, channelName, displayMapping, alphaChannelName } = options;

  if (scope === 'part') {
    return part.channels.map((channel) => ({ sourceName: channel.name, targetName: channel.name }));
  }

  if (scope === 'layer') {
    if (!layerPrefix) {
      throw new Error('Layer export requires a selected layer.');
    }
    return getLayerChannelNames(part, layerPrefix).map((name) => ({ sourceName: name, targetName: name }));
  }

  if (scope === 'channel') {
    if (!channelName) {
      throw new Error('Channel export requires a selected channel.');
    }
    return [{ sourceName: channelName, targetName: channelName }];
  }

  const viewSources: Array<{ sourceName: string; targetName: string }> = [];
  if (displayMapping.r) viewSources.push({ sourceName: displayMapping.r, targetName: 'R' });
  if (displayMapping.g) viewSources.push({ sourceName: displayMapping.g, targetName: 'G' });
  if (displayMapping.b) viewSources.push({ sourceName: displayMapping.b, targetName: 'B' });
  if (alphaChannelName) viewSources.push({ sourceName: alphaChannelName, targetName: 'A' });

  return viewSources;
}

function getScopeLabel(scope: ExportSourceMode, layerPrefix?: string, channelName?: string): string {
  if (scope === 'part') return 'part';
  if (scope === 'layer') return layerPrefix ? `layer-${layerPrefix}` : 'layer';
  if (scope === 'channel') return channelName ? `channel-${channelName}` : 'channel';
  return 'view';
}

export function buildExportWriteInput(
  options: BuildExportWriteInputOptions,
): BuiltExportWriteInput {
  const { part, raw, scope, compression } = options;
  const dataWindow = requireDataWindow(part);
  const displayWindow = part.displayWindow ?? dataWindow;

  const sourceSpecs = mapSourcesForScope(options);
  if (sourceSpecs.length === 0) {
    throw new Error('No channels are available for the selected export scope.');
  }

  const channels: WriteExrChannelInput[] = [];
  for (const spec of sourceSpecs) {
    const sourceData = raw.channels[spec.sourceName];
    if (!sourceData) {
      throw new Error(`Source channel "${spec.sourceName}" is not available in decoded data.`);
    }

    const sourceInfo = raw.channelInfo?.[spec.sourceName];
    const sourceChannel = part.channels.find((channel) => channel.name === spec.sourceName);

    if (scope === 'view') {
      channels.push({
        name: spec.targetName,
        pixelType: 2,
        pLinear: 0,
        xSampling: 1,
        ySampling: 1,
        data: sourceData,
      });
      continue;
    }

    const sampled = pickSampledData(sourceData, sourceInfo, sourceChannel, raw.width, dataWindow);
    channels.push({
      name: spec.targetName,
      pixelType: sampled.pixelType,
      pLinear: sampled.pLinear,
      xSampling: sampled.xSampling,
      ySampling: sampled.ySampling,
      data: sampled.data,
    });
  }

  return {
    writeInput: {
      parts: [
        {
          compression,
          dataWindow,
          displayWindow,
          channels,
          name: typeof part.attributes.name === 'string' ? part.attributes.name : undefined,
          type: part.type,
        },
      ],
    },
    exportedChannelNames: channels.map((channel) => channel.name),
    sourceLabel: getScopeLabel(scope, options.layerPrefix, options.channelName),
  };
}
