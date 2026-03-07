import { computeHistogram } from './histogram';
import { toneMapToImage } from './cpuToneMap';
import { RenderFrameInput, RenderFrameOutput, Renderer } from './types';

class CpuRenderer implements Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context is unavailable.');
    }
    this.ctx = ctx;
  }

  public getBackend() {
    return 'cpu' as const;
  }

  public resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  public render(input: RenderFrameInput): RenderFrameOutput {
    const t0 = performance.now();
    const { raw, mapping, params } = input;

    this.resize(raw.width, raw.height);

    const imageData = toneMapToImage(raw, mapping, params);
    const histogram = computeHistogram(raw, mapping, params);

    this.ctx.putImageData(new ImageData(imageData, raw.width, raw.height), 0, 0);

    return {
      backend: 'cpu',
      histogram,
      renderMs: performance.now() - t0,
    };
  }

  public dispose() {
    // No resources to release for 2D canvas renderer.
  }
}

export function createCpuRenderer(canvas: HTMLCanvasElement): Renderer {
  return new CpuRenderer(canvas);
}
