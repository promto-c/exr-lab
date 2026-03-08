import { decodeExrPart } from './decodeExrPart';
import { parseExrStructure } from './parseExrStructure';
import {
  DecodeExrPartOptions,
  DecodedPart,
  ExrBinaryInput,
  ExrStructure,
  ParseExrOptions,
} from '../shared/types';

export interface ReadExrOptions extends ParseExrOptions {
  partId?: number;
  decode?: Omit<DecodeExrPartOptions, 'partId' | 'onEvent'>;
}

export interface ReadExrResult {
  structure: ExrStructure;
  part: DecodedPart;
  partId: number;
}

export function readExr(buffer: ExrBinaryInput, options: ReadExrOptions = {}): ReadExrResult {
  const structure = parseExrStructure(buffer, { onEvent: options.onEvent });
  const partId = options.partId ?? structure.parts[0]?.id ?? 0;

  const part = decodeExrPart(buffer, structure, {
    partId,
    predecodedZipBlocks: options.decode?.predecodedZipBlocks,
    predecodedDwaBlocks: options.decode?.predecodedDwaBlocks,
    onEvent: options.onEvent,
  });

  return {
    structure,
    part,
    partId,
  };
}
