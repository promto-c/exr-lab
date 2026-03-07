import React from 'react';
import {
  BarChart3,
  Crosshair,
  HelpCircle,
  Maximize,
  Menu,
  Monitor,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import { DropZone } from './components/DropZone';
import { HistogramOverlay } from './components/HistogramOverlay';
import { LogPanel } from './components/LogPanel';
import { PixelInspector } from './components/PixelInspector';
import { PreferencesView, CACHE_MB_MAX, CACHE_MB_MIN } from './components/PreferencesView';
import { PrecisionSlider } from './components/PrecisionSlider';
import { SidebarHeader, SourcesPanel, StructurePanel } from './components/Sidebar';
import { SidebarLayout } from './components/SidebarLayout';
import { PrefetchStrategy } from './core/prefetch';
import { useCachePrefetch } from './features/cache/useCachePrefetch';
import { getLayerMapping, guessChannels } from './features/exr/channelMapping';
import { decodeExrPartToRaw, parseExrStructure } from './features/exr/decodePipeline';
import { readFileAsArrayBuffer } from './features/io/readFileAsArrayBuffer';
import {
  CACHE_STAGE_COLORS,
  clamp,
  getCurrentFrameLabel,
  getSafeSequenceFrameIndex,
  getSequenceCacheMask,
  type PlaybackMode,
} from './features/sequence/transport';
import {
  SequenceFrame,
  SequenceSource,
  buildSequenceSourcesFromFiles,
  isExrPath,
} from './features/sequence/sequenceUtils';
import { useSequenceTransport } from './features/sequence/useSequenceTransport';
import {
  type WindowRect,
  useViewportInteractions,
} from './features/viewport/useViewportInteractions';
import { mapExrErrorToLogEntry, mapExrEventToLogEntry } from './services/exr/logAdapter';
import { createRenderer, getRendererPreferenceFromQuery } from './services/render/createRenderer';
import {
  type ChannelMapping,
  type RawDecodeResult,
  type RenderBackend,
  type Renderer,
  type RendererPreference,
} from './services/render/types';
import { ExrStructure, LogEntry, LogStatus } from './types';

type FileLoadOptions = {
  autoFit?: boolean;
  displayName?: string;
  isFrameChange?: boolean;
};

const DEFAULT_SEQUENCE_FPS = 24;
const MAX_FRAME_CACHE = 500;
const DEFAULT_MAX_CACHE_MB = 4096;

type ViewMode = 'rgb' | 'alpha';

const isTextInputLikeTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'),
  );
};

export default function App() {
  const rendererPreference = React.useMemo<RendererPreference>(
    () => getRendererPreferenceFromQuery(),
    [],
  );

  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [structure, setStructure] = React.useState<ExrStructure | null>(null);
  const [selectedPartId, setSelectedPartId] = React.useState<number | null>(null);
  const [fileBuffer, setFileBuffer] = React.useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [sequenceSources, setSequenceSources] = React.useState<SequenceSource[]>([]);
  const [selectedSequenceSourceId, setSelectedSequenceSourceId] = React.useState<string | null>(
    null,
  );
  const [sequenceFrames, setSequenceFrames] = React.useState<SequenceFrame[]>([]);
  const [sequenceFrameIndex, setSequenceFrameIndex] = React.useState<number | null>(null);
  const [isSequencePlaying, setIsSequencePlaying] = React.useState(false);
  const [playbackMode, setPlaybackMode] = React.useState<PlaybackMode>('every');
  const [sequenceFps, setSequenceFps] = React.useState(DEFAULT_SEQUENCE_FPS);

  // Raw Data Cache (Map of Float32Arrays)
  const [rawPixelData, setRawPixelData] = React.useState<RawDecodeResult | null>(null);

  // Channel Mapping State
  const [channelMapping, setChannelMapping] = React.useState<ChannelMapping>({
    r: '',
    g: '',
    b: '',
    a: '',
  });
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
  const [cachePolicy, setCachePolicy] = React.useState<'oldest' | 'distance'>('oldest');
  const [cacheDistance, setCacheDistance] = React.useState(64);
  const [prefetchStrategy, setPrefetchStrategy] = React.useState<PrefetchStrategy>('forward');
  const [prefetchConcurrency, setPrefetchConcurrency] = React.useState(2);

  // Pixel Inspector State
  const [isInspectMode, setIsInspectMode] = React.useState(true);

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
  // Tracks which sequence frame ID the current rawPixelData belongs to.
  // Used by the cache-save effect so it never stores data under the wrong key.
  const decodedFrameIdRef = React.useRef<string | null>(null);
  const safeSequenceFrameIndex = React.useMemo<number | null>(
    () => getSafeSequenceFrameIndex(sequenceFrameIndex, sequenceFrames.length),
    [sequenceFrameIndex, sequenceFrames.length],
  );

  const {
    exrCacheRef,
    prefetchEngineRef,
    recentFrameIndicesRef,
    cacheStats,
    formatBytes,
    updateCacheStats,
    pruneCachesToLimit,
    purgeCaches,
  } = useCachePrefetch({
    rawPixelData,
    maxCacheMB,
    cachePolicy,
    cacheDistance,
    sequenceFrameIndex,
    sequenceFrames,
    safeSequenceFrameIndex,
    prefetchStrategy,
    prefetchConcurrency,
  });

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
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const canInteractWithViewport = Boolean(structure && rawPixelData);
  const hasSequenceFrames = sequenceFrames.length > 0;
  const canPlaySequence = sequenceFrames.length > 1;

  const sequenceCacheMask = React.useMemo(
    () => getSequenceCacheMask(sequenceFrames, exrCacheRef.current),
    [sequenceFrames, cacheStats.frameCacheCount, cacheStats.bufferCacheCount, exrCacheRef],
  );
  const selectedSequenceSource =
    selectedSequenceSourceId !== null
      ? (sequenceSources.find((source) => source.id === selectedSequenceSourceId) ?? null)
      : null;
  const currentFrameLabel = React.useMemo(
    () => getCurrentFrameLabel(safeSequenceFrameIndex, sequenceFrames),
    [safeSequenceFrameIndex, sequenceFrames],
  );

  React.useEffect(() => {
    if (!canPlaySequence && isSequencePlaying) {
      setIsSequencePlaying(false);
    }
  }, [canPlaySequence, isSequencePlaying]);

  const { stepSequenceFrame } = useSequenceTransport({
    hasSequenceFrames,
    canPlaySequence,
    isSequencePlaying,
    setIsSequencePlaying,
    playbackMode,
    sequenceFps,
    sequenceFrames,
    sequenceFrameIndex,
    setSequenceFrameIndex,
    isProcessing,
    exrCacheRef,
    sequenceAutoFitRef,
  });

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
    )
      return null;

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

  const viewportReferenceRect = React.useMemo<WindowRect | null>(
    () => displayWindowRect ?? dataWindowRect,
    [displayWindowRect, dataWindowRect],
  );

  const isViewportUiTarget = React.useCallback((target: EventTarget | null) => {
    const element =
      target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (!element) return false;
    return Boolean(
      element.closest(
        'button, input, select, textarea, a, label, [role="button"], [role="slider"], [data-touch-ui="true"]',
      ),
    );
  }, []);

  const {
    viewTransform,
    isDragging,
    inspectCursor,
    setInspectCursor,
    fitView,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useViewportInteractions({
    canInteractWithViewport,
    isMobile,
    viewportReferenceRect,
    rawPixelData,
    dataWindowRect,
    isInspectMode,
    isViewportUiTarget,
    containerRef,
  });

  const toScreenWindowRectStyle = React.useCallback(
    (rect: WindowRect): React.CSSProperties => {
      const { x, y, scale } = viewTransform;
      return {
        left: x + rect.x * scale,
        top: y + rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      };
    },
    [viewTransform],
  );

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
      setViewMode((prev) => (prev === 'rgb' ? 'alpha' : 'rgb'));
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [channelMapping.a, rawPixelData]);

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
    setLogs((prev) => [...prev, entry]);
  }, []);

  const switchToCpuFallback = React.useCallback(
    (reason: string) => {
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
      setRendererEpoch((prev) => prev + 1);

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
    },
    [handleLog],
  );

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
    setRendererEpoch((prev) => prev + 1);

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [handleLog, rendererPreference, structure, switchToCpuFallback]);

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
    prefetchEngineRef.current.stop();
    recentFrameIndicesRef.current = [];
    sequenceSelectionEpochRef.current += 1;
    sequenceAutoFitRef.current = false;
    decodedFrameIdRef.current = null;
    setSequenceSources([]);
    setSelectedSequenceSourceId(null);
    setSequenceFrames([]);
    setSequenceFrameIndex(null);
    setIsSequencePlaying(false);
    exrCacheRef.current.clearFrameCache();
    exrCacheRef.current.clearBufferCache();
    updateCacheStats();
  };

  const activateSequenceSource = (source: SequenceSource, autoFit = true) => {
    prefetchEngineRef.current.stop();
    recentFrameIndicesRef.current = [];
    sequenceSelectionEpochRef.current += 1;
    sequenceAutoFitRef.current = autoFit;
    setIsSequencePlaying(false);
    setSelectedSequenceSourceId(source.id);
    setSequenceFrames(source.frames);
    setSequenceFrameIndex(0);
    // Clear per-source caches when switching sequences
    exrCacheRef.current.clearFrameCache();
    exrCacheRef.current.clearBufferCache();
    updateCacheStats();
  };

  const handleFileLoaded = async (
    name: string,
    buffer: ArrayBuffer,
    options: FileLoadOptions = {},
  ) => {
    const epoch = ++decodeEpochRef.current;
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
    exrCacheRef.current.clearPartCache();
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

      const result = parseExrStructure(buffer, (event) => {
        handleLog(mapExrEventToLogEntry(event));
      });

      // Another frame may have been loaded while we were parsing (e.g. from
      // the decode cache).  Bail out so we don't overwrite its state.
      if (epoch !== decodeEpochRef.current) return;

      if (result) {
        setStructure(result);
        if (result.parts.length > 0) {
          setSelectedPartId(result.parts[0].id);
          setChannelMapping(guessChannels(result.parts[0].channels));
        }
      }
    } catch (error: unknown) {
      handleLog(mapExrErrorToLogEntry(error, 'parse.error'));
      console.error(error);
    } finally {
      if (epoch === decodeEpochRef.current) {
        setIsProcessing(false);
      }
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
    const frameText =
      selectedSource.frames.length > 1 ? `${selectedSource.frames.length} frames` : '1 frame';

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
      description:
        sources.length > 1
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
        const cached = exrCacheRef.current.getFrame(frame.id);
        if (cached) {
          if (requestId !== sequenceSelectionEpochRef.current) return;
          decodeEpochRef.current += 1;
          decodedFrameIdRef.current = frame.id;
          // Pre-populate part cache so the decode effect short-circuits
          exrCacheRef.current.clearPartCache();
          exrCacheRef.current.setPart(cached.partId, cached.rawPixelData);
          setFileName(selectedSequenceSource?.label ?? frame.relativePath);
          setLogs([]);
          setStructure(cached.structure);
          setSelectedPartId(cached.partId);
          setRawPixelData(cached.rawPixelData);
          setIsProcessing(false);
          return;
        }

        // 2. Check buffer cache (avoids re-reading from File)
        let buffer = exrCacheRef.current.getBuffer(frame.id);
        if (!buffer) {
          buffer = await readFileAsArrayBuffer(frame.file);
          // Always cache the buffer โ€” the I/O work is already done.
          exrCacheRef.current.setBuffer(frame.id, buffer);
          pruneCachesToLimit();
          updateCacheStats();
          if (requestId !== sequenceSelectionEpochRef.current) return;
        } else {
          if (requestId !== sequenceSelectionEpochRef.current) return;
        }

        decodedFrameIdRef.current = frame.id;
        await handleFileLoaded(frame.name, buffer, {
          autoFit: shouldAutoFit,
          displayName: selectedSequenceSource?.label ?? frame.relativePath,
          isFrameChange: true,
        });
      } catch (error: unknown) {
        if (requestId !== sequenceSelectionEpochRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        handleLog({
          id: `sequence-load-error-${Date.now()}`,
          stepId: 'sequence',
          title: 'Sequence Frame Load Failed',
          status: LogStatus.Error,
          ms: 0,
          metrics: [{ label: 'Frame', value: frame.relativePath }],
          description: message,
        });
      }
    };

    void loadSelectedFrame();
  }, [safeSequenceFrameIndex, selectedSequenceSource?.label, sequenceFrames]);

  const handleSelectPart = (partId: number) => {
    if (selectedPartId !== partId) {
      // Clear sequence frame ref so a part-switch decode doesn't accidentally
      // save under a stale sequence frame key.
      decodedFrameIdRef.current = null;
      const cachedRaw = exrCacheRef.current.getPart(partId) ?? null;
      setRawPixelData(cachedRaw);
      // don't clear histogram here โ€“ keep the old bars visible until the new
      // render effect replaces them, which avoids a flash when switching parts
      setInspectCursor(null);
      setSelectedPartId(partId);
    }
    if (structure) {
      // Automatically guess default channels when switching parts explicitly
      const part = structure.parts.find((p) => p.id === partId);
      if (part) {
        setChannelMapping(guessChannels(part.channels));
      }
    }
    if (isMobile) setIsSidebarOpen(false);
  };

  // 1. Heavy Lifting: Decode binary when part changes
  React.useEffect(() => {
    if (!fileBuffer || !structure || selectedPartId === null) return;

    // Capture the sequence-frame ID synchronously before any async work.
    // This ties the decoded data to the correct frame even when the user
    // scrubs to a different frame while the decode is in-flight.
    const frameIdForCache = decodedFrameIdRef.current;

    // Check Cache First
    const cachedPart = exrCacheRef.current.getPart(selectedPartId);
    if (cachedPart) {
      setRawPixelData(cachedPart);
      return;
    }

    const requestEpoch = ++decodeEpochRef.current;

    const decode = async () => {
      setIsProcessing(true);
      try {
        const rawResult = await decodeExrPartToRaw(fileBuffer, structure, selectedPartId, (event) =>
          handleLog(mapExrEventToLogEntry(event)),
        );

        // Always cache the decoded result — even when the user has
        // already navigated to a different frame. This ensures
        // background decodes transition from 'buffer' (orange) to
        // 'decoded' without requiring the user to revisit the frame.
        exrCacheRef.current.setPart(selectedPartId, rawResult);

        if (frameIdForCache) {
          exrCacheRef.current.setFrame(frameIdForCache, {
            structure,
            rawPixelData: rawResult,
            partId: selectedPartId,
          });
          if (exrCacheRef.current.getFrameCacheSize() > MAX_FRAME_CACHE) {
            exrCacheRef.current.deleteOldestFrame();
          }
        }

        pruneCachesToLimit();
        updateCacheStats();

        // Only update UI state if this is still the active request.
        if (requestEpoch !== decodeEpochRef.current) return;

        setRawPixelData(rawResult);
      } catch (error: unknown) {
        handleLog(mapExrErrorToLogEntry(error, 'decode.error'));
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
        params: { exposure, gamma },
      });

      setHistogramData(result.histogram);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Unknown render error';
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
  }, [
    rawPixelData,
    exposure,
    gamma,
    displayMapping,
    rendererEpoch,
    handleLog,
    switchToCpuFallback,
  ]);

  // 3. Auto-fit once per file load; preserve zoom/pan for subsequent updates
  React.useEffect(() => {
    if (!rawPixelData || !shouldAutoFitRef.current) return;
    fitView();
    shouldAutoFitRef.current = false;
  }, [rawPixelData, fitView]);

  // --- Sidebar Handlers ---

  const handleSelectLayer = (partId: number, layerPrefix: string) => {
    if (selectedPartId !== partId) {
      const cachedRaw = exrCacheRef.current.getPart(partId) ?? null;
      setRawPixelData(cachedRaw);
      // do not clear histogram here for the same reason as handleSelectPart
      setInspectCursor(null);
      setSelectedPartId(partId);
    }
    if (!structure) return;

    const part = structure.parts.find((p) => p.id === partId);
    if (part) {
      const newMapping = getLayerMapping(part.channels, layerPrefix);
      setChannelMapping(newMapping);
    }
    if (isMobile) setIsSidebarOpen(false);
  };

  const handleSelectChannel = (partId: number, channelName: string) => {
    if (selectedPartId !== partId) {
      const cachedRaw = exrCacheRef.current.getPart(partId) ?? null;
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
      a: '',
    });
    if (isMobile) setIsSidebarOpen(false);
  };
  const handleCacheLimitChange = (value: number) => {
    const next = clamp(Math.round(value), CACHE_MB_MIN, CACHE_MB_MAX);
    setMaxCacheMB(next);
  };

  const handleCachePolicyChange = (policy: 'oldest' | 'distance') => {
    setCachePolicy(policy);
  };

  const handleCacheDistanceChange = (value: number) => {
    setCacheDistance(Math.max(0, Math.round(value)));
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
  const cacheUsagePercent =
    maxCacheBytes > 0 ? Math.min(cacheStats.uniqueCacheBytes / maxCacheBytes, 1) : 0;
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
        {!isMobile && <span className="text-xs text-neutral-400">Exp:</span>}
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
        {!isMobile && <span className="text-xs text-neutral-400">Gamma:</span>}
        <PrecisionSlider
          min={0.1}
          max={4.0}
          step={0.01}
          value={gamma}
          onChange={setGamma}
          className="w-16 md:w-24"
          ariaLabel="Gamma"
        />
        {!isMobile && <span className="text-xs font-mono w-8 text-right">{gamma.toFixed(2)}</span>}
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
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizingSidebar(true);
          }}
        ></div>
      )}

      <div
        className={`flex-1 flex flex-col relative overflow-hidden min-w-0 ${isResizingSidebar ? 'pointer-events-none' : ''}`}
      >
        {/* Toolbar */}
        <div className="h-14 border-b border-neutral-800 bg-neutral-900 flex items-center px-4 justify-between shrink-0 z-20 relative shadow-md">
          {/* Left Group: Menu + Info */}
          <div className="flex items-center space-x-3 overflow-hidden">
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 -ml-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors focus:outline-none"
              title={isSidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex flex-col truncate min-w-0">
              <span className="font-semibold text-neutral-300 text-sm truncate">
                {fileName || 'No File'}
              </span>
              {structure && (
                <span className="text-[10px] text-neutral-500 truncate">
                  {structure.isMultipart ? 'Multipart' : 'Single'} |{' '}
                  {rawPixelData ? `${rawPixelData.width}x${rawPixelData.height}` : ''}
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
          <div
            className={`flex items-center shrink-0 ${isMobile ? 'justify-end ml-2' : 'ml-auto'}`}
          >
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
                  onClick={() => setIsMobileActionsOpen((prev) => !prev)}
                  className={toolbarToggleButtonClass(isMobileActionsOpen)}
                  title="View Settings"
                >
                  <SlidersHorizontal className="w-4 h-4" />
                </button>

                {isMobileActionsOpen && (
                  <div className="absolute right-0 top-full mt-2 z-40 w-44 rounded-lg border border-neutral-700 bg-neutral-900/95 backdrop-blur shadow-2xl p-1">
                    <button
                      onClick={() => {
                        fitView();
                        setIsMobileActionsOpen(false);
                      }}
                      className={toolbarActionItemClass(false)}
                    >
                      <Maximize className="w-3.5 h-3.5" />
                      Fit View
                    </button>
                    <button
                      onClick={() => {
                        setShowHistogram((prev) => !prev);
                        setIsMobileActionsOpen(false);
                      }}
                      className={toolbarActionItemClass(showHistogram)}
                    >
                      <BarChart3 className="w-3.5 h-3.5" />
                      Histogram
                    </button>
                    <button
                      onClick={() => {
                        setIsInspectMode((prev) => !prev);
                        setIsMobileActionsOpen(false);
                      }}
                      className={toolbarActionItemClass(isInspectMode)}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                      Inspector
                    </button>

                    <button
                      onClick={() => {
                        setShowHelp((prev) => !prev);
                        setIsMobileActionsOpen(false);
                      }}
                      className={toolbarActionItemClass(showHelp)}
                    >
                      <HelpCircle className="w-3.5 h-3.5" />
                      Help
                    </button>

                    <button
                      onClick={() => {
                        setIsPreferencesOpen(true);
                        setIsMobileActionsOpen(false);
                      }}
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
            <div
              data-touch-ui="true"
              className="absolute top-4 right-4 z-50 w-72 bg-neutral-900/95 backdrop-blur border border-neutral-800 shadow-2xl rounded-lg p-4 animate-in fade-in slide-in-from-top-2 text-left"
            >
              <div className="flex justify-between items-start mb-3">
                <h3 className="text-sm font-bold text-neutral-200 flex items-center">
                  <HelpCircle className="w-4 h-4 mr-2 text-teal-500" />
                  Controls & Shortcuts
                </h3>
                <button
                  onClick={() => setShowHelp(false)}
                  className="text-neutral-500 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <h4 className="text-[10px] uppercase font-bold text-neutral-500 mb-1">
                    Sidebar Navigation
                  </h4>
                  <ul className="text-xs text-neutral-300 space-y-1 list-disc pl-4 marker:text-teal-500/50">
                    <li>
                      Click <strong>Header</strong> to decode a specific part.
                    </li>
                    <li>
                      Click <strong>Layer Name</strong> to map RGB channels.
                    </li>
                    <li>
                      Click <strong>Channel</strong> to view in Grayscale.
                    </li>
                    <li>
                      Use <strong>Open Folder</strong> to bind EXR sequences.
                    </li>
                  </ul>
                </div>

                <div>
                  <h4 className="text-[10px] uppercase font-bold text-neutral-500 mb-1">
                    Viewport
                  </h4>
                  <ul className="text-xs text-neutral-300 space-y-1 list-disc pl-4 marker:text-teal-500/50">
                    <li>
                      <strong>Scroll</strong> to zoom in/out.
                    </li>
                    <li>
                      <strong>Left/Middle Drag</strong> to pan image.
                    </li>
                    <li>
                      <strong>Touch</strong>: Pinch to zoom, drag to pan.
                    </li>
                    <li>
                      <strong>Dashed box</strong> is dataWindow; solid box is displayWindow (hidden
                      when they match).
                    </li>
                    <li>
                      <strong>A</strong> toggles RGB and Alpha view.
                    </li>
                    <li>
                      Use <strong>Inspector</strong> tool for pixel values.
                    </li>
                    <li>
                      Click <strong>Sun/Monitor</strong> icons to toggle defaults.
                    </li>
                    <li>
                      <strong>โ / โ’</strong> step frames; <strong>Space</strong> plays/pauses. Drag
                      the scrubber to jump.
                    </li>
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
              cachePolicy={cachePolicy}
              cacheDistance={cacheDistance}
              onCachePolicyChange={handleCachePolicyChange}
              onCacheDistanceChange={handleCacheDistanceChange}
              onPurgeCaches={purgeCaches}
              formatBytes={formatBytes}
              playbackMode={playbackMode}
              onPlaybackModeChange={setPlaybackMode}
              sequenceFps={sequenceFps}
              onSequenceFpsChange={setSequenceFps}
              prefetchStrategy={prefetchStrategy}
              onPrefetchStrategyChange={setPrefetchStrategy}
              prefetchConcurrency={prefetchConcurrency}
              onPrefetchConcurrencyChange={setPrefetchConcurrency}
            />
          )}

          {/* Histogram Overlay */}
          {structure && showHistogram && histogramData && (
            <HistogramOverlay data={histogramData} onClose={() => setShowHistogram(false)} />
          )}

          {/* Pixel Inspector Overlay */}
          {inspectData && isInspectMode && <PixelInspector {...inspectData} visible={true} />}

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
                title="Previous Frame  (โ)"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>

              {/* Play / Pause */}
              <button
                onClick={() => setIsSequencePlaying((prev) => !prev)}
                disabled={!canPlaySequence}
                className="shrink-0 p-1.5 rounded-lg text-neutral-200 hover:text-white hover:bg-teal-700/50 disabled:opacity-40 transition-colors"
                title={
                  isSequencePlaying ? 'Pause  (Space)' : `Play  (Space) โ€” ${sequenceFps} fps`
                }
              >
                {isSequencePlaying ? (
                  <Pause className="w-3.5 h-3.5" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
              </button>

              {/* Next */}
              <button
                onClick={() => stepSequenceFrame(1)}
                className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
                title="Next Frame  (โ’)"
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
                segmentColors={sequenceCacheMask.map((s) => CACHE_STAGE_COLORS[s])}
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
