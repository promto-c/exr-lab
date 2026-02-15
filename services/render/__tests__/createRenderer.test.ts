import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from '../createRenderer';

function createMockCanvas() {
  const putImageData = vi.fn();

  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => {
      if (kind === 'webgl2') return null;
      if (kind === '2d') {
        return {
          putImageData,
        } as unknown as CanvasRenderingContext2D;
      }
      return null;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  return canvas as unknown as HTMLCanvasElement;
}

describe('createRenderer', () => {
  it('falls back to CPU when WebGL2 is unavailable', () => {
    const selection = createRenderer({
      canvas: createMockCanvas(),
      requested: 'auto',
    });

    expect(selection.backend).toBe('cpu');
    expect(selection.fallbackReason).toContain('WebGL2 unavailable');
    expect(selection.renderer.getBackend()).toBe('cpu');

    selection.renderer.dispose();
  });
});
