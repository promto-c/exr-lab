import { computeHistogram } from './histogram';
import { RenderFrameInput, RenderFrameOutput, Renderer, RendererCallbacks } from './types';

type ChannelSlot = 'r' | 'g' | 'b' | 'a';

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;
out vec2 vUv;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  vec2 pos = POSITIONS[gl_VertexID];
  vUv = 0.5 * (pos + 1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uR;
uniform sampler2D uG;
uniform sampler2D uB;
uniform sampler2D uA;
uniform float uExposure;
uniform float uInvGamma;

float tone(float value) {
  if (uExposure != 0.0) {
    value *= exp2(uExposure);
  }

  value = max(value, 0.0);

  if (uInvGamma != 1.0) {
    value = pow(value, uInvGamma);
  }

  return clamp(value, 0.0, 1.0);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  float r = tone(texture(uR, uv).r);
  float g = tone(texture(uG, uv).r);
  float b = tone(texture(uB, uv).r);
  float a = clamp(texture(uA, uv).r, 0.0, 1.0);

  outColor = vec4(r, g, b, a);
}
`;

interface SlotUploadState {
  data: Float32Array | null;
  width: number;
  height: number;
}

interface ProgramResources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  uniforms: {
    r: WebGLUniformLocation;
    g: WebGLUniformLocation;
    b: WebGLUniformLocation;
    a: WebGLUniformLocation;
    exposure: WebGLUniformLocation;
    invGamma: WebGLUniformLocation;
  };
}

class WebGL2Renderer implements Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly callbacks?: RendererCallbacks;
  private readonly resources: ProgramResources;
  private readonly channelTextures: Record<ChannelSlot, WebGLTexture>;
  private readonly fallbackZeroTexture: WebGLTexture;
  private readonly fallbackOneTexture: WebGLTexture;
  private readonly slotState: Record<ChannelSlot, SlotUploadState>;

  private width = 0;
  private height = 0;
  private contextLost = false;
  private histogramCache: {
    rawRef: RenderFrameInput['raw'] | null;
    mappingKey: string;
    histogram: number[];
  } = {
    rawRef: null,
    mappingKey: '',
    histogram: new Array(64).fill(0),
  };

  private readonly contextLostHandler = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.callbacks?.onContextLost?.('WebGL context was lost. Falling back to CPU renderer.');
  };

  private readonly contextRestoredHandler = () => {
    this.contextLost = false;
    this.callbacks?.onContextRestored?.();
  };

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, callbacks?: RendererCallbacks) {
    this.canvas = canvas;
    this.gl = gl;
    this.callbacks = callbacks;

    this.resources = this.createProgramResources();

    this.channelTextures = {
      r: this.createFloatTexture(1, 1, new Float32Array([0])),
      g: this.createFloatTexture(1, 1, new Float32Array([0])),
      b: this.createFloatTexture(1, 1, new Float32Array([0])),
      a: this.createFloatTexture(1, 1, new Float32Array([1])),
    };

    this.fallbackZeroTexture = this.createFloatTexture(1, 1, new Float32Array([0]));
    this.fallbackOneTexture = this.createFloatTexture(1, 1, new Float32Array([1]));

    this.slotState = {
      r: { data: null, width: 0, height: 0 },
      g: { data: null, width: 0, height: 0 },
      b: { data: null, width: 0, height: 0 },
      a: { data: null, width: 0, height: 0 },
    };

    this.canvas.addEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler);

    this.gl.useProgram(this.resources.program);
    this.gl.uniform1i(this.resources.uniforms.r, 0);
    this.gl.uniform1i(this.resources.uniforms.g, 1);
    this.gl.uniform1i(this.resources.uniforms.b, 2);
    this.gl.uniform1i(this.resources.uniforms.a, 3);
    this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1);
    this.gl.clearColor(0, 0, 0, 1);
  }

  public getBackend() {
    return 'webgl2' as const;
  }

  public resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.invalidateSlotCache();
    }

    this.gl.viewport(0, 0, width, height);
  }

  public render(input: RenderFrameInput): RenderFrameOutput {
    const t0 = performance.now();
    const { raw, mapping, params } = input;

    const mappingKey = `${mapping.r}|${mapping.g}|${mapping.b}`;
    let histogram = this.histogramCache.histogram;
    if (this.histogramCache.rawRef !== raw || this.histogramCache.mappingKey !== mappingKey) {
      histogram = computeHistogram(raw, mapping);
      this.histogramCache = {
        rawRef: raw,
        mappingKey,
        histogram,
      };
    }

    if (this.contextLost) {
      return {
        backend: 'webgl2',
        histogram,
        renderMs: performance.now() - t0,
      };
    }

    this.resize(raw.width, raw.height);

    const rPlane = mapping.r ? raw.channels[mapping.r] : undefined;
    const gPlane = mapping.g ? raw.channels[mapping.g] : undefined;
    const bPlane = mapping.b ? raw.channels[mapping.b] : undefined;
    const aPlane = mapping.a ? raw.channels[mapping.a] : undefined;

    const textures: Record<ChannelSlot, WebGLTexture> = {
      r: this.uploadChannelIfNeeded('r', rPlane, raw.width, raw.height) ? this.channelTextures.r : this.fallbackZeroTexture,
      g: this.uploadChannelIfNeeded('g', gPlane, raw.width, raw.height) ? this.channelTextures.g : this.fallbackZeroTexture,
      b: this.uploadChannelIfNeeded('b', bPlane, raw.width, raw.height) ? this.channelTextures.b : this.fallbackZeroTexture,
      a: this.uploadChannelIfNeeded('a', aPlane, raw.width, raw.height) ? this.channelTextures.a : this.fallbackOneTexture,
    };

    this.gl.useProgram(this.resources.program);
    this.gl.bindVertexArray(this.resources.vao);

    this.gl.uniform1f(this.resources.uniforms.exposure, params.exposure);
    this.gl.uniform1f(this.resources.uniforms.invGamma, 1.0 / (params.gamma > 0 ? params.gamma : 1.0));

    this.bindTextureToUnit(textures.r, 0);
    this.bindTextureToUnit(textures.g, 1);
    this.bindTextureToUnit(textures.b, 2);
    this.bindTextureToUnit(textures.a, 3);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);

    return {
      backend: 'webgl2',
      histogram,
      renderMs: performance.now() - t0,
    };
  }

  public dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler);

    this.gl.deleteTexture(this.channelTextures.r);
    this.gl.deleteTexture(this.channelTextures.g);
    this.gl.deleteTexture(this.channelTextures.b);
    this.gl.deleteTexture(this.channelTextures.a);
    this.gl.deleteTexture(this.fallbackZeroTexture);
    this.gl.deleteTexture(this.fallbackOneTexture);

    this.gl.deleteVertexArray(this.resources.vao);
    this.gl.deleteProgram(this.resources.program);
  }

  private bindTextureToUnit(texture: WebGLTexture, unit: number) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }

  private uploadChannelIfNeeded(
    slot: ChannelSlot,
    data: Float32Array | undefined,
    width: number,
    height: number,
  ): boolean {
    if (!data) {
      this.slotState[slot] = { data: null, width: 0, height: 0 };
      return false;
    }

    const state = this.slotState[slot];
    if (state.data === data && state.width === width && state.height === height) {
      return true;
    }

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.channelTextures[slot]);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R32F, width, height, 0, this.gl.RED, this.gl.FLOAT, data);

    this.slotState[slot] = { data, width, height };
    return true;
  }

  private createFloatTexture(width: number, height: number, data: Float32Array): WebGLTexture {
    const texture = this.gl.createTexture();
    if (!texture) {
      throw new Error('Failed to create WebGL texture.');
    }

    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R32F, width, height, 0, this.gl.RED, this.gl.FLOAT, data);

    return texture;
  }

  private createProgramResources(): ProgramResources {
    const vertex = this.createShader(this.gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fragment = this.createShader(this.gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);

    const program = this.gl.createProgram();
    if (!program) {
      this.gl.deleteShader(vertex);
      this.gl.deleteShader(fragment);
      throw new Error('Failed to create WebGL program.');
    }

    this.gl.attachShader(program, vertex);
    this.gl.attachShader(program, fragment);
    this.gl.linkProgram(program);

    const linked = this.gl.getProgramParameter(program, this.gl.LINK_STATUS);
    this.gl.deleteShader(vertex);
    this.gl.deleteShader(fragment);

    if (!linked) {
      const log = this.gl.getProgramInfoLog(program) || 'Unknown WebGL linker error.';
      this.gl.deleteProgram(program);
      throw new Error(`Failed to link WebGL program: ${log}`);
    }

    const vao = this.gl.createVertexArray();
    if (!vao) {
      this.gl.deleteProgram(program);
      throw new Error('Failed to create vertex array object.');
    }

    this.gl.bindVertexArray(vao);

    const uniforms = {
      r: this.getUniformLocation(program, 'uR'),
      g: this.getUniformLocation(program, 'uG'),
      b: this.getUniformLocation(program, 'uB'),
      a: this.getUniformLocation(program, 'uA'),
      exposure: this.getUniformLocation(program, 'uExposure'),
      invGamma: this.getUniformLocation(program, 'uInvGamma'),
    };

    return { program, vao, uniforms };
  }

  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) {
      throw new Error('Failed to create shader object.');
    }

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    const compiled = this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS);
    if (!compiled) {
      const log = this.gl.getShaderInfoLog(shader) || 'Unknown shader compilation error.';
      this.gl.deleteShader(shader);
      throw new Error(`Failed to compile shader: ${log}`);
    }

    return shader;
  }

  private getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation {
    const location = this.gl.getUniformLocation(program, name);
    if (!location) {
      throw new Error(`Failed to resolve required uniform: ${name}`);
    }
    return location;
  }

  private invalidateSlotCache() {
    this.slotState.r = { data: null, width: 0, height: 0 };
    this.slotState.g = { data: null, width: 0, height: 0 };
    this.slotState.b = { data: null, width: 0, height: 0 };
    this.slotState.a = { data: null, width: 0, height: 0 };
    this.histogramCache = {
      rawRef: null,
      mappingKey: '',
      histogram: new Array(64).fill(0),
    };
  }
}

export function createWebGL2Renderer(canvas: HTMLCanvasElement, callbacks?: RendererCallbacks): Renderer {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
  });

  if (!gl) {
    throw new Error('WebGL2 context is unavailable.');
  }

  return new WebGL2Renderer(canvas, gl, callbacks);
}
