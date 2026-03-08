export type ExrEventPhase = 'parse' | 'decode' | 'encode';
export type ExrEventLevel = 'info' | 'warn' | 'error';

export const EXR_EVENT_CODES = [
  'parse.magic.invalid',
  'parse.magic.ok',
  'parse.version.ok',
  'parse.part.ok',
  'parse.complete',
  'decode.setup',
  'decode.offsets.read',
  'decode.chunk.part_mismatch',
  'decode.chunk.trailing_bytes',
  'decode.complete',
  'encode.setup',
  'encode.part.complete',
  'encode.complete',
] as const;

export type ExrEventCode = (typeof EXR_EVENT_CODES)[number];

export interface ExrEvent {
  phase: ExrEventPhase;
  level: ExrEventLevel;
  code: ExrEventCode;
  message: string;
  metrics?: Record<string, string | number>;
}

export type ExrEventCallback = (event: ExrEvent) => void;

export interface EventCapableOptions {
  onEvent?: ExrEventCallback;
}
