import { createCpuRenderer } from './cpuRenderer';
import { createWebGL2Renderer } from './webgl2Renderer';
import { RendererCallbacks, RendererPreference, RendererSelection } from './types';

interface CreateRendererOptions {
  canvas: HTMLCanvasElement;
  requested?: RendererPreference;
  callbacks?: RendererCallbacks;
}

export function getRendererPreferenceFromQuery(search?: string): RendererPreference {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const params = new URLSearchParams(query);
  const value = (params.get('renderer') || 'auto').toLowerCase();

  if (value === 'webgl2' || value === 'cpu' || value === 'auto') {
    return value;
  }

  return 'auto';
}

export function createRenderer(options: CreateRendererOptions): RendererSelection {
  const requested = options.requested ?? getRendererPreferenceFromQuery();

  if (requested === 'cpu') {
    return {
      renderer: createCpuRenderer(options.canvas),
      requested,
      backend: 'cpu',
    };
  }

  try {
    const renderer = createWebGL2Renderer(options.canvas, options.callbacks);
    return {
      renderer,
      requested,
      backend: 'webgl2',
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? `WebGL2 unavailable: ${error.message}`
        : 'WebGL2 unavailable due to unknown error.';

    return {
      renderer: createCpuRenderer(options.canvas),
      requested,
      backend: 'cpu',
      fallbackReason: reason,
    };
  }
}
