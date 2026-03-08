import { PartWriteMeta } from '../meta';
import { encodeB44Chunk } from './b44';
import { encodePizChunk } from './piz';
import { encodePxr24Chunk } from './pxr24';
import { encodeRleChunk } from './rle';
import { encodeZipChunk } from './zip';

export const NO_COMPRESSION = 0;
export const RLE_COMPRESSION = 1;
export const ZIPS_COMPRESSION = 2;
export const ZIP_COMPRESSION = 3;
export const PIZ_COMPRESSION = 4;
export const PXR24_COMPRESSION = 5;
export const B44_COMPRESSION = 6;
export const B44A_COMPRESSION = 7;

export const SUPPORTED_WRITE_COMPRESSION_TEXT = 'NO/RLE/ZIPS/ZIP/PIZ/PXR24/B44/B44A';

export interface WriteCompressionHandler {
  compressionId: number;
  name: string;
  linesPerBlock: number;
  encodeChunk: (raw: Uint8Array, part: PartWriteMeta, chunkY: number) => Uint8Array;
}

const WRITE_COMPRESSION_HANDLERS = new Map<number, WriteCompressionHandler>([
  [
    NO_COMPRESSION,
    {
      compressionId: NO_COMPRESSION,
      name: 'NO_COMPRESSION',
      linesPerBlock: 1,
      encodeChunk: (raw) => raw,
    },
  ],
  [
    RLE_COMPRESSION,
    {
      compressionId: RLE_COMPRESSION,
      name: 'RLE_COMPRESSION',
      linesPerBlock: 1,
      encodeChunk: (raw) => encodeRleChunk(raw),
    },
  ],
  [
    ZIPS_COMPRESSION,
    {
      compressionId: ZIPS_COMPRESSION,
      name: 'ZIPS_COMPRESSION',
      linesPerBlock: 1,
      encodeChunk: (raw) => encodeZipChunk(raw),
    },
  ],
  [
    ZIP_COMPRESSION,
    {
      compressionId: ZIP_COMPRESSION,
      name: 'ZIP_COMPRESSION',
      linesPerBlock: 16,
      encodeChunk: (raw) => encodeZipChunk(raw),
    },
  ],
  [
    PIZ_COMPRESSION,
    {
      compressionId: PIZ_COMPRESSION,
      name: 'PIZ_COMPRESSION',
      linesPerBlock: 32,
      encodeChunk: (raw, part, chunkY) => encodePizChunk(raw, part, chunkY),
    },
  ],
  [
    PXR24_COMPRESSION,
    {
      compressionId: PXR24_COMPRESSION,
      name: 'PXR24_COMPRESSION',
      linesPerBlock: 16,
      encodeChunk: (raw, part, chunkY) => encodePxr24Chunk(raw, part, chunkY),
    },
  ],
  [
    B44_COMPRESSION,
    {
      compressionId: B44_COMPRESSION,
      name: 'B44_COMPRESSION',
      linesPerBlock: 32,
      encodeChunk: (raw, part, chunkY) => encodeB44Chunk(raw, part, chunkY),
    },
  ],
  [
    B44A_COMPRESSION,
    {
      compressionId: B44A_COMPRESSION,
      name: 'B44A_COMPRESSION',
      linesPerBlock: 32,
      encodeChunk: (raw, part, chunkY) => encodeB44Chunk(raw, part, chunkY),
    },
  ],
]);

export function getWriteCompressionHandler(
  compression: number,
): WriteCompressionHandler | undefined {
  return WRITE_COMPRESSION_HANDLERS.get(compression);
}
