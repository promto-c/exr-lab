import { EventCapableOptions } from './events';

export type ExrPixelType = 0 | 1 | 2;

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
  compression?: number;
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

export interface ParseExrOptions extends EventCapableOptions {}

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
