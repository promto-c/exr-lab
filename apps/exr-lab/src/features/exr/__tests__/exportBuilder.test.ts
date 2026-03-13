import { describe, expect, it } from 'vitest';
import type { ExrPart } from '@bb-studio/exr';
import type { RawDecodeResult } from '../../../services/render/types';
import { buildExportWriteInput, getLayerChannelNames, getPartLayerNames } from '../exportBuilder';

const buildPart = (): ExrPart => ({
  id: 0,
  attributes: {},
  compression: 0,
  dataWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 3 },
  displayWindow: { xMin: 0, yMin: 0, xMax: 3, yMax: 3 },
  channels: [
    { name: 'beauty.R', pixelType: 2, pLinear: 0, xSampling: 1, ySampling: 1 },
    { name: 'beauty.G', pixelType: 2, pLinear: 0, xSampling: 1, ySampling: 1 },
    { name: 'depth.Z', pixelType: 2, pLinear: 0, xSampling: 1, ySampling: 1 },
    { name: 'sub.S', pixelType: 2, pLinear: 0, xSampling: 2, ySampling: 2 },
  ],
});

const buildRaw = (): RawDecodeResult => ({
  width: 4,
  height: 4,
  channels: {
    'beauty.R': new Float32Array(Array.from({ length: 16 }, (_, i) => i)),
    'beauty.G': new Float32Array(Array.from({ length: 16 }, (_, i) => i + 100)),
    'depth.Z': new Float32Array(Array.from({ length: 16 }, (_, i) => i + 200)),
    'sub.S': new Float32Array(Array.from({ length: 16 }, (_, i) => i)),
  },
  channelInfo: {
    'beauty.R': {
      pixelType: 2,
      xSampling: 1,
      ySampling: 1,
      sampledWidth: 4,
      sampledHeight: 4,
      sampleOriginX: 0,
      sampleOriginY: 0,
    },
    'beauty.G': {
      pixelType: 2,
      xSampling: 1,
      ySampling: 1,
      sampledWidth: 4,
      sampledHeight: 4,
      sampleOriginX: 0,
      sampleOriginY: 0,
    },
    'depth.Z': {
      pixelType: 2,
      xSampling: 1,
      ySampling: 1,
      sampledWidth: 4,
      sampledHeight: 4,
      sampleOriginX: 0,
      sampleOriginY: 0,
    },
    'sub.S': {
      pixelType: 2,
      xSampling: 2,
      ySampling: 2,
      sampledWidth: 2,
      sampledHeight: 2,
      sampleOriginX: 0,
      sampleOriginY: 0,
    },
  },
});

describe('exportBuilder', () => {
  it('lists layers and channels by prefix', () => {
    const part = buildPart();
    expect(getPartLayerNames(part)).toEqual(['beauty', 'depth', 'sub']);
    expect(getLayerChannelNames(part, 'beauty')).toEqual(['beauty.G', 'beauty.R']);
  });

  it('builds a sampled channel export preserving sampling metadata', () => {
    const part = buildPart();
    const raw = buildRaw();

    const result = buildExportWriteInput({
      part,
      raw,
      scope: 'channel',
      channelName: 'sub.S',
      compression: 0,
      displayMapping: { r: '', g: '', b: '', a: '' },
    });

    const channel = result.writeInput.parts[0].channels[0];
    expect(channel.name).toBe('sub.S');
    expect(channel.xSampling).toBe(2);
    expect(channel.ySampling).toBe(2);
    expect(Array.from(channel.data)).toEqual([0, 2, 8, 10]);
  });

  it('builds layer and view exports with expected channel names', () => {
    const part = buildPart();
    const raw = buildRaw();

    const layerResult = buildExportWriteInput({
      part,
      raw,
      scope: 'layer',
      layerPrefix: 'beauty',
      compression: 3,
      displayMapping: { r: '', g: '', b: '', a: '' },
    });

    expect(layerResult.exportedChannelNames).toEqual(['beauty.G', 'beauty.R']);

    const viewResult = buildExportWriteInput({
      part,
      raw,
      scope: 'view',
      compression: 1,
      displayMapping: { r: 'beauty.R', g: 'beauty.G', b: 'depth.Z', a: '' },
      alphaChannelName: 'depth.Z',
    });

    expect(viewResult.exportedChannelNames).toEqual(['R', 'G', 'B', 'A']);
  });
});
