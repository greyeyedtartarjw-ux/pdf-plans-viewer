import React from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { Trash2, Download, ExternalLink } from 'lucide-react';

export default function MeasurementIndex() {
  const { state, dispatch } = useViewerContext();
  const { measurements, scale } = state;

  const allMeasurements = Object.entries(measurements).flatMap(([pageStr, ms]) => 
    ms.map(m => ({ ...m, pageNum: parseInt(pageStr) }))
  );

  const handleDelete = (e: React.MouseEvent, page: number, id: string) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_MEASUREMENT', page, id });
  };

  const handleExportCSV = () => {
    if (allMeasurements.length === 0) return;
    
    let csv = 'Page,Type,Label,Value,Unit\n';
    allMeasurements.forEach(m => {
      csv += `${m.pageNum},${m.type},"${m.label}",${m.realWorldValue},${m.unit}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `measurements_export.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (allMeasurements.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sidebar-foreground/50 text-sm gap-3 p-6 text-center">
        <div className="w-12 h-12 rounded-full border border-sidebar-border bg-background/5 flex items-center justify-center mb-2">
          <div className="w-6 h-px bg-sidebar-foreground/30" />
        </div>
        No measurements yet.
        <span className="text-xs">Use the toolbar to measure distances and areas.</span>
      </div>
    );
  }

  // Calculate totals
  const totalDistance = allMeasurements
    .filter(m => m.type === 'distance')
    .reduce((acc, m) => acc + m.realWorldValue, 0);
    
  const totalArea = allMeasurements
    .filter(m => m.type === 'area')
    .reduce((acc, m) => acc + m.realWorldValue, 0);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-sidebar-border flex justify-between items-center bg-sidebar">
        <h3 className="text-sm font-semibold text-sidebar-foreground">Takeoffs</h3>
        <button 
          onClick={handleExportCSV}
          className="p-1.5 text-sidebar-foreground hover:bg-white/10 hover:text-primary rounded transition-colors text-xs flex items-center gap-1"
          title="Export CSV"
        >
          <Download size={14} /> CSV
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-sidebar">
        {allMeasurements.map(m => (
          <div 
            key={m.id}
            onClick={() => dispatch({ type: 'SET_CURRENT_PAGE', page: m.pageNum })}
            className="group flex flex-col bg-background/5 border border-sidebar-border p-2.5 rounded hover:border-primary/50 cursor-pointer transition-colors"
          >
            <div className="flex justify-between items-start mb-1">
              <span className="text-xs font-medium text-primary">Page {m.pageNum}</span>
              <button 
                onClick={(e) => handleDelete(e, m.pageNum, m.id)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 hover:text-destructive rounded text-sidebar-foreground/50 transition-all"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="flex justify-between items-end">
              <span className="text-sm text-sidebar-foreground capitalize">{m.type}</span>
              <span className="text-sm font-mono font-medium text-sidebar-foreground bg-background/20 px-1.5 py-0.5 rounded">
                {m.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-sidebar-border bg-sidebar-border/30">
        <div className="text-xs font-medium text-sidebar-foreground/70 uppercase tracking-wider mb-2">Grand Totals</div>
        <div className="space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-sm text-sidebar-foreground/80">Distance</span>
            <span className="text-sm font-mono text-sidebar-foreground font-semibold">
              {totalDistance.toFixed(2)} {scale.realWorldUnit || 'px'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-sidebar-foreground/80">Area</span>
            <span className="text-sm font-mono text-sidebar-foreground font-semibold">
              {totalArea.toFixed(2)} {(scale.realWorldUnit || 'px')}²
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
