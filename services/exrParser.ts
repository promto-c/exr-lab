import { ExrStructure, parseExrStructure } from '../core/exr';
import { LogEntry } from '../types';
import { mapExrErrorToLogEntry, mapExrEventToLogEntry } from './exr/logAdapter';

export class ExrParser {
  constructor(
    private readonly buffer: ArrayBuffer,
    private readonly onLog: (log: LogEntry) => void,
  ) {}

  public async parse(): Promise<ExrStructure | null> {
    try {
      return parseExrStructure(this.buffer, {
        onEvent: (event) => this.onLog(mapExrEventToLogEntry(event)),
      });
    } catch (error) {
      this.onLog(mapExrErrorToLogEntry(error, 'parse.error'));
      return null;
    }
  }
}
