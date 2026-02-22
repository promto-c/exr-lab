import React from 'react';
import { SidebarHeader, SourcesPanel, StructurePanel } from './components/Sidebar';
import { SidebarLayout } from './components/SidebarLayout';
import { LogPanel } from './components/LogPanel';
import { DropZone } from './components/DropZone';
import { HistogramOverlay } from './components/HistogramOverlay';
import { PixelInspector } from './components/PixelInspector';
import { PrecisionSlider } from './components/PrecisionSlider';
import { PreferencesView, CACHE_MB_MIN, CACHE_MB_MAX } from './components/PreferencesView';
import { ExrParser } from './services/exrParser';
import { ExrDecoder } from './services/exr/decoder';
import { createRenderer, getRendererPreferenceFromQuery } from './services/render/createRenderer';
import { RenderBackend, Renderer, RendererPreference, RawDecodeResult, ChannelMapping } from './services/render/types';
import { LogEntry, ExrStructure, LogStatus, ExrChannel, CacheStats } from './types';
import { Sun, Monitor, BarChart3, Maximize, Crosshair, HelpCircle, X, Menu, SlidersHorizontal, SkipBack, SkipForward, Play, Pause } from 'lucide-react';

// Helper to guess RGB channels from a list
const guessChannels = (channels: ExrChannel[]): ChannelMapping => {
  const map: ChannelMapping = { r: '', g: '', b: '', a: '' };
  const names = channels.map(c => c.name);

  // Helper to find exact or suffixed match
  const find = (suffixes: string[]) => {
     for (const s of suffixes) {
        const exact = names.find(n => n === s);
        if (exact) return exact;
        const suffixed = names.find(n => n.endsWith('.' + s) || n.endsWith('.' + s.toUpperCase()));
        if (suffixed) return suffixed;
     }
     return null;
  };

  map.r = find(['R', 'r', 'Red', 'red']) || '';
  map.g = find(['G', 'g', 'Green', 'green']) || '';
  map.b = find(['B', 'b', 'Blue', 'blue']) || '';
  map.a = find(['A', 'a', 'Alpha', 'alpha']) || '';
  
  // Fallback: if we have channels but no RGB match (e.g., Y, RY, BY or just Z)
  if (!map.r && !map.g && !map.b && names.length > 0) {
      map.r = names[0];
      map.g = names[1] || names[0];
      map.b = names[2] || names[0];
  }

  return map;
};

// Helper to get channels for a specific layer
const getLayerMapping = (channels: ExrChannel[], layerPrefix: string): ChannelMapping => {
  const map: ChannelMapping = { r: '', g: '', b: '', a: '' };
  const names = channels.map(c => c.name);
  
  // If root layer
  const prefix = layerPrefix === '(root)' ? '' : layerPrefix + '.';
  
  const find = (suffix: string) => names.find(n => n === prefix + suffix) || '';
  
  map.r = find('R') || find('r') || find('X') || find('x') || '';
  map.g = find('G') || find('g') || find('Y') || find('y') || '';
  map.b = find('B') || find('b') || find('Z') || find('z') || '';
  map.a = find('A') || find('a') || '';
  
  // Special case: if mapping is empty but channels exist in that layer (e.g. Depth.Z)
  if (!map.r && !map.g && !map.b) {
      // Find any channel starting with prefix
      const first = names.find(n => n.startsWith(prefix));
      if (first) {
          map.r = map.g = map.b = first;
      }
  }

  return map;
};

type SequenceFrame = {
  id: string;
  file: File;
  name: string;
  relativePath: string;
  sequenceKey: string;
  frameNumber: number | null;
};

type SequenceSource = {
  id: string;
  label: string;
  frames: SequenceFrame[];
};

type SequenceDescriptor = {
  sequenceKey: string;
  frameNumber: number | null;
  frameDigits: string;
  sequencePath: string;
  extension: string;
};

type FileLoadOptions = {
  autoFit?: boolean;
  displayName?: string;
  isFrameChange?: boolean;
};

const EXR_FILE_PATTERN = /\.exr$/i;
const DEFAULT_SEQUENCE_FPS = 24;
const MAX_FRAME_CACHE = 500;
const DEFAULT_MAX_CACHE_MB = 4096;

type FrameDecodeCache = {
  structure: ExrStructure;
  rawPixelData: RawDecodeResult;
  partId: number;
};

const isExrPath = (path: string): boolean => EXR_FILE_PATTERN.test(path);

const getRelativePath = (file: File): string => {
  const relative =
    typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name;

  return relative.replace(/\\/g, '/');
};

const getSequenceDescriptor = (relativePath: string): SequenceDescriptor => {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const slashIndex = normalizedPath.lastIndexOf('/');
  const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : '';
  const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex) : '';
  const stem = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  const match = stem.match(/^(.*?)(\d+)$/);

  if (!match) {
    const sequencePath = directory ? `${directory}/${stem}` : stem;
    return {
      sequenceKey: `${sequencePath.toLowerCase()}${extension.toLowerCase()}`,
      frameNumber: null,
      frameDigits: '',
      sequencePath,
      extension,
    };
  }

  const prefix = match[1];
  const frameDigits = match[2];
  const frameNumber = Number.parseInt(frameDigits, 10);
  const sequencePath = directory ? `${directory}/${prefix}` : prefix;
  return {
    sequenceKey: `${sequencePath.toLowerCase()}#${extension.toLowerCase()}`,
    frameNumber: Number.isFinite(frameNumber) ? frameNumber : null,
    frameDigits,
    sequencePath,
    extension,
  };
};

const sortSequenceEntries = (a: SequenceFrame, b: SequenceFrame): number => {
  if (a.sequenceKey === b.sequenceKey && a.frameNumber !== null && b.frameNumber !== null && a.frameNumber !== b.frameNumber) {
    return a.frameNumber - b.frameNumber;
  }

  return a.relativePath.localeCompare(b.relativePath, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

const formatFrame = (frame: number, padding: number): string => String(frame).padStart(Math.max(padding, 1), '0');

const buildSequenceSourcesFromFiles = (files: File[]): SequenceSource[] => {
  const exrEntries = files
    .map((file) => {
      const relativePath = getRelativePath(file);
      if (!isExrPath(relativePath)) return null;
      const sequence = getSequenceDescriptor(relativePath);

      return {
        file,
        relativePath,
        name: relativePath.split('/').pop() || file.name,
        sequenceKey: sequence.sequenceKey,
        frameNumber: sequence.frameNumber,
        frameDigits: sequence.frameDigits,
        sequencePath: sequence.sequencePath,
        extension: sequence.extension,
      };
    })
    .filter((entry): entry is {
      file: File;
      relativePath: string;
      name: string;
      sequenceKey: string;
      frameNumber: number | null;
      frameDigits: string;
      sequencePath: string;
      extension: string;
    } => entry !== null);

  if (exrEntries.length === 0) return [];

  const groups = new Map<string, {
    sequenceKey: string;
    sequencePath: string;
    extension: string;
    maxFrameDigits: number;
    frames: SequenceFrame[];
  }>();
  for (const entry of exrEntries) {
    const group = groups.get(entry.sequenceKey);
    const frame: SequenceFrame = {
      id: `${entry.relativePath}-${entry.sequenceKey}`,
      file: entry.file,
      name: entry.name,
      relativePath: entry.relativePath,
      sequenceKey: entry.sequenceKey,
      frameNumber: entry.frameNumber,
    };

    if (group) {
      group.frames.push(frame);
      group.maxFrameDigits = Math.max(group.maxFrameDigits, entry.frameDigits.length);
    } else {
      groups.set(entry.sequenceKey, {
        sequenceKey: entry.sequenceKey,
        sequencePath: entry.sequencePath,
        extension: entry.extension,
        maxFrameDigits: entry.frameDigits.length,
        frames: [frame],
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      const frames = [...group.frames].sort(sortSequenceEntries);
      const numberedFrames = frames.filter((frame): frame is SequenceFrame & { frameNumber: number } => frame.frameNumber !== null);

      let label: string;
      if (numberedFrames.length > 0) {
        const minFrame = numberedFrames[0].frameNumber;
        const maxFrame = numberedFrames[numberedFrames.length - 1].frameNumber;
        const padding = Math.max(
          group.maxFrameDigits,
          String(minFrame).length,
          String(maxFrame).length
        );
        label = `${group.sequencePath}.[${formatFrame(minFrame, padding)}-${formatFrame(maxFrame, padding)}]${group.extension}`;
      } else if (frames.length === 1) {
        label = frames[0].relativePath;
      } else {
        label = `${group.sequencePath}${group.extension}`;
      }

      return {
        id: group.sequenceKey,
        label,
        frames,
      };
    })
    .sort((a, b) => {
      if (b.frames.length !== a.frames.length) {
        return b.frames.length - a.frames.length;
      }
      return a.label.localeCompare(b.label, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
};

const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => (
  new Promise<ArrayBuffer>((resolve, reject) => {
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
  })
);

type ViewMode = 'rgb' | 'alpha';
type WindowRect = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const isTextInputLikeTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
};

export default function App() {
  const rendererPreference = React.useMemo<RendererPreference>(() => getRendererPreferenceFromQuery(), []);

  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [structure, setStructure] = React.useState<ExrStructure | null>(null);
  const [selectedPartId, setSelectedPartId] = React.useState<number | null>(null);
  const [fileBuffer, setFileBuffer] = React.useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [sequenceSources, setSequenceSources] = React.useState<SequenceSource[]>([]);
  const [selectedSequenceSourceId, setSelectedSequenceSourceId] = React.useState<string | null>(null);
  const [sequenceFrames, setSequenceFrames] = React.useState<SequenceFrame[]>([]);
  const [sequenceFrameIndex, setSequenceFrameIndex] = React.useState<number | null>(null);
  const [isSequencePlaying, setIsSequencePlaying] = React.useState(false);

  // Raw Data Cache (Map of Float32Arrays)
  const [rawPixelData, setRawPixelData] = React.useState<RawDecodeResult | null>(null);
  
  // Decoded Part Cache
  const partCacheRef = React.useRef<Map<number, RawDecodeResult>>(new Map());

  // Channel Mapping State
  const [channelMapping, setChannelMapping] = React.useState<ChannelMapping>({ r: '', g: '', b: '', a: '' });
  const [viewMode, setViewMode] = React.useState<ViewMode>('rgb');

  // View Settings
  const [exposure, setExposure] = React.useState(0);
  const [gamma, setGamma] = React.useState(2.2);

  // Toggle Memory
  const lastExposureRef = React.useRef(0);
  const lastGammaRef = React.useRef(1.0); // Default alternate to Linear (1.0)
  
  // Histogram Data & Visibility
  const [histogramData, setHistogramData] = React.useState<number[] | null>(null);
  const [showHistogram, setShowHistogram] = React.useState(true);
  const [rendererBackend, setRendererBackend] = React.useState<RenderBackend>('cpu');
  const [rendererFallbackReason, setRendererFallbackReason] = React.useState<string | null>(null);
  const [rendererEpoch, setRendererEpoch] = React.useState(0);
  const [isPreferencesOpen, setIsPreferencesOpen] = React.useState(false);
  const [maxCacheMB, setMaxCacheMB] = React.useState(DEFAULT_MAX_CACHE_MB);
  const [cacheStats, setCacheStats] = React.useState<CacheStats>({
    cacheBytes: 0,
    uniqueCacheBytes: 0,
    rawBytes: 0,
    totalUniqueBytes: 0,
    partCacheBytes: 0,
    frameCacheBytes: 0,
    bufferCacheBytes: 0,
    partCacheCount: 0,
    frameCacheCount: 0,
    bufferCacheCount: 0,
  });

  // Pixel Inspector State
  const [isInspectMode, setIsInspectMode] = React.useState(true);
  const [inspectCursor, setInspectCursor] = React.useState<{x: number, y: number} | null>(null);

  // Transform State (Zoom/Pan)
  const [viewTransform, setViewTransform] = React.useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragStart, setDragStart] = React.useState({ x: 0, y: 0 });

  // Touch State
  const lastTouchRef = React.useRef<{x: number, y: number}[] | null>(null);
  const isTouchUiInteractionRef = React.useRef(false);

  // Help State
  const [showHelp, setShowHelp] = React.useState(false);

  // Layout State
  const [sidebarWidth, setSidebarWidth] = React.useState(320);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);

  // Mobile/Responsive State
  const [isMobile, setIsMobile] = React.useState(window.innerWidth <= 768);
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(window.innerWidth > 768);
  const [isMobileActionsOpen, setIsMobileActionsOpen] = React.useState(false);

  // Refs
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const rendererRef = React.useRef<Renderer | null>(null);
  const decodeEpochRef = React.useRef(0);
  const shouldAutoFitRef = React.useRef(true);
  const sequenceSelectionEpochRef = React.useRef(0);
  const sequenceAutoFitRef = React.useRef(false);

  // Frame caches: decoded result cache (avoids re-decoding navigated frames)
  // and buffer cache (avoids re-reading from File if decode cache misses)
  const frameCacheRef = React.useRef<Map<string, FrameDecodeCache>>(new Map());
  const bufferCacheRef = React.useRef<Map<string, ArrayBuffer>>(new Map());

  const formatBytes = React.useCallback((bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const base = 1024;
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length - 1);
    const value = bytes / Math.pow(base, exponent);
    const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(precision)} ${units[exponent]}`;
  }, []);

  const estimateRawBytes = React.useCallback((raw: RawDecodeResult): number => {
    let bytes = 0;
    for (const channel of Object.values(raw.channels)) {
      bytes += channel.byteLength;
    }
    return bytes;
  }, []);

  const collectRawBuffers = React.useCallback(
    (raw: RawDecodeResult, buffers: Set<ArrayBufferLike>): number => {
      let bytes = 0;
      for (const channel of Object.values(raw.channels)) {
        const buffer = channel.buffer;
        if (!buffers.has(buffer)) {
          buffers.add(buffer);
          bytes += buffer.byteLength;
        }
      }
      return bytes;
    },
    []
  );

  const computeCacheStats = React.useCallback((): CacheStats => {
    const buffers = new Set<ArrayBufferLike>();
    const rawBytes = rawPixelData ? collectRawBuffers(rawPixelData, buffers) : 0;
    let partCacheBytes = 0;
    let frameCacheBytes = 0;
    let bufferCacheBytes = 0;
    let uniqueCacheBytes = 0;

    partCacheRef.current.forEach((raw) => {
      partCacheBytes += estimateRawBytes(raw);
      uniqueCacheBytes += collectRawBuffers(raw, buffers);
    });

    frameCacheRef.current.forEach((entry) => {
      frameCacheBytes += estimateRawBytes(entry.rawPixelData);
      uniqueCacheBytes += collectRawBuffers(entry.rawPixelData, buffers);
    });

    bufferCacheRef.current.forEach((buffer) => {
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
      partCacheCount: partCacheRef.current.size,
      frameCacheCount: frameCacheRef.current.size,
      bufferCacheCount: bufferCacheRef.current.size,
    };
  }, [collectRawBuffers, estimateRawBytes, rawPixelData]);

  const updateCacheStats = React.useCallback(() => {
    setCacheStats(computeCacheStats());
  }, [computeCacheStats]);

  const pruneCachesToLimit = React.useCallback(() => {
    const maxBytes = clamp(maxCacheMB, CACHE_MB_MIN, CACHE_MB_MAX) * 1024 * 1024;
    let total = 0;
    partCacheRef.current.forEach((raw) => {
      total += estimateRawBytes(raw);
    });
    frameCacheRef.current.forEach((entry) => {
      total += estimateRawBytes(entry.rawPixelData);
    });
    bufferCacheRef.current.forEach((buffer) => {
      total += buffer.byteLength;
    });

    let purged = false;
    while (total > maxBytes) {
      if (bufferCacheRef.current.size > 0) {
        const key = bufferCacheRef.current.keys().next().value;
        const entry = bufferCacheRef.current.get(key);
        if (entry) total -= entry.byteLength;
        bufferCacheRef.current.delete(key);
        purged = true;
        continue;
      }
      if (frameCacheRef.current.size > 0) {
        const key = frameCacheRef.current.keys().next().value;
        const entry = frameCacheRef.current.get(key);
        if (entry) total -= estimateRawBytes(entry.rawPixelData);
        frameCacheRef.current.delete(key);
        purged = true;
        continue;
      }
      if (partCacheRef.current.size > 0) {
        const key = partCacheRef.current.keys().next().value;
        const entry = partCacheRef.current.get(key);
        if (entry) total -= estimateRawBytes(entry);
        partCacheRef.current.delete(key);
        purged = true;
        continue;
      }
      break;
    }

    if (purged) {
      updateCacheStats();
    }
  }, [estimateRawBytes, maxCacheMB, updateCacheStats]);

  const purgeCaches = React.useCallback(() => {
    partCacheRef.current.clear();
    frameCacheRef.current.clear();
    bufferCacheRef.current.clear();
    updateCacheStats();
  }, [updateCacheStats]);

  // Resize Listener
  React.useEffect(() => {
      const handleResize = () => {
          const mobile = window.innerWidth <= 768;
          setIsMobile(mobile);
          if (!mobile) setIsMobileActionsOpen(false);
          // Auto-close on switch to mobile, auto-open on switch to desktop
          if (!mobile && !isSidebarOpen) setIsSidebarOpen(true);
          if (mobile && isSidebarOpen) setIsSidebarOpen(false);
      };
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
  }, []);

  React.useEffect(() => {
    updateCacheStats();
  }, [rawPixelData, updateCacheStats]);

  React.useEffect(() => {
    pruneCachesToLimit();
    updateCacheStats();
  }, [maxCacheMB, pruneCachesToLimit, updateCacheStats]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      updateCacheStats();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [updateCacheStats]);

  React.useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const canInteractWithViewport = Boolean(structure && rawPixelData);
  const hasSequenceFrames = sequenceFrames.length > 0;
  const canPlaySequence = sequenceFrames.length > 1;

  // generate a boolean mask for sequence scrubber that marks which frames
  // have been cached already (decoded). using cacheStats.frameCacheCount as a
  // dependency ensures we recompute when the cache changes.
  const sequenceCacheMask = React.useMemo(() => {
    if (sequenceFrames.length === 0) return [];
    const set = frameCacheRef.current;
    return sequenceFrames.map((f) => set.has(f.id));
  }, [sequenceFrames, cacheStats.frameCacheCount]);
  const selectedSequenceSource =
    selectedSequenceSourceId !== null
      ? sequenceSources.find((source) => source.id === selectedSequenceSourceId) ?? null
      : null;
  const safeSequenceFrameIndex =
    sequenceFrameIndex !== null
      ? clamp(sequenceFrameIndex, 0, Math.max(sequenceFrames.length - 1, 0))
      : null;

  // Frame counter label e.g. "0001 / 0024" using actual frame numbers when available
  const currentFrameLabel = React.useMemo(() => {
    if (safeSequenceFrameIndex === null || sequenceFrames.length === 0) return '';
    const frame = sequenceFrames[safeSequenceFrameIndex];
    const current = frame?.frameNumber ?? safeSequenceFrameIndex + 1;
    const lastFrame = sequenceFrames[sequenceFrames.length - 1];
    const total = lastFrame?.frameNumber ?? sequenceFrames.length;
    const pad = Math.max(String(total).length, 1);
    return `${String(current).padStart(pad, '0')} / ${String(total).padStart(pad, '0')}`;
  }, [safeSequenceFrameIndex, sequenceFrames]);

  React.useEffect(() => {
    if (!canPlaySequence && isSequencePlaying) {
      setIsSequencePlaying(false);
    }
  }, [canPlaySequence, isSequencePlaying]);

  const selectedPart = React.useMemo(() => {
    if (!structure || selectedPartId === null) return null;
    return structure.parts.find((part) => part.id === selectedPartId) || null;
  }, [structure, selectedPartId]);

  const selectedPartDataWindowRect = React.useMemo<WindowRect | null>(() => {
    if (!selectedPart?.dataWindow) return null;

    const dataWindow = selectedPart.dataWindow;
    const displayRefWindow = selectedPart.displayWindow ?? dataWindow;

    return {
      x: dataWindow.xMin - displayRefWindow.xMin,
      y: dataWindow.yMin - displayRefWindow.yMin,
      width: dataWindow.xMax - dataWindow.xMin + 1,
      height: dataWindow.yMax - dataWindow.yMin + 1,
    };
  }, [selectedPart]);

  const dataWindowRect = React.useMemo<WindowRect | null>(() => {
    if (!rawPixelData || !selectedPartDataWindowRect) return null;
    if (
      selectedPartDataWindowRect.width !== rawPixelData.width ||
      selectedPartDataWindowRect.height !== rawPixelData.height
    ) return null;

    return {
      x: selectedPartDataWindowRect.x,
      y: selectedPartDataWindowRect.y,
      width: rawPixelData.width,
      height: rawPixelData.height,
    };
  }, [rawPixelData, selectedPartDataWindowRect]);

  const displayWindowRect = React.useMemo<WindowRect | null>(() => {
    if (!selectedPart?.dataWindow) return null;

    const displayWindow = selectedPart.displayWindow ?? selectedPart.dataWindow;

    return {
      x: 0,
      y: 0,
      width: displayWindow.xMax - displayWindow.xMin + 1,
      height: displayWindow.yMax - displayWindow.yMin + 1,
    };
  }, [selectedPart]);

  const viewportReferenceRect = React.useMemo<WindowRect | null>(() => (
    displayWindowRect ?? dataWindowRect
  ), [displayWindowRect, dataWindowRect]);

  const toScreenWindowRectStyle = React.useCallback((rect: WindowRect): React.CSSProperties => {
    const { x, y, scale } = viewTransform;
    return {
      left: x + rect.x * scale,
      top: y + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }, [viewTransform]);

  const dataWindowScreenStyle = React.useMemo<React.CSSProperties | null>(() => {
    if (!dataWindowRect) return null;
    return toScreenWindowRectStyle(dataWindowRect);
  }, [dataWindowRect, toScreenWindowRectStyle]);

  const displayWindowScreenStyle = React.useMemo<React.CSSProperties | null>(() => {
    if (!displayWindowRect) return null;
    return toScreenWindowRectStyle(displayWindowRect);
  }, [displayWindowRect, toScreenWindowRectStyle]);

  const areDataAndDisplayWindowsEqual = React.useMemo(() => {
    if (!dataWindowRect || !displayWindowRect) return false;
    return (
      dataWindowRect.x === displayWindowRect.x &&
      dataWindowRect.y === displayWindowRect.y &&
      dataWindowRect.width === displayWindowRect.width &&
      dataWindowRect.height === displayWindowRect.height
    );
  }, [dataWindowRect, displayWindowRect]);

  const displayMapping = React.useMemo<ChannelMapping>(() => {
    if (viewMode === 'alpha' && channelMapping.a) {
      return {
        r: channelMapping.a,
        g: channelMapping.a,
        b: channelMapping.a,
        a: '',
      };
    }

    return {
      r: channelMapping.r,
      g: channelMapping.g,
      b: channelMapping.b,
      a: '',
    };
  }, [channelMapping, viewMode]);

  const isViewportUiTarget = React.useCallback((target: EventTarget | null) => {
    const element =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    if (!element) return false;
    return Boolean(
      element.closest('button, input, select, textarea, a, label, [role="button"], [role="slider"], [data-touch-ui="true"]')
    );
  }, []);

  React.useEffect(() => {
    if (viewMode === 'alpha' && !channelMapping.a) {
      setViewMode('rgb');
    }
  }, [channelMapping.a, viewMode]);

  React.useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.key.toLowerCase() !== 'a') return;
      if (!rawPixelData || !channelMapping.a) return;
      if (isTextInputLikeTarget(event.target)) return;

      event.preventDefault();
      setViewMode(prev => (prev === 'rgb' ? 'alpha' : 'rgb'));
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [channelMapping.a, rawPixelData]);

  // Prevent native page gestures while interacting with the loaded viewport
  React.useEffect(() => {
    if (!canInteractWithViewport) return;

    const el = containerRef.current;
    if (!el) return;
    
    const preventDefault = (e: TouchEvent) => {
      if (e.type === 'touchstart') {
        isTouchUiInteractionRef.current = isViewportUiTarget(e.target);
      }

      if (isTouchUiInteractionRef.current || isViewportUiTarget(e.target)) return;
      e.preventDefault();
    };

    const clearTouchUiInteraction = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        isTouchUiInteractionRef.current = false;
      }
    };
    el.addEventListener('touchstart', preventDefault, { passive: false });
    el.addEventListener('touchmove', preventDefault, { passive: false });
    
    return () => {
        el.removeEventListener('touchstart', preventDefault);
        el.removeEventListener('touchmove', preventDefault);
    };
  }, [canInteractWithViewport, isViewportUiTarget]);

  // Resize Handlers (Desktop)
  React.useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const newWidth = Math.max(200, Math.min(e.clientX, 800));
        setSidebarWidth(newWidth);
      }
    };

    const handleGlobalMouseUp = () => {
      setIsResizingSidebar(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    if (isResizingSidebar) {
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
  }, [isResizingSidebar]);

  const handleLog = React.useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry]);
  }, []);

  const switchToCpuFallback = React.useCallback((reason: string) => {
    if (!canvasRef.current) return;

    const previousBackend = rendererRef.current?.getBackend() || 'unknown';
    rendererRef.current?.dispose();

    const selection = createRenderer({
      canvas: canvasRef.current,
      requested: 'cpu',
    });

    rendererRef.current = selection.renderer;
    setRendererBackend(selection.backend);
    setRendererFallbackReason(reason);
    setRendererEpoch(prev => prev + 1);

    handleLog({
      id: `renderer-fallback-${Date.now()}`,
      stepId: 'renderer',
      title: 'Renderer Fallback',
      status: LogStatus.Warn,
      ms: 0,
      metrics: [
        { label: 'From', value: previousBackend },
        { label: 'To', value: selection.backend },
      ],
      description: reason,
    });
  }, [handleLog]);

  React.useEffect(() => {
    if (!canvasRef.current) return;

    rendererRef.current?.dispose();

    const selection = createRenderer({
      canvas: canvasRef.current,
      requested: rendererPreference,
      callbacks: {
        onContextLost: (reason) => switchToCpuFallback(reason),
        onContextRestored: () => {
          handleLog({
            id: `renderer-restored-${Date.now()}`,
            stepId: 'renderer',
            title: 'WebGL Context Restored',
            status: LogStatus.Warn,
            ms: 0,
            metrics: [{ label: 'Backend', value: 'webgl2' }],
          });
        },
      },
    });

    rendererRef.current = selection.renderer;
    setRendererBackend(selection.backend);
    setRendererFallbackReason(selection.fallbackReason || null);
    setRendererEpoch(prev => prev + 1);

    handleLog({
      id: `renderer-selection-${Date.now()}`,
      stepId: 'renderer',
      title: 'Renderer Selected',
      status: selection.backend === 'webgl2' ? LogStatus.Ok : LogStatus.Warn,
      ms: 0,
      metrics: [
        { label: 'Requested', value: rendererPreference },
        { label: 'Active', value: selection.backend },
      ],
      description: selection.fallbackReason,
    });

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [handleLog, rendererPreference, structure, switchToCpuFallback]);

  const fitView = React.useCallback(() => {
    if (!viewportReferenceRect || !containerRef.current) return;

    const { x: targetX, y: targetY, width, height } = viewportReferenceRect;
    const { clientWidth, clientHeight } = containerRef.current;
    
    const padding = isMobile ? 20 : 60;
    const availW = clientWidth - padding;
    const availH = clientHeight - padding;
    
    const scale = Math.min(availW / width, availH / height);
    const finalScale = scale > 0 ? scale : 1; 

    const x = (clientWidth - width * finalScale) / 2 - targetX * finalScale;
    const y = (clientHeight - height * finalScale) / 2 - targetY * finalScale;

    setViewTransform({ x, y, scale: finalScale });
  }, [isMobile, viewportReferenceRect]);

  const toggleExposure = () => {
    const isDefault = Math.abs(exposure) < 0.01;
    if (isDefault) {
      if (Math.abs(lastExposureRef.current) > 0.01) {
          setExposure(lastExposureRef.current);
      }
    } else {
      lastExposureRef.current = exposure;
      setExposure(0);
    }
  };

  const toggleGamma = () => {
    const isDefault = Math.abs(gamma - 2.2) < 0.01;
    if (isDefault) {
       // If stored is same as default, fallback to Linear (1.0)
       const target = Math.abs(lastGammaRef.current - 2.2) < 0.01 ? 1.0 : lastGammaRef.current;
       setGamma(target);
    } else {
       lastGammaRef.current = gamma;
       setGamma(2.2);
    }
  };

  const clearSequenceBinding = () => {
    sequenceSelectionEpochRef.current += 1;
    sequenceAutoFitRef.current = false;
    setSequenceSources([]);
    setSelectedSequenceSourceId(null);
    setSequenceFrames([]);
    setSequenceFrameIndex(null);
    setIsSequencePlaying(false);
    frameCacheRef.current.clear();
    bufferCacheRef.current.clear();
    updateCacheStats();
  };

  const activateSequenceSource = (source: SequenceSource, autoFit = true) => {
    sequenceSelectionEpochRef.current += 1;
    sequenceAutoFitRef.current = autoFit;
    setIsSequencePlaying(false);
    setSelectedSequenceSourceId(source.id);
    setSequenceFrames(source.frames);
    setSequenceFrameIndex(0);
    // Clear per-source caches when switching sequences
    frameCacheRef.current.clear();
    bufferCacheRef.current.clear();
    updateCacheStats();
  };

  const handleFileLoaded = async (name: string, buffer: ArrayBuffer, options: FileLoadOptions = {}) => {
    decodeEpochRef.current += 1;
    shouldAutoFitRef.current = options.autoFit ?? true;
    const displayName = options.displayName ?? name;
    const isFrameChange = options.isFrameChange ?? false;

    setFileName(displayName);
    setFileBuffer(buffer);
    setLogs([]);
    if (!isFrameChange) {
      setStructure(null);
      setSelectedPartId(null);
      setRawPixelData(null);
      setViewMode('rgb');
      setIsProcessing(true);
    }
    // When loading a new file we clear the histogram, but for frame changes
    // we want to keep the previous data in place until the new render completes
    // so that the overlay doesn't unmount/flash. It will be replaced a few
    // milliseconds later by the render effect below.
    if (!isFrameChange) {
      setHistogramData(null);
    }
    setInspectCursor(null);

    // Close sidebar on mobile when file loaded
    if (isMobile) setIsSidebarOpen(false);

    // Clear the part cache when loading a new file
    partCacheRef.current.clear();
    updateCacheStats();

    try {
      const fileSizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);

      handleLog({
        id: `init-${Date.now()}`,
        stepId: 'init',
        title: 'File Loaded',
        status: LogStatus.Start,
        ms: 0,
        metrics: [
          { label: 'File', value: displayName },
          { label: 'Size', value: `${fileSizeMB} MB` },
        ],
      });

      if (!isFrameChange) {
        handleLog({
          id: `renderer-active-${Date.now()}`,
          stepId: 'renderer',
          title: 'Renderer Active',
          status: rendererBackend === 'webgl2' ? LogStatus.Ok : LogStatus.Warn,
          ms: 0,
          metrics: [
            { label: 'Requested', value: rendererPreference },
            { label: 'Active', value: rendererBackend },
          ],
          description: rendererFallbackReason || undefined,
        });
      }

      const parser = new ExrParser(buffer, handleLog);
      const result = await parser.parse();

      if (result) {
        setStructure(result);
        if (result.parts.length > 0) {
          setSelectedPartId(result.parts[0].id);
          setChannelMapping(guessChannels(result.parts[0].channels));
        }
      }
    } catch (e: any) {
      handleLog({
        id: `error-${Date.now()}`,
        stepId: 'crash',
        title: 'Unexpected Error',
        status: LogStatus.Error,
        ms: 0,
        metrics: [],
        description: e.message,
      });
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSingleFileLoaded = async (name: string, buffer: ArrayBuffer) => {
    clearSequenceBinding();
    await handleFileLoaded(name, buffer, { autoFit: true, displayName: name });
  };

  const loadSingleFile = async (file: File) => {
    if (!isExrPath(file.name)) {
      handleLog({
        id: `single-file-invalid-${Date.now()}`,
        stepId: 'sequence',
        title: 'Unsupported File',
        status: LogStatus.Warn,
        ms: 0,
        metrics: [{ label: 'File', value: file.name }],
        description: 'Only EXR files are supported for preview.',
      });
      return;
    }

    clearSequenceBinding();
    const buffer = await readFileAsArrayBuffer(file);
    await handleFileLoaded(file.name, buffer, { autoFit: true, displayName: file.name });
  };

  const bindFilesAsSequence = (files: File[]) => {
    const sources = buildSequenceSourcesFromFiles(files);
    if (sources.length === 0) {
      handleLog({
        id: `bind-folder-empty-${Date.now()}`,
        stepId: 'sequence',
        title: 'Folder Bind Failed',
        status: LogStatus.Warn,
        ms: 0,
        metrics: [{ label: 'Items', value: files.length }],
        description: 'No EXR files were found in the selected input.',
      });
      return;
    }

    const selectedSource = sources[0];
    const sourceText = sources.length > 1 ? `${sources.length} sources` : '1 source';
    const frameText = selectedSource.frames.length > 1 ? `${selectedSource.frames.length} frames` : '1 frame';

    setSequenceSources(sources);
    activateSequenceSource(selectedSource, true);

    handleLog({
      id: `bind-folder-${Date.now()}`,
      stepId: 'sequence',
      title: 'Folder Bound',
      status: LogStatus.Ok,
      ms: 0,
      metrics: [
        { label: 'Sources', value: sourceText },
        { label: 'Selected', value: selectedSource.label },
        { label: 'Frames', value: frameText },
      ],
      description: sources.length > 1
        ? 'Use the Sources panel to switch playlist groups.'
        : 'Single EXR source was bound for playback.',
    });
  };

  const handleSelectSequenceSource = (sourceId: string) => {
    if (sourceId === selectedSequenceSourceId) return;
    const source = sequenceSources.find((item) => item.id === sourceId);
    if (!source) return;

    activateSequenceSource(source, true);
    handleLog({
      id: `sequence-source-${Date.now()}`,
      stepId: 'sequence',
      title: 'Source Selected',
      status: LogStatus.Ok,
      ms: 0,
      metrics: [
        { label: 'Source', value: source.label },
        { label: 'Frames', value: source.frames.length },
      ],
    });
  };

  const handleGlobalFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 1) {
      void loadSingleFile(files[0]);
    } else if (files.length > 1) {
      bindFilesAsSequence(files);
    }

    e.target.value = '';
  };

  const handleGlobalFolderInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      bindFilesAsSequence(files);
    }

    e.target.value = '';
  };

  const openFolderPicker = () => {
    folderInputRef.current?.click();
  };

  const stepSequenceFrame = (direction: 1 | -1) => {
    if (sequenceFrames.length === 0) return;

    setIsSequencePlaying(false);
    sequenceAutoFitRef.current = false;
    setSequenceFrameIndex((previousIndex) => {
      const base = previousIndex ?? 0;
      const next = base + direction;
      if (next < 0) return sequenceFrames.length - 1;
      if (next >= sequenceFrames.length) return 0;
      return next;
    });
  };

  React.useEffect(() => {
    if (safeSequenceFrameIndex === null) return;

    const frame = sequenceFrames[safeSequenceFrameIndex];
    if (!frame) return;

    const requestId = ++sequenceSelectionEpochRef.current;
    const shouldAutoFit = sequenceAutoFitRef.current;
    sequenceAutoFitRef.current = false;

    const loadSelectedFrame = async () => {
      try {
        // 1. Check full decode cache (fastest path)
        const cached = frameCacheRef.current.get(frame.id);
        if (cached) {
          if (requestId !== sequenceSelectionEpochRef.current) return;
          decodeEpochRef.current += 1;
          // Pre-populate part cache so the decode effect short-circuits
          partCacheRef.current.clear();
          partCacheRef.current.set(cached.partId, cached.rawPixelData);
          setFileName(selectedSequenceSource?.label ?? frame.relativePath);
          setLogs([]);
          setStructure(cached.structure);
          setSelectedPartId(cached.partId);
          setRawPixelData(cached.rawPixelData);
          setIsProcessing(false);
          return;
        }

        // 2. Check buffer cache (avoids re-reading from File)
        let buffer = bufferCacheRef.current.get(frame.id);
        if (!buffer) {
          buffer = await readFileAsArrayBuffer(frame.file);
          if (requestId !== sequenceSelectionEpochRef.current) return;
          bufferCacheRef.current.set(frame.id, buffer);
          pruneCachesToLimit();
          updateCacheStats();
        } else {
          if (requestId !== sequenceSelectionEpochRef.current) return;
        }

        await handleFileLoaded(frame.name, buffer, {
          autoFit: shouldAutoFit,
          displayName: selectedSequenceSource?.label ?? frame.relativePath,
          isFrameChange: true,
        });
      } catch (error: any) {
        if (requestId !== sequenceSelectionEpochRef.current) return;
        handleLog({
          id: `sequence-load-error-${Date.now()}`,
          stepId: 'sequence',
          title: 'Sequence Frame Load Failed',
          status: LogStatus.Error,
          ms: 0,
          metrics: [{ label: 'Frame', value: frame.relativePath }],
          description: error?.message || String(error),
        });
      }
    };

    void loadSelectedFrame();
  }, [safeSequenceFrameIndex, selectedSequenceSource?.label, sequenceFrames]);

  React.useEffect(() => {
    if (!isSequencePlaying || !canPlaySequence || isProcessing) return;

    const intervalMs = 1000 / DEFAULT_SEQUENCE_FPS;
    const timer = window.setInterval(() => {
      setSequenceFrameIndex((previousIndex) => {
        const base = previousIndex ?? 0;
        return (base + 1) % sequenceFrames.length;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [canPlaySequence, isProcessing, isSequencePlaying, sequenceFrames.length]);

  // Save decoded frame to decode cache while in sequence mode
  React.useEffect(() => {
    if (safeSequenceFrameIndex === null || !rawPixelData || !structure || selectedPartId === null) return;
    const frame = sequenceFrames[safeSequenceFrameIndex];
    if (!frame) return;
    const entry: FrameDecodeCache = { structure, rawPixelData, partId: selectedPartId };
    frameCacheRef.current.set(frame.id, entry);
    if (frameCacheRef.current.size > MAX_FRAME_CACHE) {
      const oldest = frameCacheRef.current.keys().next().value;
      if (oldest !== undefined) frameCacheRef.current.delete(oldest);
    }
    pruneCachesToLimit();
    updateCacheStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPixelData]);

  // Keyboard shortcuts: ← / → step frames, Space toggles playback
  React.useEffect(() => {
    if (!hasSequenceFrames) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIsSequencePlaying(false);
        sequenceAutoFitRef.current = false;
        setSequenceFrameIndex((prev) => {
          const base = prev ?? 0;
          return base === 0 ? sequenceFrames.length - 1 : base - 1;
        });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIsSequencePlaying(false);
        sequenceAutoFitRef.current = false;
        setSequenceFrameIndex((prev) => {
          const base = prev ?? 0;
          return (base + 1) % sequenceFrames.length;
        });
      } else if (e.key === ' ') {
        if (!canPlaySequence) return;
        e.preventDefault();
        setIsSequencePlaying((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasSequenceFrames, canPlaySequence, sequenceFrames.length]);

  const handleSelectPart = (partId: number) => {
    if (selectedPartId !== partId) {
      const cachedRaw = partCacheRef.current.get(partId) ?? null;
      setRawPixelData(cachedRaw);
      // don't clear histogram here – keep the old bars visible until the new
      // render effect replaces them, which avoids a flash when switching parts
      setInspectCursor(null);
      setSelectedPartId(partId);
    }
    if (structure) {
        // Automatically guess default channels when switching parts explicitly
        const part = structure.parts.find(p => p.id === partId);
        if (part) {
            setChannelMapping(guessChannels(part.channels));
        }
    }
    if (isMobile) setIsSidebarOpen(false);
  };

  // 1. Heavy Lifting: Decode binary when part changes
  React.useEffect(() => {
      if (!fileBuffer || !structure || selectedPartId === null) return;

      // Check Cache First
      if (partCacheRef.current.has(selectedPartId)) {
        setRawPixelData(partCacheRef.current.get(selectedPartId)!);
        return;
      }

      const requestEpoch = ++decodeEpochRef.current;

      const decode = async () => {
          setIsProcessing(true);
          try {
              const decoder = new ExrDecoder(fileBuffer, structure, handleLog);
              const rawResult = await decoder.decode({
                  partId: selectedPartId
              });

              if (requestEpoch !== decodeEpochRef.current) {
                  return;
              }

              if (rawResult) {
                  // Save to cache
                  partCacheRef.current.set(selectedPartId, rawResult);
                  setRawPixelData(rawResult);
                  pruneCachesToLimit();
                  updateCacheStats();
              }
          } finally {
              if (requestEpoch === decodeEpochRef.current) {
                  setIsProcessing(false);
              }
          }
      };
      
      decode();

  }, [selectedPartId, fileBuffer, structure]);


  // 2. Light Lifting: Render frame using active backend
  React.useEffect(() => {
      if (!rawPixelData || !rendererRef.current) return;

      try {
          const result = rendererRef.current.render({
            raw: rawPixelData,
            mapping: displayMapping,
            params: { exposure, gamma }
          });

          setHistogramData(result.histogram);

      } catch (error: any) {
          const reason = error?.message || 'Unknown render error';
          handleLog({
            id: `render-error-${Date.now()}`,
            stepId: 'render',
            title: 'Render Failed',
            status: LogStatus.Error,
            ms: 0,
            metrics: [{ label: 'Backend', value: rendererRef.current.getBackend() }],
            description: reason,
          });

          if (rendererRef.current.getBackend() === 'webgl2') {
            switchToCpuFallback(`WebGL2 render failed: ${reason}`);
          }
      }

  }, [rawPixelData, exposure, gamma, displayMapping, rendererEpoch, handleLog, switchToCpuFallback]);

  // 3. Auto-fit once per file load; preserve zoom/pan for subsequent updates
  React.useEffect(() => {
      if (!rawPixelData || !shouldAutoFitRef.current) return;
      fitView();
      shouldAutoFitRef.current = false;
  }, [rawPixelData, fitView]);

  // --- Sidebar Handlers ---

  const handleSelectLayer = (partId: number, layerPrefix: string) => {
      if (selectedPartId !== partId) {
          const cachedRaw = partCacheRef.current.get(partId) ?? null;
          setRawPixelData(cachedRaw);
          // do not clear histogram here for the same reason as handleSelectPart
          setInspectCursor(null);
          setSelectedPartId(partId);
      }
      if (!structure) return;
      
      const part = structure.parts.find(p => p.id === partId);
      if (part) {
          const newMapping = getLayerMapping(part.channels, layerPrefix);
          setChannelMapping(newMapping);
      }
      if (isMobile) setIsSidebarOpen(false);
  };

  const handleSelectChannel = (partId: number, channelName: string) => {
      if (selectedPartId !== partId) {
          const cachedRaw = partCacheRef.current.get(partId) ?? null;
          setRawPixelData(cachedRaw);
          // keep old histogram until new one arrives
          setInspectCursor(null);
          setSelectedPartId(partId);
      }
      // Map R, G, B to the same channel for grayscale visualization
      setChannelMapping({
          r: channelName,
          g: channelName,
          b: channelName,
          a: ''
      });
      if (isMobile) setIsSidebarOpen(false);
  };


  // --- Zoom / Pan / Inspect Handlers ---

  const handleWheel = (e: React.WheelEvent) => {
      if (!structure || !rawPixelData) return;
      const s = 1.1;
      const factor = e.deltaY < 0 ? s : 1 / s;
      let newScale = viewTransform.scale * factor;
      if (newScale < 0.005) newScale = 0.005;
      if (newScale > 50) newScale = 50;
      const rect = containerRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const imageX = (mx - viewTransform.x) / viewTransform.scale;
      const imageY = (my - viewTransform.y) / viewTransform.scale;
      const newX = mx - imageX * newScale;
      const newY = my - imageY * newScale;
      setViewTransform({ x: newX, y: newY, scale: newScale });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
      if (e.button === 1 || e.button === 0) { // Allow left click pan too for ease
          e.preventDefault();
          setIsDragging(true);
          setDragStart({ 
              x: e.clientX - viewTransform.x, 
              y: e.clientY - viewTransform.y 
          });
      }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      // Pan
      if (isDragging) {
          e.preventDefault();
          setViewTransform(prev => ({
              ...prev,
              x: e.clientX - dragStart.x,
              y: e.clientY - dragStart.y
          }));
          return;
      }

      // Inspect
      if (isInspectMode && rawPixelData && containerRef.current && dataWindowRect) {
          const rect = containerRef.current.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          
          // Display-window-referenced scene space -> data-window pixel index.
          const sceneX = (mx - viewTransform.x) / viewTransform.scale;
          const sceneY = (my - viewTransform.y) / viewTransform.scale;
          const ix = Math.floor(sceneX - dataWindowRect.x);
          const iy = Math.floor(sceneY - dataWindowRect.y);
          
          if (ix >= 0 && ix < rawPixelData.width && iy >= 0 && iy < rawPixelData.height) {
              setInspectCursor({ x: ix, y: iy });
          } else {
              setInspectCursor(null);
          }
      }
  };

  const handleMouseUp = () => {
      setIsDragging(false);
  };
  
  const handleMouseLeave = () => {
      setIsDragging(false);
      setInspectCursor(null);
  };

  // --- Touch Handlers (Zoom/Pan) ---
  const handleTouchStart = (e: React.TouchEvent) => {
      if (isViewportUiTarget(e.target)) {
          setIsDragging(false);
          lastTouchRef.current = null;
          return;
      }

      if (e.touches.length === 1) {
          lastTouchRef.current = [{x: e.touches[0].clientX, y: e.touches[0].clientY}];
          setIsDragging(true);
          return;
      }

      if (e.touches.length === 2) {
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          lastTouchRef.current = [
              {x: t1.clientX, y: t1.clientY},
              {x: t2.clientX, y: t2.clientY}
          ];
          setIsDragging(false);
      }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
      // Native scroll prevention is handled by non-passive listener in useEffect
      if (isViewportUiTarget(e.target)) return;

      // Pan (1 finger)
      if (e.touches.length === 1 && lastTouchRef.current && lastTouchRef.current.length === 1) {
          const dx = e.touches[0].clientX - lastTouchRef.current[0].x;
          const dy = e.touches[0].clientY - lastTouchRef.current[0].y;
          
          setViewTransform(prev => ({
              ...prev,
              x: prev.x + dx,
              y: prev.y + dy
          }));
          
          lastTouchRef.current = [{x: e.touches[0].clientX, y: e.touches[0].clientY}];
          return;
      } 

      // Pan + Zoom (2 fingers)
      if (e.touches.length === 2 && lastTouchRef.current && lastTouchRef.current.length === 2) {
          const prevT1 = lastTouchRef.current[0];
          const prevT2 = lastTouchRef.current[1];
          const t1 = e.touches[0];
          const t2 = e.touches[1];

          const prevDist = Math.hypot(prevT1.x - prevT2.x, prevT1.y - prevT2.y);
          const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

          if (prevDist > 0) {
              const scaleFactor = currentDist / prevDist;
              const prevCenterX = (prevT1.x + prevT2.x) / 2;
              const prevCenterY = (prevT1.y + prevT2.y) / 2;
              const currentCenterX = (t1.clientX + t2.clientX) / 2;
              const currentCenterY = (t1.clientY + t2.clientY) / 2;

              setViewTransform(prev => {
                  const rect = containerRef.current?.getBoundingClientRect();
                  if (!rect) return prev;

                  let newScale = prev.scale * scaleFactor;
                  if (newScale < 0.005) newScale = 0.005;
                  if (newScale > 50) newScale = 50;

                  const prevMx = prevCenterX - rect.left;
                  const prevMy = prevCenterY - rect.top;
                  const mx = currentCenterX - rect.left;
                  const my = currentCenterY - rect.top;

                  // Keep the image point under the previous pinch center under the new center.
                  const imageX = (prevMx - prev.x) / prev.scale;
                  const imageY = (prevMy - prev.y) / prev.scale;

                  return {
                      x: mx - imageX * newScale,
                      y: my - imageY * newScale,
                      scale: newScale
                  };
              });
          }

          lastTouchRef.current = [
              {x: t1.clientX, y: t1.clientY},
              {x: t2.clientX, y: t2.clientY}
          ];
          setIsDragging(false);
      }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
      if (e.touches.length === 1) {
          lastTouchRef.current = [{x: e.touches[0].clientX, y: e.touches[0].clientY}];
          setIsDragging(true);
          return;
      }

      if (e.touches.length === 2) {
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          lastTouchRef.current = [
              {x: t1.clientX, y: t1.clientY},
              {x: t2.clientX, y: t2.clientY}
          ];
          setIsDragging(false);
          return;
      }

      setIsDragging(false);
      lastTouchRef.current = null;
  };

  const handleCacheLimitChange = (value: number) => {
    const next = clamp(Math.round(value), CACHE_MB_MIN, CACHE_MB_MAX);
    setMaxCacheMB(next);
  };

  // Compute inspector values for rendering
  const getInspectData = () => {
      if (!inspectCursor || !rawPixelData) return null;
      const { x, y } = inspectCursor;
      const idx = y * rawPixelData.width + x;
      
      const getValue = (name: string) => {
          if (!name || !rawPixelData.channels[name]) return 0;
          return rawPixelData.channels[name][idx];
      };

      const fileX = selectedPart?.dataWindow ? selectedPart.dataWindow.xMin + x : x;
      const fileY = selectedPart?.dataWindow ? selectedPart.dataWindow.yMin + y : y;

      return {
          x: fileX,
          y: fileY,
          r: getValue(displayMapping.r),
          g: getValue(displayMapping.g),
          b: getValue(displayMapping.b),
          a: getValue(channelMapping.a),
      };
  };

  const inspectData = getInspectData();

  const maxCacheBytes = clamp(maxCacheMB, CACHE_MB_MIN, CACHE_MB_MAX) * 1024 * 1024;
  const cacheUsagePercent = maxCacheBytes > 0
    ? Math.min(cacheStats.uniqueCacheBytes / maxCacheBytes, 1)
    : 0;
  const cacheExceeded = cacheStats.uniqueCacheBytes > maxCacheBytes;

  const toolbarToggleButtonClass = (isActive: boolean): string =>
    `toolbar-toggle-button p-1.5 rounded transition-colors ${isActive ? 'toolbar-toggle-button--active' : ''}`;

  const toolbarActionItemClass = (isActive: boolean): string =>
    `toolbar-action-item w-full flex items-center gap-2 px-2 py-2 rounded text-xs ${isActive ? 'toolbar-action-item--active' : ''}`;

  const toneControls = (
    <div className="flex items-center space-x-2 md:space-x-4 bg-neutral-800/50 rounded-lg px-2 py-1 border border-neutral-700 overflow-x-auto no-scrollbar max-w-full">
      <div className="flex items-center space-x-2 shrink-0">
        <button
          onClick={toggleExposure}
          className={`flex items-center justify-center p-1 rounded hover:bg-neutral-700 transition-colors ${exposure !== 0 ? 'text-teal-400' : 'text-neutral-400'}`}
          title="Toggle Exposure"
        >
          <Sun className="w-3.5 h-3.5" />
        </button>
        {!isMobile && (
          <span className="text-xs text-neutral-400">Exp:</span>
        )}
        <PrecisionSlider
          min={-10}
          max={10}
          step={0.01}
          value={exposure}
          onChange={setExposure}
          className="w-16 md:w-24"
          ariaLabel="Exposure"
        />
        {!isMobile && (
          <span className="text-xs font-mono w-8 text-right">{exposure.toFixed(2)}</span>
        )}
      </div>
      <div className="w-px h-4 bg-neutral-700 shrink-0"></div>
      <div className="flex items-center space-x-2 shrink-0">
        <button
          onClick={toggleGamma}
          className={`flex items-center justify-center p-1 rounded hover:bg-neutral-700 transition-colors ${Math.abs(gamma - 2.2) > 0.01 ? 'text-teal-400' : 'text-neutral-400'}`}
          title="Toggle Gamma"
        >
          <Monitor className="w-3.5 h-3.5" />
        </button>
        {!isMobile && (
          <span className="text-xs text-neutral-400">Gamma:</span>
        )}
        <PrecisionSlider
          min={0.1}
          max={4.0}
          step={0.01}
          value={gamma}
          onChange={setGamma}
          className="w-16 md:w-24"
          ariaLabel="Gamma"
        />
        {!isMobile && (
          <span className="text-xs font-mono w-8 text-right">{gamma.toFixed(2)}</span>
        )}
      </div>
    </div>
  );

  const sidebarPanes = [
    ...(sequenceSources.length > 0
      ? [
          {
            id: 'sources',
            initialRatio: 0.2,
            minSize: 110,
            content: (
              <SourcesPanel
                sequenceSources={sequenceSources.map((source) => ({
                  id: source.id,
                  label: source.label,
                  frameCount: source.frames.length,
                }))}
                selectedSequenceSourceId={selectedSequenceSourceId}
                onSelectSequenceSource={handleSelectSequenceSource}
              />
            ),
          },
        ]
      : []),
    {
      id: 'structure',
      initialRatio: 0.45,
      minSize: 180,
      content: (
        <StructurePanel
          structure={structure}
          onSelectPart={handleSelectPart}
          onSelectLayer={handleSelectLayer}
          onSelectChannel={handleSelectChannel}
          selectedPartId={selectedPartId}
          onOpenFile={() => fileInputRef.current?.click()}
        />
      ),
    },
    {
      id: 'logs',
      initialRatio: 0.35,
      minSize: 140,
      content: <LogPanel logs={logs} />,
    },
  ];

  return (
    <div
      className="flex h-screen w-screen box-border bg-neutral-950 text-neutral-200 font-sans overflow-hidden"
      style={{
        height: '100dvh',
        paddingTop: isMobile ? 'env(safe-area-inset-top)' : '0px',
        paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : '0px',
        paddingLeft: isMobile ? 'env(safe-area-inset-left)' : '0px',
        paddingRight: isMobile ? 'env(safe-area-inset-right)' : '0px',
      }}
    >
      
      {/* Sidebar Backdrop (Mobile Only) */}
      {isMobile && isSidebarOpen && (
          <div 
            className="absolute inset-0 bg-black/60 z-30 backdrop-blur-sm animate-in fade-in"
            onClick={() => setIsSidebarOpen(false)}
          />
      )}

      {/* Left Panel: Header + Sources + Structure + Logs */}
      {(isMobile || isSidebarOpen) && (
        <div
          className={`flex flex-col bg-neutral-900 z-40 h-full transition-transform duration-300 ease-in-out border-r border-neutral-800 shadow-2xl ${
            isMobile ? 'absolute top-0 left-0' : 'relative shrink-0'
          }`}
          style={{
            width: isMobile ? '85vw' : sidebarWidth,
            transform: isMobile && !isSidebarOpen ? 'translateX(-100%)' : 'none',
          }}
        >
          <SidebarLayout
            isMobile={isMobile}
            header={
              <SidebarHeader
                onOpenFile={() => fileInputRef.current?.click()}
                onOpenFolder={openFolderPicker}
              />
            }
            panes={sidebarPanes}
          />
        </div>
      )}

      {/* Vertical Splitter (Sidebar vs Main) - Desktop Only */}
      {!isMobile && isSidebarOpen && (
          <div
              className="w-1 bg-neutral-950 border-l border-r border-neutral-800/50 hover:bg-teal-500 cursor-col-resize z-40 transition-colors shrink-0"
              onMouseDown={(e) => { e.preventDefault(); setIsResizingSidebar(true); }}
          ></div>
      )}

      <div className={`flex-1 flex flex-col relative overflow-hidden min-w-0 ${isResizingSidebar ? 'pointer-events-none' : ''}`}>
        {/* Toolbar */}
        <div className="h-14 border-b border-neutral-800 bg-neutral-900 flex items-center px-4 justify-between shrink-0 z-20 relative shadow-md">
            
            {/* Left Group: Menu + Info */}
            <div className="flex items-center space-x-3 overflow-hidden">
                <button 
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    className="p-2 -ml-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors focus:outline-none"
                    title={isSidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
                >
                    <Menu className="w-5 h-5" />
                </button>

                <div className="flex flex-col truncate min-w-0">
                  <span className="font-semibold text-neutral-300 text-sm truncate">{fileName || "No File"}</span>
                  {structure && (
                    <span className="text-[10px] text-neutral-500 truncate">
                       {structure.isMultipart ? 'Multipart' : 'Single'} | {rawPixelData ? `${rawPixelData.width}x${rawPixelData.height}` : ''}
                    </span>
                  )}
                </div>



                {structure && !isMobile && (
                  <div className="hidden lg:flex items-center space-x-1">
                     <div className="px-1.5 py-0.5 bg-black/40 border border-red-900/50 rounded text-[10px] text-red-400 font-mono">
                        R:{displayMapping.r || '-'}
                     </div>
                     <div className="px-1.5 py-0.5 bg-black/40 border border-green-900/50 rounded text-[10px] text-green-400 font-mono">
                        G:{displayMapping.g || '-'}
                     </div>
                     <div className="px-1.5 py-0.5 bg-black/40 border border-blue-900/50 rounded text-[10px] text-blue-400 font-mono">
                        B:{displayMapping.b || '-'}
                     </div>
                     <div className="px-1.5 py-0.5 bg-black/40 border border-neutral-700 rounded text-[10px] text-neutral-300 font-mono">
                        View:{viewMode === 'alpha' ? 'A' : 'RGB'}
                     </div>
                  </div>
                )}
            </div>

            {/* Center Group: Tone Controls (Desktop) */}
            {!isMobile && (
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                {toneControls}
              </div>
            )}
            
            {/* Right Group: Actions + Mobile Tone Controls */}
            <div className={`flex items-center shrink-0 ${isMobile ? 'justify-end ml-2' : 'ml-auto'}`}>
              {isMobile && toneControls}
              {isMobile && <div className="h-6 w-px bg-neutral-800 mx-2 shrink-0"></div>}
              
              {!isMobile && (
                <div className="flex items-center space-x-1 shrink-0">
                  <button 
                      onClick={fitView}
                      className="p-1.5 rounded transition-colors bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700"
                      title="Fit to Screen"
                  >
                      <Maximize className="w-4 h-4" />
                  </button>

                  <button 
                      onClick={() => setShowHistogram(!showHistogram)}
                      className={toolbarToggleButtonClass(showHistogram)}
                      title="Toggle Histogram"
                  >
                      <BarChart3 className="w-4 h-4" />
                  </button>

                  <button 
                      onClick={() => setIsInspectMode(!isInspectMode)}
                      className={toolbarToggleButtonClass(isInspectMode)}
                      title="Pixel Inspector Tool"
                  >
                      <Crosshair className="w-4 h-4" />
                  </button>

                  <button 
                      onClick={() => setShowHelp(!showHelp)}
                      className={toolbarToggleButtonClass(showHelp)}
                      title="Help & Shortcuts"
                  >
                      <HelpCircle className="w-4 h-4" />
                  </button>

                    <button
                      onClick={() => setIsPreferencesOpen(true)}
                      className={toolbarToggleButtonClass(isPreferencesOpen)}
                      title="Preferences"
                    >
                      <SlidersHorizontal className="w-4 h-4" />
                    </button>
                </div>
              )}

              {isMobile && (
                <div className="relative shrink-0">
                  {isMobileActionsOpen && (
                    <button
                      className="fixed inset-0 z-30 cursor-default"
                      onClick={() => setIsMobileActionsOpen(false)}
                      aria-label="Close settings menu"
                    />
                  )}
                  <button
                    onClick={() => setIsMobileActionsOpen(prev => !prev)}
                    className={toolbarToggleButtonClass(isMobileActionsOpen)}
                    title="View Settings"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                  </button>

                  {isMobileActionsOpen && (
                    <div className="absolute right-0 top-full mt-2 z-40 w-44 rounded-lg border border-neutral-700 bg-neutral-900/95 backdrop-blur shadow-2xl p-1">
                      <button
                        onClick={() => { fitView(); setIsMobileActionsOpen(false); }}
                        className={toolbarActionItemClass(false)}
                      >
                        <Maximize className="w-3.5 h-3.5" />
                        Fit View
                      </button>
                      <button
                        onClick={() => { setShowHistogram(prev => !prev); setIsMobileActionsOpen(false); }}
                        className={toolbarActionItemClass(showHistogram)}
                      >
                        <BarChart3 className="w-3.5 h-3.5" />
                        Histogram
                      </button>
                      <button
                        onClick={() => { setIsInspectMode(prev => !prev); setIsMobileActionsOpen(false); }}
                        className={toolbarActionItemClass(isInspectMode)}
                      >
                        <Crosshair className="w-3.5 h-3.5" />
                        Inspector
                      </button>

                      <button
                        onClick={() => { setShowHelp(prev => !prev); setIsMobileActionsOpen(false); }}
                        className={toolbarActionItemClass(showHelp)}
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        Help
                      </button>

                      <button
                        onClick={() => { setIsPreferencesOpen(true); setIsMobileActionsOpen(false); }}
                        className={toolbarActionItemClass(isPreferencesOpen)}
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        Preferences
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
        </div>

        {/* Canvas / Main View */}
        <div 
            ref={containerRef}
            className={`flex-1 bg-neutral-950 relative overflow-hidden select-none ${canInteractWithViewport ? 'touch-none' : 'touch-auto'} ${isDragging ? 'cursor-grabbing' : isInspectMode ? 'cursor-crosshair' : 'cursor-default'}`}
            onWheel={canInteractWithViewport ? handleWheel : undefined}
            onMouseDown={canInteractWithViewport ? handleMouseDown : undefined}
            onMouseMove={canInteractWithViewport ? handleMouseMove : undefined}
            onMouseUp={canInteractWithViewport ? handleMouseUp : undefined}
            onMouseLeave={canInteractWithViewport ? handleMouseLeave : undefined}
            onTouchStart={canInteractWithViewport ? handleTouchStart : undefined}
            onTouchMove={canInteractWithViewport ? handleTouchMove : undefined}
            onTouchEnd={canInteractWithViewport ? handleTouchEnd : undefined}
            onTouchCancel={canInteractWithViewport ? handleTouchEnd : undefined}
        >
          {!structure ? (
              <div className="flex items-center justify-center h-full relative z-10 px-4">
                  <DropZone
                    onFileLoaded={handleSingleFileLoaded}
                    onFilesLoaded={bindFilesAsSequence}
                    onOpenFolder={openFolderPicker}
                    className="w-full max-w-md"
                  />
              </div>
          ) : (
              <>
                  <div 
                      className="absolute top-0 left-0 origin-top-left shadow-2xl"
                      style={{ 
                          transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
                          imageRendering: viewTransform.scale > 2 ? 'pixelated' : 'auto',
                          width: viewportReferenceRect?.width ?? rawPixelData?.width,
                          height: viewportReferenceRect?.height ?? rawPixelData?.height,
                      }}
                  >
                      {/* The canvas is positioned in display-window space but sized to data-window pixels. */}
                      <canvas
                        ref={canvasRef}
                        className="absolute block pointer-events-none"
                        style={{
                          left: (dataWindowRect ?? selectedPartDataWindowRect)?.x ?? 0,
                          top: (dataWindowRect ?? selectedPartDataWindowRect)?.y ?? 0,
                          visibility: rawPixelData ? 'visible' : 'hidden',
                        }}
                      />
                      
                      {selectedPartId === null && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-neutral-400 text-center px-4">
                              Select a part to decode
                          </div>
                      )}
                  </div>

                  {!areDataAndDisplayWindowsEqual && displayWindowScreenStyle && (
                      <div
                          className="window-bbox window-bbox--display"
                          style={displayWindowScreenStyle}
                          aria-hidden="true"
                      />
                  )}

                  {!areDataAndDisplayWindowsEqual && dataWindowScreenStyle && (
                      <div
                          className="window-bbox window-bbox--data"
                          style={dataWindowScreenStyle}
                          aria-hidden="true"
                      />
                  )}
              </>
          )}

          {/* Help Overlay */}
          {showHelp && (
              <div data-touch-ui="true" className="absolute top-4 right-4 z-50 w-72 bg-neutral-900/95 backdrop-blur border border-neutral-800 shadow-2xl rounded-lg p-4 animate-in fade-in slide-in-from-top-2 text-left">
                  <div className="flex justify-between items-start mb-3">
                      <h3 className="text-sm font-bold text-neutral-200 flex items-center">
                          <HelpCircle className="w-4 h-4 mr-2 text-teal-500"/> 
                          Controls & Shortcuts
                      </h3>
                      <button onClick={() => setShowHelp(false)} className="text-neutral-500 hover:text-white">
                          <X className="w-4 h-4" />
                      </button>
                  </div>
                  
                  <div className="space-y-3">
                      <div>
                          <h4 className="text-[10px] uppercase font-bold text-neutral-500 mb-1">Sidebar Navigation</h4>
                          <ul className="text-xs text-neutral-300 space-y-1 list-disc pl-4 marker:text-teal-500/50">
                              <li>Click <strong>Header</strong> to decode a specific part.</li>
                              <li>Click <strong>Layer Name</strong> to map RGB channels.</li>
                              <li>Click <strong>Channel</strong> to view in Grayscale.</li>
                              <li>Use <strong>Open Folder</strong> to bind EXR sequences.</li>
                          </ul>
                      </div>
                      
                      <div>
                          <h4 className="text-[10px] uppercase font-bold text-neutral-500 mb-1">Viewport</h4>
                          <ul className="text-xs text-neutral-300 space-y-1 list-disc pl-4 marker:text-teal-500/50">
                              <li><strong>Scroll</strong> to zoom in/out.</li>
                              <li><strong>Left/Middle Drag</strong> to pan image.</li>
                              <li><strong>Touch</strong>: Pinch to zoom, drag to pan.</li>
                              <li><strong>Dashed box</strong> is dataWindow; solid box is displayWindow (hidden when they match).</li>
                              <li><strong>A</strong> toggles RGB and Alpha view.</li>
                              <li>Use <strong>Inspector</strong> tool for pixel values.</li>
                              <li>Click <strong>Sun/Monitor</strong> icons to toggle defaults.</li>
                              <li><strong>← / →</strong> step frames; <strong>Space</strong> plays/pauses. Drag the scrubber to jump.</li>
                          </ul>
                      </div>
                  </div>
              </div>
          )}

          {isPreferencesOpen && (
            <PreferencesView
              isOpen={isPreferencesOpen}
              onClose={() => setIsPreferencesOpen(false)}
              cacheStats={cacheStats}
              maxCacheMB={maxCacheMB}
              maxCacheBytes={maxCacheBytes}
              cacheUsagePercent={cacheUsagePercent}
              cacheExceeded={cacheExceeded}
              onCacheLimitChange={handleCacheLimitChange}
              onPurgeCaches={purgeCaches}
              formatBytes={formatBytes}
            />
          )}

          {/* Histogram Overlay */}
          {structure && showHistogram && histogramData && (
              <HistogramOverlay data={histogramData} onClose={() => setShowHistogram(false)} />
          )}

          {/* Pixel Inspector Overlay */}
          {inspectData && isInspectMode && (
              <PixelInspector {...inspectData} visible={true} />
          )}


          {/* Floating Sequence Transport Bar */}
          {hasSequenceFrames && (
            <div
              data-touch-ui="true"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-2 rounded-xl border border-neutral-700/70 bg-neutral-900/85 backdrop-blur shadow-2xl"
              style={{ width: 'min(480px, calc(100% - 2rem))' }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              {/* Prev */}
              <button
                onClick={() => stepSequenceFrame(-1)}
                className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
                title="Previous Frame  (←)"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>

              {/* Play / Pause */}
              <button
                onClick={() => setIsSequencePlaying((prev) => !prev)}
                disabled={!canPlaySequence}
                className="shrink-0 p-1.5 rounded-lg text-neutral-200 hover:text-white hover:bg-teal-700/50 disabled:opacity-40 transition-colors"
                title={isSequencePlaying ? 'Pause  (Space)' : `Play  (Space) — ${DEFAULT_SEQUENCE_FPS} fps`}
              >
                {isSequencePlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>

              {/* Next */}
              <button
                onClick={() => stepSequenceFrame(1)}
                className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
                title="Next Frame  (→)"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>

              {/* Scrubber */}
              <PrecisionSlider
                min={0}
                max={Math.max(sequenceFrames.length - 1, 1)}
                step={1}
                value={safeSequenceFrameIndex ?? 0}
                onChange={(value) => {
                  setIsSequencePlaying(false);
                  sequenceAutoFitRef.current = false;
                  setSequenceFrameIndex(value);
                }}
                className="flex-1 min-w-0"
                ariaLabel={`Frame ${(safeSequenceFrameIndex ?? 0) + 1} of ${sequenceFrames.length}`}
                cacheMask={sequenceCacheMask}
              />

              {/* Frame counter */}
              <span className="shrink-0 text-[10px] font-mono text-neutral-400 tabular-nums select-none">
                {currentFrameLabel}
              </span>
            </div>
          )}

          {/* Hidden Input for Toolbar Button */}
          <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".exr"
              multiple
              onChange={handleGlobalFileInput}
          />
          <input
              type="file"
              ref={folderInputRef}
              className="hidden"
              accept=".exr"
              multiple
              onChange={handleGlobalFolderInput}
          />
        </div>
      </div>
    </div>
  );
}
