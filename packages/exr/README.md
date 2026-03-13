# @bb-studio/exr

Production-grade OpenEXR scanline parser/decoder for browser and Node.js.

## Install

```bash
npm install @bb-studio/exr
```

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

`decodeExrPart` returns sampled-native channel planes with sampling metadata.

## Browser Worker Helpers

```ts
import {
  decodeExrPartWithWorkers,
  expandDecodedPartChannels,
} from '@bb-studio/exr/browser';
```

- `decodeExrPartWithWorkers` optionally pre-decodes ZIP/DWA chunks using workers.
- `expandDecodedPartChannels` converts sampled channels into full-resolution planes.

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
