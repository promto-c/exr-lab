# @bb-studio/exr

[![npm version](https://img.shields.io/npm/v/%40bb-studio%2Fexr?logo=npm)](https://www.npmjs.com/package/@bb-studio/exr)
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20Demo-0?logo=github)](https://promto-c.github.io/exr-lab/)
[![GitHub](https://img.shields.io/github/stars/promto-c/exr-lab)](https://github.com/promto-c/exr-lab)

OpenEXR scanline parser/decoder/encoder and backend-neutral RGBA helpers for browser and Node.js.

## Install

```bash
npm install @bb-studio/exr
```

## Image API

```ts
import { decodeExrRgba, encodeExrRgba, inspectExrImage } from '@bb-studio/exr';

const info = inspectExrImage(buffer);
const image = decodeExrRgba(buffer);
const encodedImage = encodeExrRgba(
  { width: image.width, height: image.height, rgba: image.rgba },
  { precision: 'half', includeAlpha: true },
);
```

`decodeExrRgba` selects the requested part, or the first part with a data window, expands sampled channels, and resolves conventional RGB/A names including layered suffixes and Y/luma fallback. The result retains data/display windows, channel descriptors, and part attributes.

`encodeExrRgba` accepts straight `Float32Array` RGBA pixels plus optional named channels, typed attributes, compression, and non-zero data/display windows. It returns EXR bytes and has no Blob, renderer, or platform dependency.

## Core API

```ts
import { parseExr, decodeExrPart, readExr, writeExr } from '@bb-studio/exr';

const buffer = await fetch('/image.exr').then((r) => r.arrayBuffer());
const structure = parseExr(buffer);
const decoded = decodeExrPart(buffer, structure, { partId: structure.parts[0].id });

// Convenience parse+decode in one call
const result = readExr(buffer);

// Encode scanline EXR
const encoded = writeExr({
  parts: [
    {
      compression: 3, // ZIP
      dataWindow: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
      channels: [{ name: 'R', pixelType: 2, data: new Float32Array([0, 1, 2, 3]) }],
    },
  ],
});
```

Each part may also provide typed `string`, `int`, `float`, or `chromaticities` attributes:

```ts
const attributes = {
  ocioColorSpace: { type: 'string', value: 'ACEScg' },
  chromaticities: {
    type: 'chromaticities',
    value: {
      redX: 0.713,
      redY: 0.293,
      greenX: 0.165,
      greenY: 0.83,
      blueX: 0.128,
      blueY: 0.044,
      whiteX: 0.32168,
      whiteY: 0.33767,
    },
  },
} as const;
```

`decodeExrPart` returns sampled-native channel planes with sampling metadata.

## Browser Worker Helpers

```ts
import { decodeExrPartWithWorkers, expandDecodedPartChannels } from '@bb-studio/exr/browser';
```

- `decodeExrPartWithWorkers` optionally pre-decodes ZIP/DWA chunks using workers.
- `decodeExrRgbaWithWorkers` applies the same RGBA semantics through the worker-assisted path.
- `expandDecodedPartChannels` is available from the root package and remains re-exported here for existing browser consumers.

## Error/Diagnostics

- Typed failures via `ExrError` and `ExrErrorCode`.
- Structured progress events via `onEvent` callbacks (`ExrEvent`, `ExrEventCode`).

## Writer Support

- Scanline single-part and multipart writing.
- Compression: `NO_COMPRESSION`, `RLE_COMPRESSION`, `ZIPS_COMPRESSION`, `ZIP_COMPRESSION`, `PIZ_COMPRESSION`, `PXR24_COMPRESSION`, `B44_COMPRESSION`, `B44A_COMPRESSION`.
- Pixel types: `UINT`, `HALF`, `FLOAT`.

## License

- Package license: MIT ([`LICENSE`](./LICENSE))
- Third-party dependency notices: [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)
