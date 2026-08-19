import React, { useState } from 'react';
import { SCALE_PRESETS, type Scale } from '../types';
import { X, Ruler } from 'lucide-react';

interface ScaleDialogProps {
  onClose: () => void;
  pageNumber: number;
  pixelDistance: number | null;
  onScaleSaved: (scale: Scale) => void;
  onStartCustomCalibration: () => void;
}

export default function ScaleDialog({
  onClose,
  pageNumber,
  pixelDistance,
  onScaleSaved,
  onStartCustomCalibration,
}: ScaleDialogProps) {
  const [realValue, setRealValue] = useState('1');

  const savePreset = (ratio: Scale['presetRatio'], pixelsPerUnit: number) => {
    if (!ratio) return;
    onScaleSaved({
      set: true,
      pixelsPerUnit,
      unit: 'px',
      realWorldUnit: 'ft',
      scaleKind: 'preset',
      presetRatio: ratio,
      calibrationDistanceFeet: null,
    });
    onClose();
  };

  const handleSaveCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(realValue);
    if (isNaN(val) || val <= 0 || !pixelDistance || pixelDistance <= 0) return;

    const pixelsPerUnit = pixelDistance / val;
    onScaleSaved({
      set: true,
      pixelsPerUnit,
      unit: 'px',
      realWorldUnit: 'ft',
      scaleKind: 'custom',
      presetRatio: null,
      calibrationDistanceFeet: val,
    });
    onClose();
  };

  const isCustomStep = pixelDistance !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-border animate-in fade-in zoom-in-95 duration-200">
        <div className="px-5 py-4 border-b border-border flex justify-between items-center bg-muted/30">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <Ruler size={18} className="text-primary" />
            Set scale for page {pageNumber}
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded-full transition-colors text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        
        {isCustomStep ? (
          <form onSubmit={handleSaveCustom} className="p-5">
            <div className="mb-6 space-y-1">
              <p className="text-sm text-muted-foreground">
                The selected line is <strong className="font-mono text-foreground">{Math.round(pixelDistance ?? 0)} PDF px</strong>.
              </p>
              <p className="text-sm text-muted-foreground">Enter its real-world length in feet.</p>
            </div>
            <label className="block text-xs font-medium text-foreground mb-1.5 uppercase tracking-wider">Distance (feet)</label>
            <input
              type="number"
              min="0.0001"
              step="any"
              required
              value={realValue}
              onChange={(e) => setRealValue(e.target.value)}
              className="mb-8 w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-mono"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted">Cancel</button>
              <button type="submit" className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90">Save custom scale</button>
            </div>
          </form>
        ) : (
          <div className="p-5">
            <p className="mb-4 text-sm text-muted-foreground">Choose the plan ratio for this page. All measurements use feet.</p>
            <div className="grid grid-cols-2 gap-2">
              {SCALE_PRESETS.map((preset) => (
                <button
                  key={preset.ratio}
                  type="button"
                  onClick={() => savePreset(preset.ratio, preset.pixelsPerFoot)}
                  className="rounded-md border border-input px-3 py-3 text-left text-sm font-medium hover:border-primary hover:bg-primary/5"
                >
                  {preset.ratio}" = 1'
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { onStartCustomCalibration(); onClose(); }}
              className="mt-3 w-full rounded-md border border-primary px-3 py-3 text-sm font-medium text-primary hover:bg-primary/5"
            >
              Custom two-point calibration
            </button>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
