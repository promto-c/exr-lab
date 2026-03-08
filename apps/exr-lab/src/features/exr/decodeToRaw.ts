import { DecodedPart, ExrPart } from '@blackboard/exr';
import { expandDecodedPartChannels } from '@blackboard/exr/browser';
import { RawDecodeResult } from '../../services/render/types';

export function toRawDecodeResult(decoded: DecodedPart, part: ExrPart): RawDecodeResult {
  if (!part.dataWindow) {
    throw new Error('Part dataWindow is missing.');
  }

  const channels = expandDecodedPartChannels(decoded, part.dataWindow);
  const channelInfo: NonNullable<RawDecodeResult['channelInfo']> = {};

  for (const [name, channel] of Object.entries(decoded.channels)) {
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
}
