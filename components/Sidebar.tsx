import React from 'react';
import { Layers, Box, FileImage, FolderOpen, Eye } from 'lucide-react';
import { ExrStructure, ExrPart } from '../types';

interface SidebarProps {
  structure: ExrStructure | null;
  selectedPartId: number | null;
  onSelectPart: (partId: number) => void;
  onSelectLayer: (partId: number, layerPrefix: string) => void;
  onSelectChannel: (partId: number, channelName: string) => void;
  onOpenFile: () => void;
}

const PartItem: React.FC<{ 
  part: ExrPart; 
  isSelected: boolean; 
  onClick: () => void;
  onSelectLayer: (prefix: string) => void;
  onSelectChannel: (name: string) => void;
}> = ({ part, isSelected, onClick, onSelectLayer, onSelectChannel }) => {
  
  // Group channels into layers
  const layers = React.useMemo(() => {
    const groups: Record<string, string[]> = {};
    part.channels.forEach(ch => {
      const parts = ch.name.split('.');
      const layerName = parts.length > 1 ? parts.slice(0, -1).join('.') : '(root)';
      if (!groups[layerName]) groups[layerName] = [];
      groups[layerName].push(ch.name); // Push full name for selection
    });
    return groups;
  }, [part.channels]);

  return (
    <div 
      className={`mb-2 rounded-lg border transition-all duration-200 overflow-hidden ${
        isSelected 
          ? 'bg-neutral-800/80 border-teal-500/50 shadow-[0_0_15px_-3px_rgba(20,184,166,0.3)]' 
          : 'bg-neutral-800/30 border-neutral-800 hover:border-neutral-700'
      }`}
    >
      <div 
        className="p-3 border-b border-neutral-700/50 flex items-center justify-between cursor-pointer hover:bg-neutral-700/50 transition-colors"
        onClick={onClick}
      >
        <div className="flex items-center space-x-2">
          <Box className={`w-4 h-4 ${isSelected ? 'text-teal-400' : 'text-neutral-500'}`} />
          <span className="text-sm font-medium text-neutral-200">Part {part.id}</span>
        </div>
        {part.type && <span className="text-[10px] uppercase text-neutral-500 bg-neutral-900 px-1.5 py-0.5 rounded">{part.type.replace('image','')}</span>}
      </div>
      
      <div className="p-2 space-y-1">
        {Object.entries(layers).map(([layerName, fullChannelNames]) => {
          // Simplified display names
          const displayChannels = (fullChannelNames as string[]).map(n => {
            const parts = n.split('.');
            return { full: n, short: parts[parts.length-1] };
          });

          return (
            <div key={layerName} className="group flex flex-col items-start p-1.5 rounded hover:bg-neutral-700/30">
              <div 
                className="flex items-center space-x-2 w-full cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onClick(); // Ensure part is selected
                  onSelectLayer(layerName);
                }}
              >
                <Layers className="w-3 h-3 text-neutral-600 group-hover:text-teal-400 transition-colors" />
                <span className="text-xs text-neutral-300 font-medium truncate group-hover:text-white transition-colors" title={`Map ${layerName} to RGB`}>
                  {layerName}
                </span>
                <Eye className="w-3 h-3 text-transparent group-hover:text-neutral-500 ml-auto" />
              </div>
              
              <div className="pl-5 pt-1 flex flex-wrap gap-1.5 w-full">
                {displayChannels.map(c => (
                  <button
                    key={c.full}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClick(); // Ensure part is selected
                      onSelectChannel(c.full);
                    }}
                    className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-900/50 border border-neutral-800 text-neutral-500 hover:text-teal-300 hover:border-teal-800/50 transition-all"
                    title={`View channel ${c.short} as Grayscale`}
                  >
                    {c.short}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({ 
  structure, 
  selectedPartId, 
  onSelectPart,
  onSelectLayer,
  onSelectChannel,
  onOpenFile
}) => {
  return (
    <div className="h-full flex flex-col w-full bg-neutral-900">
      <div className="p-4 border-b border-neutral-800 shrink-0 flex items-center justify-between">
        <h1 className="text-sm font-bold flex items-center text-neutral-100">
          <FileImage className="w-5 h-5 mr-2 text-teal-500" />
          EXR Lab <span className="ml-2 text-[10px] bg-neutral-800 text-neutral-400 px-1.5 py-0.5 rounded">v0.0.5</span>
        </h1>
        <button 
          onClick={onOpenFile}
          className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white rounded transition-colors"
          title="Open File"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-3">
        {!structure ? (
          <div 
            className="flex flex-col items-center justify-center h-40 text-neutral-600 space-y-3 mt-10 cursor-pointer hover:text-neutral-500 transition-colors"
            onClick={onOpenFile}
          >
            <FolderOpen className="w-8 h-8 opacity-50" />
            <p className="text-xs text-center px-4">Click to Open<br/>or Drag & Drop</p>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-3 px-1">
              <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Structure</h2>
              <span className="text-[10px] text-neutral-600">{structure.parts.length} Part{structure.parts.length !== 1 ? 's' : ''}</span>
            </div>
            {structure.parts.map(part => (
              <PartItem 
                key={part.id} 
                part={part} 
                isSelected={selectedPartId === part.id}
                onClick={() => onSelectPart(part.id)}
                onSelectLayer={(layer) => onSelectLayer(part.id, layer)}
                onSelectChannel={(ch) => onSelectChannel(part.id, ch)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
