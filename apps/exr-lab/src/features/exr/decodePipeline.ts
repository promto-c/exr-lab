import {
  parseExr,
  type DecodeExrPartOptions,
  type ExrStructure,
  type ParseExrOptions,
} from '@bb-studio/exr';
import { decodeExrPartWithWorkers } from '@bb-studio/exr/browser';
import { toRawDecodeResult } from './decodeToRaw';
import type { RawDecodeResult } from '../../services/render/types';

type ParseEventHandler = NonNullable<ParseExrOptions['onEvent']>;
type DecodeEventHandler = NonNullable<DecodeExrPartOptions['onEvent']>;

export const parseExrStructure = (buffer: ArrayBuffer, onEvent?: ParseEventHandler): ExrStructure =>
  parseExr(buffer, onEvent ? { onEvent } : undefined);

export const decodeExrPartToRaw = async (
  fileBuffer: ArrayBuffer,
  structure: ExrStructure,
  partId: number,
  onEvent?: DecodeEventHandler,
): Promise<RawDecodeResult> => {
  const part = structure.parts.find((candidate) => candidate.id === partId);
  if (!part) {
    throw new Error(`Part ${partId} was not found.`);
  }

  const decoded = await decodeExrPartWithWorkers(fileBuffer, structure, {
    partId,
    ...(onEvent ? { onEvent } : {}),
  });

  return toRawDecodeResult(decoded, part);
};
