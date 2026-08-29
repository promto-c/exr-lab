import { ExrError } from '../shared/errors';
import { ExrBinaryInput, ExrPart, ExrStructure, ExrWindow, ParseExrOptions } from '../shared/types';
import { parseExrStructure } from './parseExrStructure';

export interface ExrImageInfo {
  structure: ExrStructure;
  part: ExrPart;
  partId: number;
  width: number;
  height: number;
  dataWindow: ExrWindow;
  displayWindow?: ExrWindow;
}

export interface InspectExrImageOptions extends ParseExrOptions {
  partId?: number;
}

export function selectExrImagePart(structure: ExrStructure, partId?: number): ExrPart {
  if (partId !== undefined) {
    const part = structure.parts.find((candidate) => candidate.id === partId);
    if (!part) {
      throw new ExrError('PART_NOT_FOUND', `Part ${partId} was not found in EXR structure.`, {
        partId,
      });
    }
    if (!part.dataWindow) {
      throw new ExrError('MISSING_DATA_WINDOW', `Part ${partId} is missing a data window.`, {
        partId,
      });
    }
    return part;
  }

  const part = structure.parts.find((candidate) => candidate.dataWindow);
  if (!part?.dataWindow) {
    throw new ExrError(
      'MISSING_DATA_WINDOW',
      'EXR file does not contain a decodable scanline part.',
    );
  }
  return part;
}

export function getExrPartDimensions(part: ExrPart): { width: number; height: number } {
  if (!part.dataWindow) {
    throw new ExrError('MISSING_DATA_WINDOW', `Part ${part.id} is missing a data window.`, {
      partId: part.id,
    });
  }
  return {
    width: part.dataWindow.xMax - part.dataWindow.xMin + 1,
    height: part.dataWindow.yMax - part.dataWindow.yMin + 1,
  };
}

export function inspectExrImage(
  buffer: ExrBinaryInput,
  options: InspectExrImageOptions = {},
): ExrImageInfo {
  const structure = parseExrStructure(buffer, { onEvent: options.onEvent });
  const part = selectExrImagePart(structure, options.partId);
  const dimensions = getExrPartDimensions(part);
  return {
    structure,
    part,
    partId: part.id,
    ...dimensions,
    dataWindow: part.dataWindow!,
    displayWindow: part.displayWindow,
  };
}
