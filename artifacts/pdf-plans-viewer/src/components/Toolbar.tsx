import { LucideIcon } from 'lucide-react';
import React, { useState } from 'react';

import { useViewerContext } from '../store/ViewerContext';
import { Tool } from '../types';
import { THEME } from '../lib/constants';
import { createShare } from '@workspace/api-client-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

import {
  FolderOpen,
  MousePointer2,
  Hand,
  Ruler,
  Scaling,
  PenLine,
  StickyNote,
  Type,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Camera,
  Printer,
  Settings2,
  Share2,
  Check,
  Download,
  FileText,
  Braces,
  Loader2,
  AlertCircle,
} from 'lucide-react';
interface ToolbarProps {
  onOpenClick: () => void;
  onSnapshot: () => void;
  onPrint: () => void;
  onSetScale: () => void;
  onExportCSV: () => void;
  onExportJSON: () => void;
}

const tools: { id: Tool; icon: LucideIcon; label: string }[] = [
  { id: 'pan', icon: Hand, label: 'Pan (H)' },
  { id: 'select', icon: MousePointer2, label: 'Select (V)' },
  { id: 'measure-distance', icon: Ruler, label: 'Distance' },
  { id: 'measure-area', icon: Scaling, label: 'Area' },
  { id: 'highlight', icon: PenLine, label: 'Highlight' },
  { id: 'note', icon: StickyNote, label: 'Note' },
  { id: 'text', icon: Type, label: 'Text' },
];

export function Toolbar({ onOpenClick, onSnapshot, onPrint, onSetScale, onExportCSV, onExportJSON }: ToolbarProps) {
  const { state, dispatch } = useViewerContext();
  const {
    zoom,
    activeTool,
    currentPage,
    totalPages,
    highlightColor,
    documentId,
    saveStatus,
    pdfDoc,
    annotations,
    measurements,
    scales,
  } = state;
  const currentScale = state.scales[currentPage];
  const hasMeasurements = Object.values(measurements).some(pageMeasurements => pageMeasurements.length > 0);
  const hasDocument = pdfDoc !== null;
  const hasAnnotations = Object.values(annotations).some(pageAnnotations => pageAnnotations.length > 0);
  const hasScale = Object.values(scales).some(scale => scale.set);
  const hasBackupContent = hasAnnotations || hasMeasurements || hasScale;

  const [shareState, setShareState] = useState<'idle' | 'copying' | 'copied'>('idle');

  const handleZoomIn = () => dispatch({ type: 'SET_ZOOM', zoom: Math.min(zoom + 0.25, 3.0) });
  const handleZoomOut = () => dispatch({ type: 'SET_ZOOM', zoom: Math.max(zoom - 0.25, 0.25) });
  const handleZoomChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    dispatch({ type: 'SET_ZOOM', zoom: parseFloat(e.target.value) });
  };

  const handlePrevPage = () => {
    if (currentPage > 1) dispatch({ type: 'SET_CURRENT_PAGE', page: currentPage - 1 });
  };
  const handleNextPage = () => {
    if (currentPage < totalPages) dispatch({ type: 'SET_CURRENT_PAGE', page: currentPage + 1 });
  };
  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const page = parseInt(e.target.value);
    if (!isNaN(page)) {
      dispatch({ type: 'SET_CURRENT_PAGE', page: Math.max(1, Math.min(page, totalPages)) });
    }
  };

  const handleShare = async () => {
    if (!documentId) {
      alert('Open a PDF file first to create a share link.');
      return;
    }
    setShareState('copying');
    try {
      const share = await createShare({ documentId });
      const url = new URL(window.location.href);
      url.searchParams.set('share', share.token);
      await navigator.clipboard.writeText(url.toString());
      setShareState('copied');
      setTimeout(() => setShareState('idle'), 2500);
    } catch {
      setShareState('idle');
      alert('Failed to create share link.');
    }
  };

  return (
    <div className="h-14 border-b border-border bg-sidebar flex items-center px-4 justify-between select-none shadow-sm z-10 relative">
      {/* Left: File actions */}
      <div className="flex items-center gap-2 border-r border-sidebar-border pr-4 mr-2">
        <button
          onClick={onOpenClick}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-sidebar-foreground bg-primary/10 hover:bg-primary/20 rounded-md transition-colors border border-primary/20"
          title="Open PDF"
        >
          <FolderOpen size={16} className="text-primary" />
          <span>Open</span>
        </button>
      </div>

      {/* Tools Center */}
      <div className="flex items-center gap-1 bg-background/5 p-1 rounded-md border border-sidebar-border shadow-inner">
        {tools.map((t) => {
          const isActive = activeTool === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                if (
                  (t.id === 'measure-distance' || t.id === 'measure-area')
                  && !currentScale?.set
                ) {
                  alert(`Set a scale for page ${currentPage} before measuring.`);
                  return;
                }
                dispatch({ type: 'SET_ACTIVE_TOOL', tool: t.id });
              }}
              className={`p-2 rounded transition-colors relative group ${
                isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-sidebar-foreground hover:bg-white/10'
              }`}
              title={t.label}
            >
              <t.icon size={18} />

              {/* Highlight color picker */}
              {t.id === 'highlight' && isActive && (
                <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-popover border border-border p-2 rounded-md shadow-lg flex gap-1 z-50">
                  {Object.entries(THEME.colors.highlight).map(([name, color]) => (
                    <button
                      key={name}
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({ type: 'SET_HIGHLIGHT_COLOR', color });
                      }}
                      className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        backgroundColor: color,
                        borderColor: highlightColor === color ? 'hsl(var(--primary))' : 'transparent'
                      }}
                      title={name}
                    />
                  ))}
                </div>
              )}
            </button>
          );
        })}

        <div className="w-px h-6 bg-sidebar-border mx-1" />

        <button
          onClick={onSetScale}
          className="p-2 rounded text-sidebar-foreground hover:bg-white/10 transition-colors"
          title="Calibrate Scale"
        >
          <Settings2 size={18} />
        </button>
      </div>

      {/* Right: Zoom, Navigation & Actions */}
      <div className="flex items-center gap-4">
        {/* Pagination */}
        <div className="flex items-center bg-background/10 rounded border border-sidebar-border">
          <button
            onClick={handlePrevPage}
            disabled={currentPage <= 1 || totalPages === 0}
            className="p-1 text-sidebar-foreground hover:bg-white/10 disabled:opacity-30 transition-colors rounded-l"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="px-2 text-sm text-sidebar-foreground font-mono flex items-center min-w-[100px] justify-center">
            <input
              type="text"
              value={currentPage || ''}
              onChange={handlePageInputChange}
              className="w-8 text-center bg-transparent border-b border-transparent focus:border-primary focus:outline-none"
              disabled={totalPages === 0}
            />
            <span className="opacity-50">/ {totalPages || '-'}</span>
          </div>
          <button
            onClick={handleNextPage}
            disabled={currentPage >= totalPages || totalPages === 0}
            className="p-1 text-sidebar-foreground hover:bg-white/10 disabled:opacity-30 transition-colors rounded-r"
          >
            <ChevronRight size={18} />
          </button>
        </div>

        <div className="w-px h-6 bg-sidebar-border" />

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <button onClick={handleZoomOut} className="p-1.5 text-sidebar-foreground hover:bg-white/10 rounded transition-colors">
            <ZoomOut size={16} />
          </button>
          <select
            value={zoom}
            onChange={handleZoomChange}
            className="bg-background/10 text-sidebar-foreground border border-sidebar-border text-sm rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary w-24 font-mono"
          >
            <option value={0.25}>25%</option>
            <option value={0.5}>50%</option>
            <option value={0.75}>75%</option>
            <option value={1.0}>100%</option>
            <option value={1.25}>125%</option>
            <option value={1.5}>150%</option>
            <option value={2.0}>200%</option>
            <option value={3.0}>300%</option>
          </select>
          <button onClick={handleZoomIn} className="p-1.5 text-sidebar-foreground hover:bg-white/10 rounded transition-colors">
            <ZoomIn size={16} />
          </button>
        </div>

        {/* Save status indicator */}
        {saveStatus !== 'idle' && (
          <>
            <div className="w-px h-6 bg-sidebar-border" />
            <div
              className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded transition-all ${
                saveStatus === 'saving'
                  ? 'text-sidebar-foreground/70'
                  : saveStatus === 'saved'
                  ? 'text-green-400'
                  : 'text-destructive'
              }`}
              title={
                saveStatus === 'saving'
                  ? 'Saving changes…'
                  : saveStatus === 'saved'
                  ? 'All changes saved'
                  : 'Save failed — check your connection'
              }
            >
              {saveStatus === 'saving' && <Loader2 size={13} className="animate-spin" />}
              {saveStatus === 'saved' && <Check size={13} />}
              {saveStatus === 'failed' && <AlertCircle size={13} />}
              <span>
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : 'Save failed'}
              </span>
            </div>
          </>
        )}

        <div className="w-px h-6 bg-sidebar-border" />

        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleShare}
            disabled={!documentId || shareState === 'copying'}
            title={documentId ? 'Copy share link' : 'Open a PDF to share'}
            className={`p-2 rounded transition-colors ${
              shareState === 'copied'
                ? 'text-green-400'
                : 'text-sidebar-foreground hover:bg-white/10 disabled:opacity-30'
            }`}
          >
            {shareState === 'copied' ? <Check size={18} /> : <Share2 size={18} />}
          </button>
          <button onClick={onSnapshot} className="p-2 text-sidebar-foreground hover:bg-white/10 rounded transition-colors" title="Snapshot (PNG)">
            <Camera size={18} />
          </button>
          <button onClick={onPrint} className="p-2 text-sidebar-foreground hover:bg-white/10 rounded transition-colors" title="Print">
            <Printer size={18} />
          </button>

          {/* Export dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-2 text-sidebar-foreground hover:bg-white/10 rounded transition-colors"
                title="Export backup"
              >
                <Download size={18} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Export backup
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onExportCSV}
                disabled={!hasMeasurements}
                className="gap-2 cursor-pointer disabled:cursor-not-allowed"
              >
                <FileText size={15} className="shrink-0" />
                <div>
                  <div className="font-medium">Measurements CSV</div>
                  <div className="text-xs text-muted-foreground">
                    {hasMeasurements ? 'All pages, all measurements' : 'Add a measurement to export CSV'}
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onExportJSON}
                disabled={!hasDocument || !hasBackupContent}
                className="gap-2 cursor-pointer disabled:cursor-not-allowed"
              >
                <Braces size={15} className="shrink-0" />
                <div>
                  <div className="font-medium">Full backup JSON</div>
                  <div className="text-xs text-muted-foreground">
                    {!hasDocument
                      ? 'Open a PDF to export a backup'
                      : hasBackupContent
                      ? 'Annotations + measurements + scale'
                      : 'Add an annotation, measurement, or scale first'}
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
