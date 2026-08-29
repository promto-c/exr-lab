import { ExrError } from '../shared/errors';
import {
  ExrCompression,
  ExrWindow,
  WriteExrAttribute,
  WriteExrChannelInput,
} from '../shared/types';
import { writeExr } from './writeExr';

export type ExrRgbaPrecision = 'half' | 'float';

export interface ExrRgbaNamedChannel {
  name: string;
  data: Float32Array;
  precision?: ExrRgbaPrecision;
}

export interface EncodeExrRgbaImage {
  width: number;
  height: number;
  rgba: Float32Array;
  namedChannels?: readonly ExrRgbaNamedChannel[];
  dataWindow?: ExrWindow;
  displayWindow?: ExrWindow;
}

export interface EncodeExrRgbaOptions {
  precision: ExrRgbaPrecision;
  includeAlpha: boolean;
  includeColorChannels?: boolean;
  compression?: ExrCompression | number;
  attributes?: Readonly<Record<string, WriteExrAttribute>>;
}

function pixelTypeForPrecision(precision: ExrRgbaPrecision): 1 | 2 {
  return precision === 'half' ? 1 : 2;
}

function extractRgbaChannel(rgba: Float32Array, offset: number): Float32Array {
  const data = new Float32Array(rgba.length / 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = rgba[index * 4 + offset];
  }
  return data;
}

function resolveDataWindow(image: EncodeExrRgbaImage): ExrWindow {
  const dataWindow = image.dataWindow ?? {
    xMin: 0,
    yMin: 0,
    xMax: image.width - 1,
    yMax: image.height - 1,
  };
  const width = dataWindow.xMax - dataWindow.xMin + 1;
  const height = dataWindow.yMax - dataWindow.yMin + 1;
  if (width !== image.width || height !== image.height) {
    throw new ExrError(
      'INVALID_WRITE_INPUT',
      'RGBA image dimensions do not match the EXR data window.',
      {
        width: image.width,
        height: image.height,
        dataWindowWidth: width,
        dataWindowHeight: height,
      },
    );
  }
  return dataWindow;
}

function appendNamedChannels(channels: WriteExrChannelInput[], image: EncodeExrRgbaImage): void {
  const pixelCount = image.width * image.height;
  const names = new Set(channels.map((channel) => channel.name));
  for (const namedChannel of image.namedChannels ?? []) {
    const name = namedChannel.name.trim();
    if (!name || name.includes('\0')) {
      throw new ExrError('INVALID_WRITE_INPUT', 'OpenEXR named channels require a valid name.');
    }
    if (names.has(name)) {
      throw new ExrError('INVALID_WRITE_INPUT', `OpenEXR channel name "${name}" is duplicated.`);
    }
    if (namedChannel.data.length !== pixelCount) {
      throw new ExrError(
        'INVALID_WRITE_INPUT',
        `OpenEXR channel "${name}" data length does not match the image dimensions.`,
        { expected: pixelCount, actual: namedChannel.data.length },
      );
    }
    names.add(name);
    channels.push({
      name,
      pixelType: pixelTypeForPrecision(namedChannel.precision ?? 'float'),
      data: namedChannel.data,
    });
  }
}

export function encodeExrRgba(
  image: EncodeExrRgbaImage,
  options: EncodeExrRgbaOptions,
): Uint8Array {
  const pixelCount = image.width * image.height;
  if (image.width <= 0 || image.height <= 0 || image.rgba.length !== pixelCount * 4) {
    throw new ExrError(
      'INVALID_WRITE_INPUT',
      'OpenEXR RGBA data length does not match the image dimensions.',
      { width: image.width, height: image.height, actual: image.rgba.length },
    );
  }

  const pixelType = pixelTypeForPrecision(options.precision);
  const channels: WriteExrChannelInput[] = [];
  if (options.includeColorChannels !== false) {
    channels.push(
      { name: 'R', pixelType, data: extractRgbaChannel(image.rgba, 0) },
      { name: 'G', pixelType, data: extractRgbaChannel(image.rgba, 1) },
      { name: 'B', pixelType, data: extractRgbaChannel(image.rgba, 2) },
    );
  }
  if (options.includeAlpha) {
    channels.push({ name: 'A', pixelType, data: extractRgbaChannel(image.rgba, 3) });
  }
  appendNamedChannels(channels, image);
  if (channels.length === 0) {
    throw new ExrError('INVALID_WRITE_INPUT', 'OpenEXR export requires at least one channel.');
  }

  return writeExr({
    parts: [
      {
        compression: options.compression ?? 3,
        dataWindow: resolveDataWindow(image),
        ...(image.displayWindow ? { displayWindow: image.displayWindow } : {}),
        channels,
        ...(options.attributes ? { attributes: options.attributes } : {}),
      },
    ],
  });
}
