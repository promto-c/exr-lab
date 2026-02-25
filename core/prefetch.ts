/**
 * Background frame-prefetch engine for EXR sequences.
 *
 * Modelled after the caching behaviour found in professional VFX review &
 * compositing tools:
 *
 *  • **Forward**   (Nuke / Hiero style) – cache N frames ahead of the
 *    playhead in the playback direction.  Ideal for first-pass review.
 *  • **Bidirectional** (RV / DJV style) – cache in both directions from
 *    the playhead so that scrubbing back and forth is fluid.
 *  • **Full range** – eagerly pre-cache the entire sequence up to the
 *    memory limit (like Nuke's "pre-cache" action).
 *  • **On-demand** (default) – decode frames the user scrubs through in
 *    the background, prioritising the current frame and most-recently
 *    visited frames first.  No speculative look-ahead.
 *
 * The engine runs entirely on the main thread's microtask queue via
 * `async / await` but yields between frames with `setTimeout(0)` to keep
 * the UI responsive.  Heavy I/O (File → ArrayBuffer) and decode are
 * already async by nature.
 *
 * Concurrency:  up to `concurrency` frames can be in-flight at once.
 * Each frame goes through a three-step pipeline:
 *   1. Read file → ArrayBuffer  (buffer cache)
 *   2. Parse → ExrStructure
 *   3. Decode part 0 → RawDecodeResult  (frame cache)
 */

import { ExrCache, FrameDecodeCache } from './cache';
import { ExrParser } from '../services/exrParser';
import { ExrDecoder } from '../services/exr/decoder';
import type { ExrStructure, LogEntry } from '../types';
import type { RawDecodeResult } from '../services/render/types';

// ─── Public types ──────────────────────────────────────────────────────

export type PrefetchStrategy = 'on-demand' | 'forward' | 'bidirectional' | 'full-range';

export const PREFETCH_STRATEGIES: {
  value: PrefetchStrategy;
  label: string;
  description: string;
}[] = [
  {
    value: 'on-demand',
    label: 'On-demand',
    description:
      'Decode frames you scrub through in the background. Prioritises the current frame, then recently visited frames — no speculative look-ahead.',
  },
  {
    value: 'forward',
    label: 'Forward',
    description:
      'Pre-cache frames ahead of the playhead (Nuke / Hiero style). Best for first-pass playback review.',
  },
  {
    value: 'bidirectional',
    label: 'Bidirectional',
    description:
      'Pre-cache frames in both directions from the playhead (RV / DJV style). Best for interactive scrubbing.',
  },
  {
    value: 'full-range',
    label: 'Full range',
    description:
      'Eagerly pre-cache the entire sequence up to the memory limit. Best when RAM is plentiful.',
  },
];

export interface PrefetchFrame {
  id: string;
  file: File;
  name: string;
}

export interface PrefetchEngineConfig {
  /** Reference to the shared ExrCache. */
  cache: ExrCache;
  /** Sequence frames to prefetch from. */
  frames: PrefetchFrame[];
  /** Index of the playhead in `frames`. */
  currentIndex: number;
  /** Active strategy. */
  strategy: PrefetchStrategy;
  /** Maximum number of concurrent in-flight decode pipelines (1–8). */
  concurrency: number;
  /**
   * Recently visited frame indices (most-recent last).
   * Used by 'on-demand' to build its decode queue.
   */
  recentIndices?: number[];
  /** Called whenever a frame finishes caching (buffer or decoded). */
  onProgress: () => void;
  /**
   * Optional log handler.  Prefetch logs are tagged but intentionally
   * lower-priority so they don't spam the main log panel.
   */
  onLog?: (log: LogEntry) => void;
}

// ─── Engine ────────────────────────────────────────────────────────────

/**
 * Each run of the engine is identified by a monotonically-increasing
 * generation.  When configuration changes, `start()` bumps the generation
 * and any in-flight work from the previous generation self-cancels.
 */
export class PrefetchEngine {
  private generation = 0;
  private inflightCount = 0;
  private activePromise: Promise<void> | null = null;

  private cache: ExrCache | null = null;
  private frames: PrefetchFrame[] = [];
  private currentIndex = 0;
  private strategy: PrefetchStrategy = 'on-demand';
  private concurrency = 2;
  private recentIndices: number[] = [];
  private onProgress: (() => void) | null = null;
  private onLog: ((log: LogEntry) => void) | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Re-configure and (re)start the prefetch engine.  Safe to call
   * repeatedly — each call cancels any outstanding work from the
   * previous invocation.
   */
  start(config: PrefetchEngineConfig): void {
    this.generation += 1;
    this.cache = config.cache;
    this.frames = config.frames;
    this.currentIndex = config.currentIndex;
    this.strategy = config.strategy;
    this.concurrency = Math.max(1, Math.min(8, config.concurrency));
    this.recentIndices = config.recentIndices ?? [];
    this.onProgress = config.onProgress;
    this.onLog = config.onLog ?? null;

    if (this.frames.length === 0) {
      return; // nothing to prefetch
    }

    const gen = this.generation;
    this.activePromise = this.runPrefetch(gen);
  }

  /** Cancel all outstanding prefetch work. */
  stop(): void {
    this.generation += 1;
    this.activePromise = null;
  }

  /** True when there are in-flight decode tasks. */
  get isBusy(): boolean {
    return this.inflightCount > 0;
  }

  // ── Priority queue builder ─────────────────────────────────────────

  /**
   * Build a prioritised list of frame indices to prefetch.
   * Already-cached frames are excluded.
   */
  private buildQueue(): number[] {
    const cache = this.cache!;
    const len = this.frames.length;
    const idx = this.currentIndex;

    const indices: number[] = [];

    switch (this.strategy) {
      case 'on-demand': {
        // Current frame first, then recently-visited in reverse order
        // (most-recently-visited = highest priority after current).
        const seen = new Set<number>();
        const maybeAdd = (i: number) => {
          if (i >= 0 && i < len && !seen.has(i) && !cache.hasFrame(this.frames[i].id)) {
            seen.add(i);
            indices.push(i);
          }
        };
        maybeAdd(idx);
        for (let r = this.recentIndices.length - 1; r >= 0; r--) {
          maybeAdd(this.recentIndices[r]);
        }
        break;
      }

      case 'forward': {
        // Ahead of playhead, wrapping around
        for (let step = 1; step < len; step++) {
          const i = (idx + step) % len;
          if (!cache.hasFrame(this.frames[i].id)) indices.push(i);
        }
        break;
      }

      case 'bidirectional': {
        // Alternate ahead / behind in expanding radius
        for (let radius = 1; radius < len; radius++) {
          const ahead = (idx + radius) % len;
          const behind = (idx - radius + len) % len;
          if (!cache.hasFrame(this.frames[ahead].id)) indices.push(ahead);
          if (ahead !== behind && !cache.hasFrame(this.frames[behind].id)) indices.push(behind);
        }
        break;
      }

      case 'full-range': {
        // Sequential from start, but prioritise forward from playhead first
        const ordered: number[] = [];
        for (let step = 0; step < len; step++) {
          ordered.push((idx + step) % len);
        }
        for (const i of ordered) {
          if (!cache.hasFrame(this.frames[i].id)) indices.push(i);
        }
        break;
      }
    }

    return indices;
  }

  // ── Main loop ──────────────────────────────────────────────────────

  private async runPrefetch(gen: number): Promise<void> {
    // Small yield so the caller finishes any synchronous state updates first.
    await yieldToMain();

    if (gen !== this.generation) return;

    const queue = this.buildQueue();
    if (queue.length === 0) return;

    // Process with bounded concurrency using a simple semaphore pattern.
    let queuePos = 0;

    const next = async (): Promise<void> => {
      while (queuePos < queue.length) {
        if (gen !== this.generation) return;

        const frameIdx = queue[queuePos++];
        const frame = this.frames[frameIdx];

        // Skip if someone else cached it in the meantime
        if (this.cache!.hasFrame(frame.id)) continue;

        this.inflightCount++;
        try {
          await this.prefetchSingleFrame(frame, gen);
        } finally {
          this.inflightCount--;
        }
      }
    };

    const workers = Array.from({ length: this.concurrency }, () => next());
    await Promise.all(workers);
  }

  // ── Single frame pipeline ─────────────────────────────────────────

  private async prefetchSingleFrame(frame: PrefetchFrame, gen: number): Promise<void> {
    const cache = this.cache!;

    try {
      // Step 1: buffer
      let buffer = cache.getBuffer(frame.id);
      if (!buffer) {
        buffer = await readFileAsArrayBuffer(frame.file);
        if (gen !== this.generation) return;
        cache.setBuffer(frame.id, buffer);
        this.onProgress?.();
      }

      // If already fully decoded after buffer step (race with main thread)
      if (cache.hasFrame(frame.id)) return;

      // Yield between steps to keep UI responsive
      await yieldToMain();
      if (gen !== this.generation) return;

      // Step 2: parse
      const noopLog = () => {}; // prefetch doesn't spam the log panel
      const parser = new ExrParser(buffer, noopLog);
      const structure = await parser.parse();
      if (!structure || gen !== this.generation) return;

      // Step 3: decode first part (or the part the user last viewed)
      const partId = structure.parts[0]?.id;
      if (partId == null) return;

      await yieldToMain();
      if (gen !== this.generation) return;

      const decoder = new ExrDecoder(buffer, structure, noopLog);
      const rawResult = await decoder.decode({ partId });
      if (!rawResult || gen !== this.generation) return;

      // Commit to cache
      cache.setFrame(frame.id, {
        structure,
        rawPixelData: rawResult,
        partId,
      });

      this.onProgress?.();
    } catch {
      // Swallow errors for background tasks — the frame will simply
      // remain uncached and decode normally when the user visits it.
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Yield to the browser event loop so UI stays responsive. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Read a File into an ArrayBuffer. */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        resolve(event.target.result as ArrayBuffer);
      } else {
        reject(new Error(`Failed to read "${file.name}".`));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Failed to read "${file.name}".`));
    };
    reader.readAsArrayBuffer(file);
  });
}
