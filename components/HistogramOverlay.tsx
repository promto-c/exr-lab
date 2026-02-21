import React from 'react';
import { BarChart3, X } from 'lucide-react';

interface HistogramOverlayProps {
  data: number[];
  onClose: () => void;
}

export const HistogramOverlay: React.FC<HistogramOverlayProps> = ({ data, onClose }) => {
  const max = Math.max(...data, 1); // Avoid div by zero

  return (
    <div data-touch-ui="true" className="absolute bottom-4 right-4 bg-neutral-900/40 border border-neutral-800 p-4 rounded-lg shadow-xl backdrop-blur-sm w-64 animate-in fade-in slide-in-from-bottom-2 z-20">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-400 flex items-center">
          <BarChart3 className="w-3 h-3 mr-2" /> Luminance
        </h4>
        <button onClick={onClose} className="text-neutral-500 hover:text-white transition-colors">
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="flex items-end h-24 space-x-[1px] bg-neutral-950/50 rounded border border-neutral-800/50 overflow-hidden relative">
         {/* Grid lines */}
         <div className="absolute inset-0 flex flex-col justify-between p-1 opacity-20 pointer-events-none">
            <div className="border-t border-neutral-500 w-full h-0"></div>
            <div className="border-t border-neutral-500 w-full h-0"></div>
            <div className="border-t border-neutral-500 w-full h-0"></div>
         </div>
         {data.map((val, i) => (
             <div 
               key={i} 
               // add smooth height transitions so values update without a hard
               // jump; also transition color for hover as before
               className="flex-1 bg-teal-500/80 hover:bg-teal-400 transition-all duration-200 ease-out"
               style={{ height: `${(val / max) * 100}%` }}
               title={`Bin ${i}: ${val}`}
             />
         ))}
      </div>
       <div className="flex justify-between mt-1 text-[9px] text-neutral-600 font-mono">
          <span>0.0</span>
          <span>1.0</span>
      </div>
    </div>
  );
};
