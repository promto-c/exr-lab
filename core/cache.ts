import { RawDecodeResult, ChannelMapping } from '../services/render/types';
import { ExrStructure, CacheStats } from '../types';

export type FrameDecodeCache = {
  rawPixelData: RawDecodeResult;
  structure: ExrStructure;
  partId: number;
};

export type CachePolicy = 'oldest' | 'distance';

export class ExrCache {
  private partCache = new Map<number, RawDecodeResult>();
  private frameCache = new Map<string, FrameDecodeCache>();
  private bufferCache = new Map<string, ArrayBuffer>();

  private maxCacheMB: number = 4096;
  private policy: CachePolicy = 'oldest';
  private distance: number = 64;

  public setMaxCacheMB(mb: number) {
    this.maxCacheMB = mb;
  }

  public setPolicy(policy: CachePolicy) {
    this.policy = policy;
  }

  public setDistance(distance: number) {
    this.distance = distance;
  }

  public getPart(partId: number): RawDecodeResult | undefined {
    const val = this.partCache.get(partId);
    if (val !== undefined) {
      this.partCache.delete(partId);
      this.partCache.set(partId, val);
    }
    return val;
  }

  public setPart(partId: number, raw: RawDecodeResult) {
    this.partCache.set(partId, raw);
  }

  public getFrame(frameId: string): FrameDecodeCache | undefined {
    const val = this.frameCache.get(frameId);
    if (val !== undefined) {
      this.frameCache.delete(frameId);
      this.frameCache.set(frameId, val);
    }
    return val;
  }

  public setFrame(frameId: string, frame: FrameDecodeCache) {
    this.frameCache.set(frameId, frame);
  }

  public getBuffer(frameId: string): ArrayBuffer | undefined {
    const val = this.bufferCache.get(frameId);
    if (val !== undefined) {
      this.bufferCache.delete(frameId);
      this.bufferCache.set(frameId, val);
    }
    return val;
  }

  public setBuffer(frameId: string, buffer: ArrayBuffer) {
    this.bufferCache.set(frameId, buffer);
  }

  public hasFrame(frameId: string): boolean {
    return this.frameCache.has(frameId);
  }

  public clearPartCache() {
    this.partCache.clear();
  }

  public clearFrameCache() {
    this.frameCache.clear();
  }

  public clearBufferCache() {
    this.bufferCache.clear();
  }

  public clearAll() {
    this.partCache.clear();
    this.frameCache.clear();
    this.bufferCache.clear();
  }

  public getFrameCacheSize(): number {
    return this.frameCache.size;
  }

  public deleteOldestFrame() {
    const oldest = this.frameCache.keys().next().value;
    if (oldest !== undefined) {
      this.frameCache.delete(oldest);
    }
  }

  public getFrameCacheKeys(): string[] {
    return Array.from(this.frameCache.keys());
  }

  private estimateRawBytes(raw: RawDecodeResult): number {
    let bytes = 0;
    for (const channel of Object.values(raw.channels)) {
      bytes += channel.byteLength;
    }
    return bytes;
  }

  private collectRawBuffers(raw: RawDecodeResult, buffers: Set<ArrayBufferLike>): number {
    let bytes = 0;
    for (const channel of Object.values(raw.channels)) {
      const buffer = channel.buffer;
      if (!buffers.has(buffer)) {
        buffers.add(buffer);
        bytes += buffer.byteLength;
      }
    }
    return bytes;
  }

  private getUniqueCacheBytes(): number {
    const buffers = new Set<ArrayBufferLike>();
    let uniqueCacheBytes = 0;

    this.partCache.forEach((raw) => {
      uniqueCacheBytes += this.collectRawBuffers(raw, buffers);
    });

    this.frameCache.forEach((entry) => {
      uniqueCacheBytes += this.collectRawBuffers(entry.rawPixelData, buffers);
    });

    this.bufferCache.forEach((buffer) => {
      if (!buffers.has(buffer)) {
        buffers.add(buffer);
        uniqueCacheBytes += buffer.byteLength;
      }
    });

    return uniqueCacheBytes;
  }

  public computeStats(currentRawPixelData: RawDecodeResult | null): CacheStats {
    const buffers = new Set<ArrayBufferLike>();
    const rawBytes = currentRawPixelData ? this.collectRawBuffers(currentRawPixelData, buffers) : 0;
    let partCacheBytes = 0;
    let frameCacheBytes = 0;
    let bufferCacheBytes = 0;
    let uniqueCacheBytes = 0;

    this.partCache.forEach((raw) => {
      partCacheBytes += this.estimateRawBytes(raw);
      uniqueCacheBytes += this.collectRawBuffers(raw, buffers);
    });

    this.frameCache.forEach((entry) => {
      frameCacheBytes += this.estimateRawBytes(entry.rawPixelData);
      uniqueCacheBytes += this.collectRawBuffers(entry.rawPixelData, buffers);
    });

    this.bufferCache.forEach((buffer) => {
      bufferCacheBytes += buffer.byteLength;
      if (!buffers.has(buffer)) {
        buffers.add(buffer);
        uniqueCacheBytes += buffer.byteLength;
      }
    });

    return {
      cacheBytes: partCacheBytes + frameCacheBytes + bufferCacheBytes,
      uniqueCacheBytes,
      rawBytes,
      totalUniqueBytes: rawBytes + uniqueCacheBytes,
      partCacheBytes,
      frameCacheBytes,
      bufferCacheBytes,
      partCacheCount: this.partCache.size,
      frameCacheCount: this.frameCache.size,
      bufferCacheCount: this.bufferCache.size,
    };
  }

  public prune(
    sequenceFrameIndex: number | null,
    sequenceFrames: { id: string }[],
    CACHE_MB_MIN: number,
    CACHE_MB_MAX: number
  ): boolean {
    const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
    const maxBytes = clamp(this.maxCacheMB, CACHE_MB_MIN, CACHE_MB_MAX) * 1024 * 1024;
    let total = this.getUniqueCacheBytes();

    let purged = false;

    const tryEvictFarFrames = (): boolean => {
      if (this.policy !== 'distance' || sequenceFrameIndex === null) return false;
      const idToIdx = new Map<string, number>();
      sequenceFrames.forEach((f, i) => idToIdx.set(f.id, i));

      let candidateKey: string | null = null;
      let candidateDist = -1;
      this.frameCache.forEach((entry, key) => {
        const idx = idToIdx.get(key);
        if (idx !== undefined) {
          const dist = Math.abs(idx - sequenceFrameIndex);
          if (dist > this.distance && dist > candidateDist) {
            candidateDist = dist;
            candidateKey = key;
          }
        }
      });

      if (candidateKey) {
        this.frameCache.delete(candidateKey);
        purged = true;
        return true;
      }
      return false;
    };

    while (total > maxBytes) {
      if (tryEvictFarFrames()) {
        total = this.getUniqueCacheBytes();
        continue;
      }
      if (this.bufferCache.size > 0) {
        const key = this.bufferCache.keys().next().value;
        this.bufferCache.delete(key);
        purged = true;
        total = this.getUniqueCacheBytes();
        continue;
      }
      if (this.frameCache.size > 0) {
        const key = this.frameCache.keys().next().value;
        this.frameCache.delete(key);
        purged = true;
        total = this.getUniqueCacheBytes();
        continue;
      }
      if (this.partCache.size > 0) {
        const key = this.partCache.keys().next().value;
        this.partCache.delete(key);
        purged = true;
        total = this.getUniqueCacheBytes();
        continue;
      }
      break;
    }

    return purged;
  }
}
