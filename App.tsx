import React from 'react';
import { SidebarHeader, SourcesPanel, StructurePanel } from './components/Sidebar';
import { SidebarLayout } from './components/SidebarLayout';
import { LogPanel } from './components/LogPanel';
import { DropZone } from './components/DropZone';
import { HistogramOverlay } from './components/HistogramOverlay';
import { PixelInspector } from './components/PixelInspector';
import { ExrParser } from './services/exrParser';
import { ExrDecoder } from './services/exr/decoder';
import { createRenderer, getRendererPreferenceFromQuery } from './services/render/createRenderer';
import { RenderBackend, Renderer, RendererPreference, RawDecodeResult, ChannelMapping } from './services/render/types';
import { LogEntry, ExrStructure, LogStatus, ExrChannel } from './types';
import { Sun, Monitor, BarChart3, Maximize, Crosshair, HelpCircle, X, Menu, SlidersHorizontal } from 'lucide-react';

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
};

const EXR_FILE_PATTERN = /\.exr$/i;
const DEFAULT_SEQUENCE_FPS = 24;

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

type PrecisionSliderProps = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  className?: string;
  thresholdScale?: number;
};

type PrecisionSliderDragState = {
  pointerId: number;
  lastX: number;
  currentValue: number;
  centerY: number;
  range: number;
  trackWidth: number;
  precisionThreshold: number;
};

type PrecisionSliderStyle = React.CSSProperties & {
  '--value-pct': string;
  '--precision-scale': string;
};

type ViewMode = 'rgb' | 'alpha';
type WindowRect = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const isTextInputLikeTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
};

const getStepPrecision = (step: number): number => {
  const text = String(step).toLowerCase();
  if (!text.includes('e-')) {
    const dot = text.indexOf('.');
    return dot >= 0 ? text.length - dot - 1 : 0;
  }

  const [base, exponentText] = text.split('e-');
  const exponent = Number.parseInt(exponentText ?? '0', 10);
  const dot = base.indexOf('.');
  const basePrecision = dot >= 0 ? base.length - dot - 1 : 0;
  return basePrecision + exponent;
};

const snapToStep = (value: number, min: number, step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return value;
  const precision = getStepPrecision(step);
  const snapped = min + Math.round((value - min) / step) * step;
  return Number(snapped.toFixed(precision));
};

const valueToPercent = (value: number, min: number, max: number): number => {
  if (max <= min) return 0;
  return ((clamp(value, min, max) - min) / (max - min)) * 100;
};

const pointerToValue = (
  clientX: number,
  rect: DOMRect,
  min: number,
  max: number,
  step: number
): number => {
  if (max <= min) return min;
  const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  const raw = min + ratio * (max - min);
  return snapToStep(raw, min, step);
};

const PrecisionSlider = ({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  className = '',
  thresholdScale = 1,
}: PrecisionSliderProps) => {
  const sliderRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<PrecisionSliderDragState | null>(null);
  const [precisionScale, setPrecisionScale] = React.useState(1);

  const valuePct = React.useMemo(() => valueToPercent(value, min, max), [value, min, max]);

  const commitValue = React.useCallback((next: number): number => {
    const snapped = snapToStep(next, min, step);
    const clamped = clamp(snapped, min, max);
    onChange(clamped);
    return clamped;
  }, [max, min, onChange, step]);

  const releaseDrag = React.useCallback(() => {
    dragRef.current = null;
    setPrecisionScale(1);
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.button !== 0) return;

    const slider = sliderRef.current;
    if (!slider) return;

    const rect = slider.getBoundingClientRect();
    const initialValue = pointerToValue(event.clientX, rect, min, max, step);
    const committedValue = commitValue(initialValue);

    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      currentValue: committedValue,
      centerY: rect.top + rect.height / 2,
      range: max - min,
      trackWidth: Math.max(rect.width, 1),
      precisionThreshold: Math.max(rect.height * thresholdScale, 1),
    };

    setPrecisionScale(1);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [commitValue, max, min, step, thresholdScale]);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const perpendicularDistance = Math.abs(event.clientY - drag.centerY);
    const distanceScale =
      perpendicularDistance <= drag.precisionThreshold
        ? 1
        : drag.precisionThreshold / perpendicularDistance;

    setPrecisionScale(distanceScale);

    const horizontalDelta = event.clientX - drag.lastX;
    if (horizontalDelta === 0) return;

    const scaledDelta = (horizontalDelta / drag.trackWidth) * drag.range * distanceScale;
    const committedValue = commitValue(drag.currentValue + scaledDelta);

    drag.currentValue = committedValue;
    drag.lastX = event.clientX;
  }, [commitValue]);

  const handlePointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    releaseDrag();
  }, [releaseDrag]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextValue: number | null = null;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextValue = value - step;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextValue = value + step;
    if (event.key === 'PageDown') nextValue = value - step * 10;
    if (event.key === 'PageUp') nextValue = value + step * 10;
    if (event.key === 'Home') nextValue = min;
    if (event.key === 'End') nextValue = max;

    if (nextValue === null) return;

    event.preventDefault();
    commitValue(nextValue);
  }, [commitValue, max, min, step, value]);

  const style: PrecisionSliderStyle = {
    '--value-pct': `${valuePct}%`,
    '--precision-scale': `${precisionScale}`,
  };

  return (
    <div
      ref={sliderRef}
      className={`tone-slider ${className}`.trim()}
      style={style}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={releaseDrag}
      onKeyDown={handleKeyDown}
    >
      <div className="tone-slider__track" aria-hidden="true" />
      <div className="tone-slider__fill" aria-hidden="true" />
      <div className="tone-slider__handle" aria-hidden="true" />
    </div>
  );
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

  // Pixel Inspector State
  const [isInspectMode, setIsInspectMode] = React.useState(true);
  const [inspectCursor, setInspectCursor] = React.useState<{x: number, y: number} | null>(null);

  // Transform State (Zoom/Pan)
  const [viewTransform, setViewTransform] = React.useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragStart, setDragStart] = React.useState({ x: 0, y: 0 });

  // Touch State
  const lastTouchRef = React.useRef<{x: number, y: number}[] | null>(null);

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
  const selectedSequenceSource =
    selectedSequenceSourceId !== null
      ? sequenceSources.find((source) => source.id === selectedSequenceSourceId) ?? null
      : null;
  const safeSequenceFrameIndex =
    sequenceFrameIndex !== null
      ? clamp(sequenceFrameIndex, 0, Math.max(sequenceFrames.length - 1, 0))
      : null;

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
      element.closest('button, input, select, textarea, a, label, [role="button"], [data-touch-ui="true"]')
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
      if (isViewportUiTarget(e.target)) return;
      e.preventDefault();
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
  };

  const activateSequenceSource = (source: SequenceSource, autoFit = true) => {
    sequenceSelectionEpochRef.current += 1;
    sequenceAutoFitRef.current = autoFit;
    setIsSequencePlaying(false);
    setSelectedSequenceSourceId(source.id);
    setSequenceFrames(source.frames);
    setSequenceFrameIndex(0);
  };

  const handleFileLoaded = async (name: string, buffer: ArrayBuffer, options: FileLoadOptions = {}) => {
    decodeEpochRef.current += 1;
    shouldAutoFitRef.current = options.autoFit ?? true;
    const displayName = options.displayName ?? name;

    setFileName(displayName);
    setFileBuffer(buffer);
    setLogs([]);
    setStructure(null);
    setSelectedPartId(null);
    setHistogramData(null);
    setRawPixelData(null);
    setViewMode('rgb');
    setInspectCursor(null);
    setIsProcessing(true);

    // Close sidebar on mobile when file loaded
    if (isMobile) setIsSidebarOpen(false);

    // Clear the part cache when loading a new file
    partCacheRef.current.clear();

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
        const buffer = await readFileAsArrayBuffer(frame.file);
        if (requestId !== sequenceSelectionEpochRef.current) return;
        await handleFileLoaded(frame.name, buffer, {
          autoFit: shouldAutoFit,
          displayName: selectedSequenceSource?.label ?? frame.relativePath,
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

  const handleSelectPart = (partId: number) => {
    if (selectedPartId !== partId) {
      const cachedRaw = partCacheRef.current.get(partId) ?? null;
      setRawPixelData(cachedRaw);
      setHistogramData(null);
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
          setHistogramData(null);
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
          setHistogramData(null);
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
            mobileSize: 'auto' as const,
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
      mobileSize: 'fill' as const,
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
      mobileSize: '40%',
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

                {hasSequenceFrames && !isMobile && (
                  <div className="flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-800/60 px-1.5 py-1 shrink-0">
                    <button
                      onClick={() => stepSequenceFrame(-1)}
                      disabled={isProcessing}
                      className="px-2 py-1 rounded text-[10px] font-medium text-neutral-300 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Previous Frame"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => setIsSequencePlaying((prev) => !prev)}
                      disabled={!canPlaySequence}
                      className="px-2 py-1 rounded text-[10px] font-medium text-neutral-200 bg-teal-700/40 hover:bg-teal-600/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title={isSequencePlaying ? 'Pause Playback' : `Play Sequence (${DEFAULT_SEQUENCE_FPS} fps)`}
                    >
                      {isSequencePlaying ? 'Pause' : 'Play'}
                    </button>
                    <button
                      onClick={() => stepSequenceFrame(1)}
                      disabled={isProcessing}
                      className="px-2 py-1 rounded text-[10px] font-medium text-neutral-300 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Next Frame"
                    >
                      Next
                    </button>
                  </div>
                )}

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
            <div className={`flex items-center min-w-0 ${isMobile ? 'flex-1 justify-end ml-2' : 'ml-auto shrink-0'}`}>
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
                      {hasSequenceFrames && (
                        <button
                          onClick={() => { stepSequenceFrame(-1); setIsMobileActionsOpen(false); }}
                          className={toolbarActionItemClass(false)}
                        >
                          Prev Frame
                        </button>
                      )}
                      {hasSequenceFrames && (
                        <button
                          onClick={() => {
                            setIsSequencePlaying(prev => !prev);
                            setIsMobileActionsOpen(false);
                          }}
                          className={toolbarActionItemClass(isSequencePlaying)}
                        >
                          {isSequencePlaying ? 'Pause Sequence' : `Play Sequence (${DEFAULT_SEQUENCE_FPS} fps)`}
                        </button>
                      )}
                      {hasSequenceFrames && (
                        <button
                          onClick={() => { stepSequenceFrame(1); setIsMobileActionsOpen(false); }}
                          className={toolbarActionItemClass(false)}
                        >
                          Next Frame
                        </button>
                      )}
                      <button
                        onClick={() => { setShowHelp(prev => !prev); setIsMobileActionsOpen(false); }}
                        className={toolbarActionItemClass(showHelp)}
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        Help
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
          
          {/* Loading Overlay */}
          {isProcessing && (
              <div className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center pointer-events-none">
                  <div className="w-8 h-8 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                  <span className="text-sm font-medium text-teal-300">Processing EXR Data...</span>
              </div>
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
                              <li><strong>Prev/Play/Next</strong> controls scrub bound sequences.</li>
                          </ul>
                      </div>
                  </div>
              </div>
          )}

          {/* Histogram Overlay */}
          {structure && showHistogram && histogramData && (
              <HistogramOverlay data={histogramData} onClose={() => setShowHistogram(false)} />
          )}

          {/* Pixel Inspector Overlay */}
          {inspectData && isInspectMode && (
              <PixelInspector {...inspectData} visible={true} />
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
