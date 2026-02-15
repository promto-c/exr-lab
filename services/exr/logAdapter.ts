import { ExrError, ExrEvent } from '../../core/exr';
import { LogEntry, LogStatus } from '../../types';

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function levelToStatus(level: ExrEvent['level']): LogStatus {
  if (level === 'error') return LogStatus.Error;
  if (level === 'warn') return LogStatus.Warn;
  return LogStatus.Ok;
}

export function mapExrEventToLogEntry(event: ExrEvent): LogEntry {
  return {
    id: uid(event.phase),
    stepId: `${event.phase}.${event.code}`,
    title: event.message,
    status: levelToStatus(event.level),
    ms: typeof event.metrics?.ms === 'string' ? Number(event.metrics.ms) || 0 : 0,
    metrics: Object.entries(event.metrics || {}).map(([label, value]) => ({ label, value })),
    description: event.code,
  };
}

export function mapExrErrorToLogEntry(error: unknown, fallbackStep: string): LogEntry {
  if (error instanceof ExrError) {
    return {
      id: uid('exr-error'),
      stepId: fallbackStep,
      title: 'EXR Error',
      status: LogStatus.Error,
      ms: 0,
      metrics: [
        { label: 'Code', value: error.code },
        ...Object.entries(error.details || {}).map(([label, value]) => ({ label, value })),
      ],
      description: error.message,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    id: uid('error'),
    stepId: fallbackStep,
    title: 'Unexpected Error',
    status: LogStatus.Error,
    ms: 0,
    metrics: [],
    description: message,
  };
}
