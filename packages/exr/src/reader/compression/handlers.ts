import { COMPRESSION_NAMES } from '../../shared/constants';
import { decodeB44Block } from './b44';
import { decodeDwaBlock } from './dwa';
import { decodePizBlock } from './piz';
import { decodePxr24Block } from './pxr24';
import { decodeRleBlock } from './rle';
import { getScanlineLinesPerBlock } from './scanline';
import { decodeZipStyleBlock, ZipDecodeScratch, ZipStyleDecodeContext } from './zip';

export type ReadCompressionDecodeContext = ZipStyleDecodeContext;
export type { ZipDecodeScratch };

export interface ReadCompressionHandler {
  compressionId: number;
  name: string;
  linesPerBlock: number;
  decodeBlock: (context: ReadCompressionDecodeContext) => Uint8Array;
}

const READ_COMPRESSION_HANDLERS = new Map<number, ReadCompressionHandler>([
  [
    0,
    {
      compressionId: 0,
      name: COMPRESSION_NAMES[0],
      linesPerBlock: getScanlineLinesPerBlock(0),
      decodeBlock: ({ buffer, dataPtr, dataSize }) => new Uint8Array(buffer, dataPtr, dataSize),
    },
  ],
  [
    1,
    {
      compressionId: 1,
      name: COMPRESSION_NAMES[1],
      linesPerBlock: getScanlineLinesPerBlock(1),
      decodeBlock: decodeRleBlock,
    },
  ],
  [
    2,
    {
      compressionId: 2,
      name: COMPRESSION_NAMES[2],
      linesPerBlock: getScanlineLinesPerBlock(2),
      decodeBlock: decodeZipStyleBlock,
    },
  ],
  [
    3,
    {
      compressionId: 3,
      name: COMPRESSION_NAMES[3],
      linesPerBlock: getScanlineLinesPerBlock(3),
      decodeBlock: decodeZipStyleBlock,
    },
  ],
  [
    4,
    {
      compressionId: 4,
      name: COMPRESSION_NAMES[4],
      linesPerBlock: getScanlineLinesPerBlock(4),
      decodeBlock: decodePizBlock,
    },
  ],
  [
    5,
    {
      compressionId: 5,
      name: COMPRESSION_NAMES[5],
      linesPerBlock: getScanlineLinesPerBlock(5),
      decodeBlock: decodePxr24Block,
    },
  ],
  [
    6,
    {
      compressionId: 6,
      name: COMPRESSION_NAMES[6],
      linesPerBlock: getScanlineLinesPerBlock(6),
      decodeBlock: decodeB44Block,
    },
  ],
  [
    7,
    {
      compressionId: 7,
      name: COMPRESSION_NAMES[7],
      linesPerBlock: getScanlineLinesPerBlock(7),
      decodeBlock: decodeB44Block,
    },
  ],
  [
    8,
    {
      compressionId: 8,
      name: COMPRESSION_NAMES[8],
      linesPerBlock: getScanlineLinesPerBlock(8),
      decodeBlock: decodeDwaBlock,
    },
  ],
  [
    9,
    {
      compressionId: 9,
      name: COMPRESSION_NAMES[9],
      linesPerBlock: getScanlineLinesPerBlock(9),
      decodeBlock: decodeDwaBlock,
    },
  ],
]);

export function getReadCompressionHandler(compression: number): ReadCompressionHandler | undefined {
  return READ_COMPRESSION_HANDLERS.get(compression);
}

export function getSupportedReadCompressionText(): string {
  return Array.from(READ_COMPRESSION_HANDLERS.values())
    .map((handler) => handler.name)
    .join(', ');
}
