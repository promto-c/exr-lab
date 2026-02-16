import React from 'react';
import { FileUp } from 'lucide-react';

interface DropZoneProps {
  onFileLoaded: (name: string, buffer: ArrayBuffer) => void;
  className?: string;
}

export const DropZone: React.FC<DropZoneProps> = ({ onFileLoaded, className }) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const onDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [onFileLoaded]);

  const onSelect = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [onFileLoaded]);

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      if (evt.target?.result) {
        onFileLoaded(file.name, evt.target.result as ArrayBuffer);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div 
      className={`border-2 border-dashed border-neutral-700 rounded-xl p-8 flex flex-col items-center justify-center text-neutral-500 hover:border-neutral-500 hover:bg-neutral-800/30 transition-all cursor-pointer group ${className}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={() => fileInputRef.current?.click()}
    >
      <div className="w-16 h-16 bg-neutral-800 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
        <FileUp className="w-8 h-8 text-neutral-400 group-hover:text-teal-400 transition-colors" />
      </div>
      <h3 className="text-lg font-medium text-neutral-300 mb-1">Load EXR File</h3>
      <p className="text-sm max-w-xs text-center">Drag and drop or click to select a file from your computer.</p>
      <input 
        ref={fileInputRef}
        type="file" 
        accept="*" 
        className="hidden" 
        onChange={onSelect} 
      />
    </div>
  );
};
