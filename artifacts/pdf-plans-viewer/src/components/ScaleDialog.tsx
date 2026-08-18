import React, { useState } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { X, Ruler } from 'lucide-react';

interface ScaleDialogProps {
  onClose: () => void;
  pixelDistance: number;
}

export default function ScaleDialog({ onClose, pixelDistance }: ScaleDialogProps) {
  const { state, dispatch } = useViewerContext();
  const [realValue, setRealValue] = useState('1');
  const [unit, setUnit] = useState(state.scale.realWorldUnit !== 'px' ? state.scale.realWorldUnit : 'm');

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(realValue);
    if (isNaN(val) || val <= 0) return;

    const pixelsPerUnit = pixelDistance / val;

    dispatch({
      type: 'SET_SCALE',
      scale: {
        set: true,
        pixelsPerUnit,
        unit: 'px',
        realWorldUnit: unit
      }
    });
    
    // Also reset active tool back to pan
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'pan' });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-border animate-in fade-in zoom-in-95 duration-200">
        <div className="px-5 py-4 border-b border-border flex justify-between items-center bg-muted/30">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <Ruler size={18} className="text-primary" />
            Calibrate Scale
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded-full transition-colors text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        
        <form onSubmit={handleSave} className="p-5">
          <div className="mb-6 space-y-1">
            <p className="text-sm text-muted-foreground">
              You selected a distance of <strong className="font-mono text-foreground">{Math.round(pixelDistance)} px</strong> on the drawing.
            </p>
            <p className="text-sm text-muted-foreground">
              What is the real-world length of this line?
            </p>
          </div>

          <div className="flex gap-3 mb-8">
            <div className="flex-1">
              <label className="block text-xs font-medium text-foreground mb-1.5 uppercase tracking-wider">Distance</label>
              <input
                type="number"
                step="any"
                required
                value={realValue}
                onChange={(e) => setRealValue(e.target.value)}
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-mono"
                autoFocus
              />
            </div>
            <div className="w-1/3">
              <label className="block text-xs font-medium text-foreground mb-1.5 uppercase tracking-wider">Unit</label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              >
                <option value="mm">mm</option>
                <option value="cm">cm</option>
                <option value="m">m</option>
                <option value="in">in</option>
                <option value="ft">ft</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
            >
              Set Scale
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
