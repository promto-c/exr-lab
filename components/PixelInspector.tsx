import React from 'react';

interface PixelInspectorProps {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
  visible: boolean;
}

export const PixelInspector: React.FC<PixelInspectorProps> = ({ x, y, r, g, b, a, visible }) => {
  if (!visible) return null;

  const fmt = (n: number) => {
    if (n === undefined || isNaN(n)) return '0.0000';
    // Use scientific notation for very small non-zero numbers or very large numbers
    if ((Math.abs(n) < 0.0001 && n !== 0) || Math.abs(n) > 99999) {
      return n.toExponential(4);
    }
    return n.toFixed(4);
  };

  return (
    <div className="absolute bottom-4 left-4 z-30 bg-neutral-900/40 backdrop-blur-xl border border-white/10 rounded-lg shadow-lg p-3 font-mono text-xs text-gray-200 pointer-events-none animate-in fade-in zoom-in-95 duration-200">
      <div className="grid grid-cols-[auto_1fr] gap-x-3">
        <span className="text-gray-400 font-medium">X:</span><span>{x}</span>
        <span className="text-gray-400 font-medium">Y:</span><span>{y}</span>
      </div>
      <div className="border-t border-gray-700/50 my-2"></div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-red-400 font-bold">R:</span><span>{fmt(r)}</span>
        <span className="text-green-400 font-bold">G:</span><span>{fmt(g)}</span>
        <span className="text-blue-400 font-bold">B:</span><span>{fmt(b)}</span>
        <span className="text-gray-400 font-bold">A:</span><span>{fmt(a)}</span>
      </div>
    </div>
  );
};
