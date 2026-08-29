import { decodeExrPart } from './decodeExrPart';
import { inspectExrImage } from './exrImage';
import { decodedPartToRgba } from './rgbaChannels';
import {
  DecodeExrPartOptions,
  ExrBinaryInput,
  ExrChannel,
  ExrWindow,
  ParseExrOptions,
} from '../shared/types';

export interface DecodeExrRgbaOptions extends ParseExrOptions {
  partId?: number;
  decode?: Omit<DecodeExrPartOptions, 'partId' | 'onEvent'>;
}

export interface DecodedExrRgbaImage {
  width: number;
  height: number;
  rgba: Float32Array;
  partId: number;
  dataWindow: ExrWindow;
  displayWindow?: ExrWindow;
  channels: readonly ExrChannel[];
  attributes: Readonly<Record<string, unknown>>;
}

export function decodeExrRgba(
  buffer: ExrBinaryInput,
  options: DecodeExrRgbaOptions = {},
): DecodedExrRgbaImage {
  const info = inspectExrImage(buffer, options);
  const decoded = decodeExrPart(buffer, info.structure, {
    partId: info.partId,
    predecodedZipBlocks: options.decode?.predecodedZipBlocks,
    predecodedDwaBlocks: options.decode?.predecodedDwaBlocks,
    onEvent: options.onEvent,
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
