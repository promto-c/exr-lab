# EXR Core Library (`core/exr`)

Framework-agnostic OpenEXR parser and scanline decoder.

This module is designed to be reusable across apps and does not depend on React or browser DOM APIs.

## What it provides

- `parseExrStructure(buffer, options?)`
- `decodeExrPart(buffer, structure, { partId, onEvent? })`
- Structured diagnostics via `onEvent`
- Typed failures via `ExrError` and `ExrErrorCode`

## Quick start

```ts
import { parseExrStructure, decodeExrPart } from './core/exr';

const file = await fetch('/image.exr').then((r) => r.arrayBuffer());

const structure = parseExrStructure(file);
const part = decodeExrPart(file, structure, { partId: 0 });

console.log(part.width, part.height);
console.log(Object.keys(part.channels));
```

## Parse + decode with diagnostics

```ts
import {
  parseExrStructure,
  decodeExrPart,
  ExrEvent,
} from './core/exr';

function onEvent(event: ExrEvent) {
  console.log(`[${event.phase}] ${event.level} ${event.code}: ${event.message}`, event.metrics);
}

const buffer = await file.arrayBuffer();

const structure = parseExrStructure(buffer, { onEvent });
const decoded = decodeExrPart(buffer, structure, {
  partId: structure.parts[0].id,
  onEvent,
});
```

## Error handling

```ts
import {
  parseExrStructure,
  decodeExrPart,
  isExrError,
} from './core/exr';

try {
  const structure = parseExrStructure(buffer);
  const result = decodeExrPart(buffer, structure, { partId: 0 });
  console.log(result);
} catch (error) {
  if (isExrError(error)) {
    console.error('EXR error code:', error.code);
    console.error('message:', error.message);
    console.error('details:', error.details);
  } else {
    throw error;
  }
}
```

## Parsing guarantees

- Header parsing is strict and fail-fast for malformed known attribute payloads.
- `chlist` channel records are parsed within declared payload bounds and require a valid terminator.
- Unknown attribute types are still skipped safely and retained as placeholder metadata.

## Decoded output shape

`decodeExrPart` returns channels as sampled planes:

```ts
interface DecodedPart {
  width: number;
  height: number;
  channels: Record<string, {
    pixelType: number;
    xSampling: number;
    ySampling: number;
    sampledWidth: number;
    sampledHeight: number;
    sampleOriginX: number;
    sampleOriginY: number;
    data: Float32Array;
  }>;
}
```

If a channel is subsampled (`xSampling > 1` or `ySampling > 1`), `data` stores only sampled values. Consumers can keep sampled data or resample to full resolution.

## Supported today

- Scanline EXR parts
- Compression: `NO_COMPRESSION`, `RLE_COMPRESSION`, `ZIPS_COMPRESSION`, `ZIP_COMPRESSION`, `PIZ_COMPRESSION`, `B44_COMPRESSION`, `B44A_COMPRESSION`, `DWAA_COMPRESSION`, `DWAB_COMPRESSION`
  - Decoder internals use a compression-handler registry so new codecs (for example `PXR24_COMPRESSION`) can be added as new handlers.
- Pixel types: `UINT`, `HALF`, `FLOAT`

## Not supported yet

- Tiled parts
- Deep EXR
