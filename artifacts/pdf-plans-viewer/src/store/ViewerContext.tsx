import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { Tool, SidebarTab, Scale, Annotation, Measurement, SearchResult, PDFDocumentData } from '../types';

interface ViewerState {
  pdfDoc: any | null;
  documentData: PDFDocumentData | null;
  currentPage: number;
  totalPages: number;
  
  zoom: number;
  activeTool: Tool;
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  highlightColor: string;
  
  scale: Scale;
  annotations: Record<number, Annotation[]>;
  measurements: Record<number, Measurement[]>;
  
  searchQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
}

type Action =
  | { type: 'SET_PDF_DOC'; doc: any; data: PDFDocumentData; totalPages: number }
  | { type: 'SET_CURRENT_PAGE'; page: number }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'SET_ACTIVE_TOOL'; tool: Tool }
  | { type: 'SET_SIDEBAR_TAB'; tab: SidebarTab }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_HIGHLIGHT_COLOR'; color: string }
  | { type: 'SET_SCALE'; scale: Scale }
  | { type: 'ADD_ANNOTATION'; page: number; annotation: Annotation }
  | { type: 'UPDATE_ANNOTATION'; page: number; id: string; data: any }
  | { type: 'REMOVE_ANNOTATION'; page: number; id: string }
  | { type: 'ADD_MEASUREMENT'; page: number; measurement: Measurement }
  | { type: 'REMOVE_MEASUREMENT'; page: number; id: string }
  | { type: 'CLEAR_MEASUREMENTS' }
  | { type: 'SET_SEARCH_STATE'; query: string; results: SearchResult[]; isSearching: boolean };

const DEFAULT_SCALE: Scale = { set: false, pixelsPerUnit: 1, unit: 'px', realWorldUnit: 'px' };

const initialState: ViewerState = {
  pdfDoc: null,
  documentData: null,
  currentPage: 1,
  totalPages: 0,
  zoom: 1.0,
  activeTool: 'pan',
  sidebarTab: 'pages',
  sidebarOpen: true,
  highlightColor: 'rgba(255, 235, 59, 0.4)',
  scale: DEFAULT_SCALE,
  annotations: {},
  measurements: {},
  searchQuery: '',
  searchResults: [],
  isSearching: false,
};

function reducer(state: ViewerState, action: Action): ViewerState {
  switch (action.type) {
    case 'SET_PDF_DOC':
      return { 
        ...state, 
        pdfDoc: action.doc, 
        documentData: action.data, 
        totalPages: action.totalPages, 
        currentPage: 1 
      };
    case 'SET_CURRENT_PAGE':
      return { ...state, currentPage: action.page };
    case 'SET_ZOOM':
      return { ...state, zoom: action.zoom };
    case 'SET_ACTIVE_TOOL':
      return { ...state, activeTool: action.tool };
    case 'SET_SIDEBAR_TAB':
      return { ...state, sidebarTab: action.tab, sidebarOpen: true };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'SET_HIGHLIGHT_COLOR':
      return { ...state, highlightColor: action.color };
    case 'SET_SCALE':
      return { ...state, scale: action.scale };
    case 'ADD_ANNOTATION':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: [...(state.annotations[action.page] || []), action.annotation]
        }
      };
    case 'UPDATE_ANNOTATION':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: (state.annotations[action.page] || []).map(a => 
            a.id === action.id ? { ...a, data: action.data } : a
          )
        }
      };
    case 'REMOVE_ANNOTATION':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: (state.annotations[action.page] || []).filter(a => a.id !== action.id)
        }
      };
    case 'ADD_MEASUREMENT':
      return {
        ...state,
        measurements: {
          ...state.measurements,
          [action.page]: [...(state.measurements[action.page] || []), action.measurement]
        }
      };
    case 'REMOVE_MEASUREMENT':
      return {
        ...state,
        measurements: {
          ...state.measurements,
          [action.page]: (state.measurements[action.page] || []).filter(m => m.id !== action.id)
        }
      };
    case 'CLEAR_MEASUREMENTS':
      return { ...state, measurements: {} };
    case 'SET_SEARCH_STATE':
      return { ...state, searchQuery: action.query, searchResults: action.results, isSearching: action.isSearching };
    default:
      return state;
  }
}

const ViewerContext = createContext<{
  state: ViewerState;
  dispatch: React.Dispatch<Action>;
} | undefined>(undefined);

export function ViewerProvider({ children }: { children: React.ReactNode }) {
  // Try to load persisted data
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    try {
      const saved = localStorage.getItem('pdf-viewer-storage');
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...init, ...parsed, pdfDoc: null }; // Never persist actual doc object
      }
    } catch (e) {
      console.error('Failed to load viewer state', e);
    }
    return init;
  });

  // Persist important state on changes
  useEffect(() => {
    const dataToSave = {
      documentData: state.documentData,
      scale: state.scale,
      annotations: state.annotations,
      measurements: state.measurements
    };
    localStorage.setItem('pdf-viewer-storage', JSON.stringify(dataToSave));
  }, [state.documentData, state.scale, state.annotations, state.measurements]);

  return (
    <ViewerContext.Provider value={{ state, dispatch }}>
      {children}
    </ViewerContext.Provider>
  );
}

export function useViewerContext() {
  const context = useContext(ViewerContext);
  if (context === undefined) {
    throw new Error('useViewerContext must be used within a ViewerProvider');
  }
  return context;
}
