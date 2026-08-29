import { expandDecodedPartChannels } from './expandSampledChannels';
import { DecodedChannel, ExrWindow } from '../shared/types';

function normalizeChannelName(name: string): string {
  return name.split('.').pop()?.toUpperCase() ?? '';
}

function pickChannel(
  channels: Record<string, Float32Array>,
  aliases: readonly string[],
): Float32Array | undefined {
  for (const alias of aliases) {
    const exact = channels[alias];
    if (exact) return exact;
  }

  const normalizedAliases = new Set(aliases.map((alias) => alias.toUpperCase()));
  for (const [name, channel] of Object.entries(channels)) {
    if (normalizedAliases.has(normalizeChannelName(name))) return channel;
  }
  return undefined;
}

export function decodedPartToRgba(
  width: number,
  height: number,
  dataWindow: ExrWindow,
  channels: Record<string, DecodedChannel>,
): Float32Array {
  const expanded = expandDecodedPartChannels({ width, height, channels }, dataWindow);
  const fallback = Object.values(expanded)[0] ?? new Float32Array(width * height);
  const red = pickChannel(expanded, ['R', 'RED']) ?? fallback;
  const luma = pickChannel(expanded, ['Y', 'LUMA', 'LUMINANCE']);
  const green = pickChannel(expanded, ['G', 'GREEN']) ?? luma ?? red;
  const blue = pickChannel(expanded, ['B', 'BLUE']) ?? luma ?? red;
  const alpha = pickChannel(expanded, ['A', 'ALPHA']);

  const pixelCount = width * height;
  const rgba = new Float32Array(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    rgba[offset] = Number.isFinite(red[index]) ? red[index] : 0;
    rgba[offset + 1] = Number.isFinite(green[index]) ? green[index] : rgba[offset];
    rgba[offset + 2] = Number.isFinite(blue[index]) ? blue[index] : rgba[offset];
    rgba[offset + 3] = alpha ? Math.max(0, alpha[index]) : 1;
  }
  return rgba;
}
