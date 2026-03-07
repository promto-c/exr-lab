# @blackboard/exr-reader

Production-grade OpenEXR scanline parser/decoder for browser and Node.js.

## Install

```bash
npm install @blackboard/exr-reader
```

## Core API

```ts
import { parseExr, decodeExrPart, readExr } from '@blackboard/exr-reader';

const buffer = await fetch('/image.exr').then((r) => r.arrayBuffer());
const structure = parseExr(buffer);
const decoded = decodeExrPart(buffer, structure, { partId: structure.parts[0].id });

// Convenience parse+decode in one call
const result = readExr(buffer);
```

`decodeExrPart` returns sampled-native channel planes with sampling metadata.

## Browser Worker Helpers

```ts
import {
  decodeExrPartWithWorkers,
  expandDecodedPartChannels,
} from '@blackboard/exr-reader/browser';
```

- `decodeExrPartWithWorkers` optionally pre-decodes ZIP/DWA chunks using workers.
- `expandDecodedPartChannels` converts sampled channels into full-resolution planes.

## Error/Diagnostics

- Typed failures via `ExrError` and `ExrErrorCode`.
- Structured progress events via `onEvent` callbacks (`ExrEvent`, `ExrEventCode`).
