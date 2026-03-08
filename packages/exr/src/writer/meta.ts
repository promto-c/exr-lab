import { ExrWindow } from '../shared/types';

export interface ChannelWriteMeta {
  name: string;
  pixelType: 0 | 1 | 2;
  pLinear: number;
  xSampling: number;
  ySampling: number;
  sampleOriginX: number;
  sampleOriginY: number;
  sampledWidth: number;
  sampledHeight: number;
  rowByteLength: number;
  data: Float32Array;
}

export interface PartWriteMeta {
  id: number;
  compression: number;
  dataWindow: ExrWindow;
  displayWindow: ExrWindow;
  name: string;
  type: string;
  channels: ChannelWriteMeta[];
  linesPerBlock: number;
  chunkCount: number;
  includeNameAttribute: boolean;
  includeTypeAttribute: boolean;
}
