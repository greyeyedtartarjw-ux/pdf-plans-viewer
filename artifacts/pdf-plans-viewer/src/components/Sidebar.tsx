import React, { useRef, useEffect, useState } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { FileText, Search as SearchIcon, Ruler, ChevronRight, X } from 'lucide-react';

const PageThumbnails = React.lazy(() => import('./PageThumbnails'));
const SearchPanel = React.lazy(() => import('./SearchPanel'));
const MeasurementIndex = React.lazy(() => import('./MeasurementIndex'));

export function Sidebar() {
  const { state, dispatch } = useViewerContext();
  const { sidebarTab, sidebarOpen, totalPages } = state;
  const [pageThumbnailsRequested, setPageThumbnailsRequested] = useState(false);

  if (!sidebarOpen) {
    return (
      <div className="h-full bg-sidebar border-r border-border w-10 flex flex-col items-center py-4 gap-4 z-10 relative">
        <button onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })} className="p-2 text-sidebar-foreground hover:bg-white/10 rounded" title="Open Sidebar">
          <ChevronRight size={18} />
        </button>
        <button onClick={() => { setPageThumbnailsRequested(true); dispatch({ type: 'TOGGLE_SIDEBAR' }); dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'pages' }) }} className="p-2 text-sidebar-foreground/50 hover:text-primary transition-colors">
          <FileText size={18} />
        </button>
        <button onClick={() => { dispatch({ type: 'TOGGLE_SIDEBAR' }); dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'search' }) }} className="p-2 text-sidebar-foreground/50 hover:text-primary transition-colors">
          <SearchIcon size={18} />
        </button>
        <button onClick={() => { dispatch({ type: 'TOGGLE_SIDEBAR' }); dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'measurements' }) }} className="p-2 text-sidebar-foreground/50 hover:text-primary transition-colors">
          <Ruler size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full bg-sidebar border-r border-border w-72 flex flex-col z-10 relative shadow-[4px_0_24px_rgba(0,0,0,0.1)] transition-all duration-200">
      <div className="flex bg-sidebar-border/50 p-1 m-2 rounded-md">
        <button
          onClick={() => { setPageThumbnailsRequested(true); dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'pages' }); }}
          className={`flex-1 py-1.5 text-xs font-medium rounded flex items-center justify-center gap-1.5 transition-colors ${
            sidebarTab === 'pages' ? 'bg-sidebar text-primary shadow-sm' : 'text-sidebar-foreground/70 hover:text-sidebar-foreground'
          }`}
        >
          <FileText size={14} /> Pages
        </button>
        <button
          onClick={() => dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'search' })}
          className={`flex-1 py-1.5 text-xs font-medium rounded flex items-center justify-center gap-1.5 transition-colors ${
            sidebarTab === 'search' ? 'bg-sidebar text-primary shadow-sm' : 'text-sidebar-foreground/70 hover:text-sidebar-foreground'
          }`}
        >
          <SearchIcon size={14} /> Search
        </button>
        <button
          onClick={() => dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'measurements' })}
          className={`flex-1 py-1.5 text-xs font-medium rounded flex items-center justify-center gap-1.5 transition-colors ${
            sidebarTab === 'measurements' ? 'bg-sidebar text-primary shadow-sm' : 'text-sidebar-foreground/70 hover:text-sidebar-foreground'
          }`}
        >
          <Ruler size={14} /> Index
        </button>
      </div>

      <div className="flex-1 overflow-hidden relative">
        <React.Suspense
          fallback={(
            <div className="h-full flex items-center justify-center text-sidebar-foreground/50 text-sm">
              Loading panel…
            </div>
          )}
        >
          {sidebarTab === 'pages' && (
            pageThumbnailsRequested ? (
              <PageThumbnails />
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center text-sidebar-foreground/50 text-sm">
                <p>Page thumbnails are ready when you need them.</p>
                <button
                  onClick={() => setPageThumbnailsRequested(true)}
                  className="rounded border border-sidebar-border px-3 py-1.5 text-xs font-medium text-sidebar-foreground hover:border-primary/50 hover:text-primary transition-colors"
                >
                  Load page thumbnails
                </button>
              </div>
            )
          )}
          {sidebarTab === 'search' && <SearchPanel />}
          {sidebarTab === 'measurements' && <MeasurementIndex />}
        </React.Suspense>
      </div>

      <button 
        onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-12 bg-sidebar border border-border rounded-r-md flex items-center justify-center text-sidebar-foreground/50 hover:text-primary cursor-pointer hover:w-8 transition-all shadow-md z-20"
      >
        <ChevronRight size={16} className="rotate-180" />
      </button>
    </div>
  );
}
