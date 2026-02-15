export type ExrEventPhase = 'parse' | 'decode';
export type ExrEventLevel = 'info' | 'warn' | 'error';

export interface ExrEvent {
  phase: ExrEventPhase;
  level: ExrEventLevel;
  code: string;
  message: string;
  metrics?: Record<string, string | number>;
}

export type ExrEventCallback = (event: ExrEvent) => void;

export interface EventCapableOptions {
  onEvent?: ExrEventCallback;
}
