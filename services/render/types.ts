export interface ChannelMapping {
  r: string;
  g: string;
  b: string;
  a: string;
}

export interface ChannelDecodeInfo {
  pixelType: number;
  xSampling: number;
  ySampling: number;
  sampledWidth: number;
  sampledHeight: number;
  sampleOriginX: number;
  sampleOriginY: number;
}

export interface RawDecodeResult {
  width: number;
  height: number;
  channels: Record<string, Float32Array>;
  channelInfo?: Record<string, ChannelDecodeInfo>;
}

export type RenderBackend = 'webgl2' | 'cpu';
export type RendererPreference = 'auto' | RenderBackend;

export interface RenderParams {
  exposure: number;
  gamma: number;
}

export interface RenderFrameInput {
  raw: RawDecodeResult;
  mapping: ChannelMapping;
  params: RenderParams;
}

export interface RenderFrameOutput {
  backend: RenderBackend;
  histogram: number[];
  renderMs: number;
}

export interface Renderer {
  getBackend: () => RenderBackend;
  resize: (width: number, height: number) => void;
  render: (input: RenderFrameInput) => RenderFrameOutput;
  dispose: () => void;
}

export interface RendererCallbacks {
  onContextLost?: (reason: string) => void;
  onContextRestored?: () => void;
}

export interface RendererSelection {
  renderer: Renderer;
  requested: RendererPreference;
  backend: RenderBackend;
  fallbackReason?: string;
}
