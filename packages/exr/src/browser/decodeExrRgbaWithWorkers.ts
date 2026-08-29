import { DecodedExrRgbaImage } from '../reader/decodeExrRgba';
import { decodedPartToRgba } from '../reader/rgbaChannels';
import { inspectExrImage } from '../reader/exrImage';
import { ExrBinaryInput } from '../shared/types';
import {
  DecodeExrPartWithWorkersOptions,
  decodeExrPartWithWorkers,
} from './decodeExrPartWithWorkers';

export type DecodeExrRgbaWithWorkersOptions = Omit<DecodeExrPartWithWorkersOptions, 'partId'> & {
  partId?: number;
};

export async function decodeExrRgbaWithWorkers(
  buffer: ExrBinaryInput,
  options: DecodeExrRgbaWithWorkersOptions = {},
): Promise<DecodedExrRgbaImage> {
  const info = inspectExrImage(buffer, options);
  const decoded = await decodeExrPartWithWorkers(buffer, info.structure, {
    ...options,
    partId: info.partId,
  });
  return {
    width: info.width,
    height: info.height,
    rgba: decodedPartToRgba(info.width, info.height, info.dataWindow, decoded.channels),
    partId: info.partId,
    dataWindow: info.dataWindow,
    displayWindow: info.displayWindow,
    channels: info.part.channels,
    attributes: info.part.attributes,
  };
}
