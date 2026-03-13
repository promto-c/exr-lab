import type { ExrChannel } from '@bb-studio/exr';
import type { ChannelMapping } from '../../services/render/types';

export const guessChannels = (channels: ExrChannel[]): ChannelMapping => {
  const map: ChannelMapping = { r: '', g: '', b: '', a: '' };
  const names = channels.map((channel) => channel.name);

  const find = (suffixes: string[]): string | null => {
    for (const suffix of suffixes) {
      const exact = names.find((name) => name === suffix);
      if (exact) return exact;

      const suffixed = names.find(
        (name) => name.endsWith(`.${suffix}`) || name.endsWith(`.${suffix.toUpperCase()}`),
      );
      if (suffixed) return suffixed;
    }

    return null;
  };

  map.r = find(['R', 'r', 'Red', 'red']) || '';
  map.g = find(['G', 'g', 'Green', 'green']) || '';
  map.b = find(['B', 'b', 'Blue', 'blue']) || '';
  map.a = find(['A', 'a', 'Alpha', 'alpha']) || '';

  if (!map.r && !map.g && !map.b && names.length > 0) {
    map.r = names[0];
    map.g = names[1] || names[0];
    map.b = names[2] || names[0];
  }

  return map;
};

export const getLayerMapping = (channels: ExrChannel[], layerPrefix: string): ChannelMapping => {
  const map: ChannelMapping = { r: '', g: '', b: '', a: '' };
  const names = channels.map((channel) => channel.name);

  const prefix = layerPrefix === '(root)' ? '' : `${layerPrefix}.`;
  const find = (suffix: string): string =>
    names.find((name) => name === `${prefix}${suffix}`) || '';

  map.r = find('R') || find('r') || find('X') || find('x') || '';
  map.g = find('G') || find('g') || find('Y') || find('y') || '';
  map.b = find('B') || find('b') || find('Z') || find('z') || '';
  map.a = find('A') || find('a') || '';

  if (!map.r && !map.g && !map.b) {
    const first = names.find((name) => name.startsWith(prefix));
    if (first) {
      map.r = first;
      map.g = first;
      map.b = first;
    }
  }

  return map;
};
