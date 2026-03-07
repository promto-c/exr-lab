import { EventCapableOptions } from './events';
import { ExrBinaryInput } from './binary';

export type ExrPixelType = 0 | 1 | 2;
export type ExrCompression = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type { ExrBinaryInput };

export interface ExrChannel {
  name: string;
  pixelType: ExrPixelType | number;
  pLinear: number;
  xSampling: number;
  ySampling: number;
}

export interface ExrWindow {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface ExrPart {
  id: number;
  attributes: Record<string, unknown>;
  channels: ExrChannel[];
  dataWindow?: ExrWindow;
  displayWindow?: ExrWindow;
  compression?: ExrCompression | number;
  type?: string;
}

export interface ExrStructure {
  magic: number;
  version: number;
  flags: number;
  isMultipart: boolean;
  parts: ExrPart[];
  headerEndOffset: number;
}

export type ParseExrOptions = EventCapableOptions;

export interface DecodeExrPartOptions extends EventCapableOptions {
  partId: number;
  predecodedZipBlocks?: Map<number, Uint8Array>;
  predecodedDwaBlocks?: Map<number, Uint8Array>;
}

export interface DecodedChannel {
  pixelType: number;
  xSampling: number;
  ySampling: number;
  sampledWidth: number;
  sampledHeight: number;
  sampleOriginX: number;
  sampleOriginY: number;
  data: Float32Array;
}

export interface DecodedPart {
  width: number;
  height: number;
  channels: Record<string, DecodedChannel>;
}
