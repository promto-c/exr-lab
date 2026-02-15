export type ExrErrorCode =
  | 'BUFFER_TOO_SMALL'
  | 'INVALID_MAGIC'
  | 'TRUNCATED_FILE'
  | 'MALFORMED_HEADER'
  | 'PART_NOT_FOUND'
  | 'UNSUPPORTED_PART_TYPE'
  | 'UNSUPPORTED_COMPRESSION'
  | 'MISSING_DATA_WINDOW'
  | 'MALFORMED_OFFSET_TABLE'
  | 'MALFORMED_CHUNK'
  | 'DECOMPRESSION_FAILED';

export class ExrError extends Error {
  public readonly code: ExrErrorCode;
  public readonly details?: Record<string, string | number>;

  constructor(code: ExrErrorCode, message: string, details?: Record<string, string | number>) {
    super(message);
    this.name = 'ExrError';
    this.code = code;
    this.details = details;
  }
}

export function isExrError(value: unknown): value is ExrError {
  return value instanceof ExrError;
}
