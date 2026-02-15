import React from 'react';
import { Sidebar } from './components/Sidebar';
import { LogPanel } from './components/LogPanel';
import { DropZone } from './components/DropZone';
import { HistogramOverlay } from './components/HistogramOverlay';
import { PixelInspector } from './components/PixelInspector';
import { ExrParser } from './services/exrParser';
import { ExrDecoder } from './services/exr/decoder';
import { createRenderer, getRendererPreferenceFromQuery } from './services/render/createRenderer';
import { RenderBackend, Renderer, RendererPreference, RawDecodeResult, ChannelMapping } from './services/render/types';
import { LogEntry, ExrStructure, LogStatus, ExrChannel } from './types';
import { Sun, Monitor, BarChart3, Maximize, Crosshair, HelpCircle, X } from 'lucide-react';

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

export default function App() {
  const rendererPreference = React.useMemo<RendererPreference>(() => getRendererPreferenceFromQuery(), []);

  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [structure, setStructure] = React.useState<ExrStructure | null>(null);
  const [selectedPartId, setSelectedPartId] = React.useState<number | null>(null);
  const [fileBuffer, setFileBuffer] = React.useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [isProcessing, setIsProcessing] = React.useState(false);

  // Raw Data Cache (Map of Float32Arrays)
  const [rawPixelData, setRawPixelData] = React.useState<RawDecodeResult | null>(null);
  
  // Decoded Part Cache
  const partCacheRef = React.useRef<Map<number, RawDecodeResult>>(new Map());

  // Channel Mapping State
  const [channelMapping, setChannelMapping] = React.useState<ChannelMapping>({ r: '', g: '', b: '', a: '' });

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

  // Help State
  const [showHelp, setShowHelp] = React.useState(false);

  // Layout State
  const [sidebarWidth, setSidebarWidth] = React.useState(320);
  const [logHeight, setLogHeight] = React.useState(() => window.innerHeight / 2);
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false);
  const [isResizingLogs, setIsResizingLogs] = React.useState(false);

  // Refs
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const rendererRef = React.useRef<Renderer | null>(null);
  const decodeEpochRef = React.useRef(0);

  // Resize Handlers
  React.useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const newWidth = Math.max(200, Math.min(e.clientX, 800));
        setSidebarWidth(newWidth);
      }
      if (isResizingLogs) {
        const newHeight = Math.max(100, Math.min(window.innerHeight - e.clientY, window.innerHeight - 200));
        setLogHeight(newHeight);
      }
    };

    const handleGlobalMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingLogs(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    if (isResizingSidebar || isResizingLogs) {
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
      document.body.style.cursor = isResizingSidebar ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
  }, [isResizingSidebar, isResizingLogs]);

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
    if (!rawPixelData || !containerRef.current) return;
    
    const { width, height } = rawPixelData;
    const { clientWidth, clientHeight } = containerRef.current;
    
    const padding = 60;
    const availW = clientWidth - padding;
    const availH = clientHeight - padding;
    
    const scale = Math.min(availW / width, availH / height);
    const finalScale = scale > 0 ? scale : 1; 

    const x = (clientWidth - width * finalScale) / 2;
    const y = (clientHeight - height * finalScale) / 2;

    setViewTransform({ x, y, scale: finalScale });
  }, [rawPixelData]);

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

  const handleFileLoaded = async (name: string, buffer: ArrayBuffer) => {
    decodeEpochRef.current += 1;
    setFileName(name);
    setFileBuffer(buffer);
    setLogs([]); 
    setStructure(null);
    setSelectedPartId(null);
    setHistogramData(null); 
    setRawPixelData(null);
    setInspectCursor(null);
    setIsProcessing(true);
    
    // Clear the part cache when loading a new file
    partCacheRef.current.clear();

    try {
      const fileSizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);
      
      handleLog({
        id: 'init',
        stepId: 'init',
        title: 'File Loaded',
        status: LogStatus.Start,
        ms: 0,
        metrics: [
          { label: 'File', value: name },
          { label: 'Size', value: `${fileSizeMB} MB` }
        ]
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
        description: rendererFallbackReason || undefined
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
        id: 'error',
        stepId: 'crash',
        title: 'Unexpected Error',
        status: LogStatus.Error,
        ms: 0,
        metrics: [],
        description: e.message
      });
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleGlobalFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
              if (evt.target?.result) {
                  handleFileLoaded(file.name, evt.target.result as ArrayBuffer);
              }
          };
          reader.readAsArrayBuffer(file);
      }
      e.target.value = '';
  };

  const handleSelectPart = (partId: number) => {
    setSelectedPartId(partId);
    if (structure) {
        // Automatically guess default channels when switching parts explicitly
        const part = structure.parts.find(p => p.id === partId);
        if (part) {
            setChannelMapping(guessChannels(part.channels));
        }
    }
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
            mapping: channelMapping,
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

  }, [rawPixelData, exposure, gamma, channelMapping, rendererEpoch, handleLog, switchToCpuFallback]);

  // 3. Reset view when new data arrives
  React.useEffect(() => {
      if (rawPixelData) {
          fitView();
      }
  }, [rawPixelData, fitView]);

  // --- Sidebar Handlers ---

  const handleSelectLayer = (partId: number, layerPrefix: string) => {
      if (selectedPartId !== partId) setSelectedPartId(partId);
      if (!structure) return;
      
      const part = structure.parts.find(p => p.id === partId);
      if (part) {
          const newMapping = getLayerMapping(part.channels, layerPrefix);
          setChannelMapping(newMapping);
      }
  };

  const handleSelectChannel = (partId: number, channelName: string) => {
      if (selectedPartId !== partId) setSelectedPartId(partId);
      // Map R, G, B to the same channel for grayscale visualization
      setChannelMapping({
          r: channelName,
          g: channelName,
          b: channelName,
          a: ''
      });
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
      
      // Update inspector if active
      if (isInspectMode && inspectCursor) {
          // Re-verify under cursor? For now just let mouse move handle it
      }
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
      if (isInspectMode && rawPixelData && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          
          // Image Space
          const ix = Math.floor((mx - viewTransform.x) / viewTransform.scale);
          const iy = Math.floor((my - viewTransform.y) / viewTransform.scale);
          
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

  // Compute inspector values for rendering
  const getInspectData = () => {
      if (!inspectCursor || !rawPixelData) return null;
      const { x, y } = inspectCursor;
      const idx = y * rawPixelData.width + x;
      
      const getValue = (name: string) => {
          if (!name || !rawPixelData.channels[name]) return 0;
          return rawPixelData.channels[name][idx];
      };

      return {
          x, y,
          r: getValue(channelMapping.r),
          g: getValue(channelMapping.g),
          b: getValue(channelMapping.b),
          a: getValue(channelMapping.a),
      };
  };

  const inspectData = getInspectData();

  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-neutral-200 font-sans overflow-hidden">
      
      {/* Left Panel: Sidebar + Logs */}
      <div 
        className="flex flex-col shrink-0 bg-neutral-900 z-30 h-full"
        style={{ width: sidebarWidth }}
      >
        
        {/* Top: Structure */}
        <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
            <Sidebar 
                structure={structure} 
                onSelectPart={handleSelectPart}
                onSelectLayer={handleSelectLayer}
                onSelectChannel={handleSelectChannel}
                selectedPartId={selectedPartId}
                onOpenFile={() => fileInputRef.current?.click()}
            />
        </div>

        {/* Horizontal Splitter (Sidebar vs Logs) */}
        <div 
           className="h-1 bg-neutral-950 border-y border-neutral-800/50 hover:bg-teal-500 cursor-row-resize flex items-center justify-center transition-colors shrink-0 z-20"
           onMouseDown={(e) => { e.preventDefault(); setIsResizingLogs(true); }}
        >
             {/* Handle Graphic */}
             <div className="w-12 h-0.5 bg-neutral-700/50 rounded-full pointer-events-none" />
        </div>

        {/* Bottom: Logs */}
        <div 
            className="shrink-0 overflow-hidden flex flex-col"
            style={{ height: logHeight }}
        >
            <LogPanel logs={logs} />
        </div>

      </div>

      {/* Vertical Splitter (Sidebar vs Main) */}
      <div
          className="w-1 bg-neutral-950 border-l border-r border-neutral-800/50 hover:bg-teal-500 cursor-col-resize z-40 transition-colors shrink-0"
          onMouseDown={(e) => { e.preventDefault(); setIsResizingSidebar(true); }}
      ></div>

      <div className={`flex-1 flex flex-col relative overflow-hidden min-w-0 ${isResizingSidebar || isResizingLogs ? 'pointer-events-none' : ''}`}>
        {/* Toolbar */}
        <div className="h-14 border-b border-neutral-800 bg-neutral-900 flex items-center px-4 justify-between shrink-0 z-20">
            <div className="flex items-center space-x-4">
                <div className="flex flex-col">
                  <span className="font-semibold text-neutral-300 text-sm">{fileName || "No File"}</span>
                  {structure && (
                    <span className="text-[10px] text-neutral-500">
                       {structure.isMultipart ? 'Multipart' : 'Single Part'} • {rawPixelData ? `${rawPixelData.width}x${rawPixelData.height}` : ''}
                    </span>
                  )}
                </div>

                <div
                  className={`px-2 py-1 rounded text-[10px] font-mono border ${
                    rendererBackend === 'webgl2'
                      ? 'bg-teal-900/20 border-teal-700/50 text-teal-300'
                      : 'bg-amber-900/20 border-amber-700/50 text-amber-300'
                  }`}
                  title={rendererFallbackReason || undefined}
                >
                  <span className="opacity-60 mr-1">Renderer:</span>
                  {rendererBackend === 'webgl2' ? 'WebGL2' : 'CPU fallback'}
                </div>
                
                {structure && (
                  <div className="flex items-center space-x-1">
                     <div className="px-2 py-1 bg-black/40 border border-red-900/50 rounded text-[10px] text-red-400 font-mono flex gap-1">
                        <span className="opacity-50">R:</span> {channelMapping.r || '-'}
                     </div>
                     <div className="px-2 py-1 bg-black/40 border border-green-900/50 rounded text-[10px] text-green-400 font-mono flex gap-1">
                        <span className="opacity-50">G:</span> {channelMapping.g || '-'}
                     </div>
                     <div className="px-2 py-1 bg-black/40 border border-blue-900/50 rounded text-[10px] text-blue-400 font-mono flex gap-1">
                        <span className="opacity-50">B:</span> {channelMapping.b || '-'}
                     </div>
                  </div>
                )}
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-4 bg-neutral-800/50 rounded-lg px-3 py-1 border border-neutral-700">
                <div className="flex items-center space-x-2">
                  <button 
                    onClick={toggleExposure}
                    className={`flex items-center justify-center p-1 rounded hover:bg-neutral-700 transition-colors ${exposure !== 0 ? 'text-teal-400' : 'text-neutral-400'}`}
                    title={exposure === 0 ? "Toggle Exposure" : "Reset Exposure to 0"}
                  >
                      <Sun className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-xs text-neutral-400">Exp:</span>
                  <input 
                      type="range" min="-10" max="10" step="0.01" 
                      value={exposure} 
                      onChange={(e) => setExposure(parseFloat(e.target.value))}
                      className="w-24 h-1 bg-neutral-600 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs font-mono w-8 text-right">{exposure.toFixed(2)}</span>
                </div>
                <div className="w-px h-4 bg-neutral-700"></div>
                <div className="flex items-center space-x-2">
                  <button 
                    onClick={toggleGamma}
                    className={`flex items-center justify-center p-1 rounded hover:bg-neutral-700 transition-colors ${Math.abs(gamma - 2.2) > 0.01 ? 'text-teal-400' : 'text-neutral-400'}`}
                    title={Math.abs(gamma - 2.2) < 0.01 ? "Toggle Gamma" : "Reset Gamma to 2.2"}
                  >
                      <Monitor className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-xs text-neutral-400">Gamma:</span>
                  <input 
                      type="range" min="0.1" max="4.0" step="0.01" 
                      value={gamma} 
                      onChange={(e) => setGamma(parseFloat(e.target.value))}
                      className="w-24 h-1 bg-neutral-600 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-xs font-mono w-8 text-right">{gamma.toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <div className="h-6 w-px bg-neutral-800 mx-2"></div>
              <button 
                onClick={fitView}
                className="p-1.5 rounded transition-colors bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700"
                title="Fit to Screen"
              >
                <Maximize className="w-4 h-4" />
              </button>

              <button 
                onClick={() => setShowHistogram(!showHistogram)}
                className={`p-1.5 rounded transition-colors ${showHistogram ? 'bg-teal-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-white'}`}
                title="Toggle Histogram"
              >
                <BarChart3 className="w-4 h-4" />
              </button>

              <button 
                onClick={() => setIsInspectMode(!isInspectMode)}
                className={`p-1.5 rounded transition-colors ${isInspectMode ? 'bg-teal-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-white'}`}
                title="Pixel Inspector Tool"
              >
                <Crosshair className="w-4 h-4" />
              </button>

              <button 
                onClick={() => setShowHelp(!showHelp)}
                className={`p-1.5 rounded transition-colors ${showHelp ? 'bg-teal-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-white'}`}
                title="Help & Shortcuts"
              >
                <HelpCircle className="w-4 h-4" />
              </button>
            </div>
        </div>

        {/* Canvas / Main View */}
        <div 
            ref={containerRef}
            className={`flex-1 bg-neutral-950 relative overflow-hidden select-none ${isDragging ? 'cursor-grabbing' : isInspectMode ? 'cursor-crosshair' : 'cursor-default'}`}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
        >
          {!structure ? (
              <div className="flex items-center justify-center h-full relative z-10">
                  <DropZone onFileLoaded={handleFileLoaded} />
              </div>
          ) : (
              <div 
                  className="absolute top-0 left-0 origin-top-left shadow-2xl transition-transform duration-75 ease-out"
                  style={{ 
                      transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
                      imageRendering: viewTransform.scale > 2 ? 'pixelated' : 'auto'
                  }}
              >
                  {/* The canvas size matches the image data window size exactly */}
                  <canvas ref={canvasRef} className="block pointer-events-none" />
                  
                  {selectedPartId === null && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-neutral-400">
                          Select a part to decode
                      </div>
                  )}
              </div>
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
              <div className="absolute top-4 right-4 z-50 w-72 bg-neutral-900/95 backdrop-blur border border-neutral-800 shadow-2xl rounded-lg p-4 animate-in fade-in slide-in-from-top-2 text-left">
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
                          </ul>
                      </div>
                      
                      <div>
                          <h4 className="text-[10px] uppercase font-bold text-neutral-500 mb-1">Viewport</h4>
                          <ul className="text-xs text-neutral-300 space-y-1 list-disc pl-4 marker:text-teal-500/50">
                              <li><strong>Scroll</strong> to zoom in/out.</li>
                              <li><strong>Left/Middle Drag</strong> to pan image.</li>
                              <li>Use <strong>Inspector</strong> tool for pixel values.</li>
                              <li>Click <strong>Sun/Monitor</strong> icons to toggle defaults.</li>
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
          
          {/* Controls Help Hint */}
          {structure && !isInspectMode && (
              <div className="absolute bottom-4 left-4 z-10 text-[10px] text-neutral-600 bg-neutral-900/80 px-2 py-1 rounded border border-neutral-800 pointer-events-none">
                  Scroll to Zoom • Left/Middle Click Drag to Pan
              </div>
          )}

          {/* Hidden Input for Toolbar Button */}
          <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".exr"
              onChange={handleGlobalFileInput}
          />
        </div>
      </div>
    </div>
  );
}
