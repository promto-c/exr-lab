import React from 'react';
import { FileUp, FolderOpen } from 'lucide-react';

interface DropZoneProps {
  onFileLoaded: (name: string, buffer: ArrayBuffer) => void;
  onFilesLoaded?: (files: File[]) => void;
  onOpenFolder?: () => void;
  className?: string;
}

export const DropZone: React.FC<DropZoneProps> = ({
  onFileLoaded,
  onFilesLoaded,
  onOpenFolder,
  className,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const processFile = React.useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      if (evt.target?.result) {
        onFileLoaded(file.name, evt.target.result as ArrayBuffer);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [onFileLoaded]);

  const processFiles = React.useCallback((files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1 || !onFilesLoaded) {
      processFile(files[0]);
      return;
    }

    onFilesLoaded(files);
  }, [onFilesLoaded, processFile]);

  const onDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    processFiles(Array.from(e.dataTransfer.files ?? []));
  }, [processFiles]);

  const onSelect = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  }, [processFiles]);

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
      <p className="text-sm max-w-xs text-center">Drag and drop a file or sequence, or click to pick EXRs.</p>
      {onOpenFolder && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenFolder();
          }}
          className="mt-4 inline-flex items-center gap-2 rounded border border-neutral-700 bg-neutral-800/60 px-3 py-1.5 text-xs text-neutral-300 hover:border-teal-700 hover:text-teal-300 transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Bind Local Folder
        </button>
      )}
      <input 
        ref={fileInputRef}
        type="file" 
        accept=".exr"
        multiple
        className="hidden" 
        onChange={onSelect} 
      />
    </div>
  );
};
