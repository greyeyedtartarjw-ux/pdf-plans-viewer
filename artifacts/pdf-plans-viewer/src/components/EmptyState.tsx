import React, { useRef, useState } from 'react';
import { UploadCloud, FileDown, Plus } from 'lucide-react';

export default function EmptyState({ onFileSelect }: { onFileSelect: (file: File) => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type === 'application/pdf') {
        onFileSelect(file);
      } else {
        alert("Please drop a valid PDF file.");
      }
    }
  };

  return (
    <div 
      className={`h-full w-full flex flex-col items-center justify-center p-8 transition-colors ${
        isDragging ? 'bg-primary/5' : 'bg-background'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={`max-w-md w-full border-2 border-dashed rounded-xl p-12 text-center transition-all ${
        isDragging ? 'border-primary scale-105 shadow-xl bg-card' : 'border-border bg-card/50'
      }`}>
        <div className="w-20 h-20 bg-sidebar rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-inner border border-border">
          <FileDown className="w-10 h-10 text-primary" />
        </div>
        
        <h2 className="text-xl font-semibold text-foreground mb-2">Drop Building Plans Here</h2>
        <p className="text-muted-foreground text-sm mb-8">
          Load a PDF to start viewing, measuring, and annotating your blueprints. Processing happens locally in your browser.
        </p>
        
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-6 py-2.5 rounded-md shadow-sm transition-all flex items-center gap-2 mx-auto"
        >
          <UploadCloud size={18} />
          Select PDF File
        </button>
        <input 
          type="file" 
          accept="application/pdf"
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files[0]) {
              onFileSelect(e.target.files[0]);
            }
          }}
        />
      </div>
      
      <div className="mt-12 text-center space-y-4 text-muted-foreground/60">
        <p className="text-xs uppercase tracking-widest font-semibold">Features</p>
        <div className="flex gap-8 text-sm">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary/60"></span> Hardware Accelerated</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary/60"></span> Precision Takeoffs</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary/60"></span> Full Text Search</span>
        </div>
      </div>
    </div>
  );
}
