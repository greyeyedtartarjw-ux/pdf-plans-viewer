import React, { createContext, useContext, useReducer } from 'react';
import { Tool, SidebarTab, Scale, Annotation, Measurement, SearchResult, PDFDocumentData, DEFAULT_SCALE } from '../types';

interface ViewerState {
  pdfDoc: any | null;
  documentData: PDFDocumentData | null;
  documentId: number | null;
  currentPage: number;
  totalPages: number;
  zoom: number;
  activeTool: Tool;
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  highlightColor: string;
  scales: Record<number, Scale>;
  annotations: Record<number, Annotation[]>;
  measurements: Record<number, Measurement[]>;
  searchQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  isSyncing: boolean;
  shareToken: string | null;
  serverUnreachable: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'failed';
  measurementOrder: string[];
  remoteStateRevision: number;
}

type Action =
  | { type: 'SET_PDF_DOC'; doc: any; data: PDFDocumentData; totalPages: number }
  | { type: 'SET_DOCUMENT_ID'; documentId: number }
  | { type: 'SET_CURRENT_PAGE'; page: number }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'SET_ACTIVE_TOOL'; tool: Tool }
  | { type: 'SET_SIDEBAR_TAB'; tab: SidebarTab }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_HIGHLIGHT_COLOR'; color: string }
  | { type: 'SET_PAGE_SCALE'; page: number; scale: Scale }
  | { type: 'ADD_ANNOTATION'; page: number; annotation: Annotation }
  | { type: 'UPDATE_ANNOTATION'; page: number; id: string; data: any }
  | { type: 'UPDATE_MARKING_DATA'; page: number; id: string; data: Record<string, unknown> }
  | { type: 'REMOVE_ANNOTATION'; page: number; id: string }
  | { type: 'ADD_MEASUREMENT'; page: number; measurement: Measurement }
  | { type: 'REMOVE_MEASUREMENT'; page: number; id: string }
  | { type: 'RENAME_MEASUREMENT'; page: number; id: string; label: string }
  | {
      type: 'UPDATE_MEASUREMENT_VALUES';
      page: number;
      id: string;
      label: string;
      realWorldValue: number;
      unit: string;
      data: Record<string, unknown>;
    }
  | { type: 'REORDER_MEASUREMENTS'; orderedIds: string[] }
  | { type: 'CLEAR_MEASUREMENTS' }
  | { type: 'SET_SEARCH_STATE'; query: string; results: SearchResult[]; isSearching: boolean }
  | { type: 'SET_SYNCING'; syncing: boolean }
  | { type: 'SET_SERVER_UNREACHABLE'; unreachable: boolean }
  | { type: 'SET_SAVE_STATUS'; status: 'idle' | 'saving' | 'saved' | 'failed' }
  | {
      type: 'LOAD_REMOTE_STATE';
      documentId: number;
      annotations: Record<number, Annotation[]>;
      measurements: Record<number, Measurement[]>;
       scales: Record<number, Scale>;
      shareToken?: string;
    }
  | {
      type: 'LOAD_LOCAL_STATE';
      annotations: Record<number, Annotation[]>;
      measurements: Record<number, Measurement[]>;
      scales: Record<number, Scale>;
    };

const initialState: ViewerState = {
  pdfDoc: null,
  documentData: null,
  documentId: null,
  currentPage: 1,
  totalPages: 0,
  zoom: 1.0,
  activeTool: 'pan',
  sidebarTab: 'pages',
  sidebarOpen: true,
  highlightColor: 'rgba(255, 235, 59, 0.4)',
  scales: {},
  annotations: {},
  measurements: {},
  searchQuery: '',
  searchResults: [],
  isSearching: false,
  isSyncing: false,
  shareToken: null,
  serverUnreachable: false,
  saveStatus: 'idle',
  measurementOrder: [],
  remoteStateRevision: 0,
};

function reducer(state: ViewerState, action: Action): ViewerState {
  switch (action.type) {
    case 'SET_PDF_DOC':
      return {
        ...state,
        pdfDoc: action.doc,
        documentData: action.data,
        totalPages: action.totalPages,
        currentPage: 1,
        annotations: {},
        measurements: {},
        scales: {},
        documentId: null,
        measurementOrder: [],
        remoteStateRevision: state.remoteStateRevision + 1,
      };
    case 'SET_DOCUMENT_ID':
      return { ...state, documentId: action.documentId };
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
    case 'SET_PAGE_SCALE':
      return {
        ...state,
        scales: { ...state.scales, [action.page]: action.scale },
      };
    case 'ADD_ANNOTATION':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: [...(state.annotations[action.page] || []), action.annotation],
        },
      };
    case 'UPDATE_ANNOTATION':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: (state.annotations[action.page] || []).map(a =>
            a.id === action.id ? { ...a, data: action.data } : a
          ),
        },
      };
    case 'UPDATE_MARKING_DATA':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: (state.annotations[action.page] || []).map(annotation =>
            annotation.id === action.id ? { ...annotation, data: action.data } : annotation,
          ),
        },
        measurements: {
          ...state.measurements,
          [action.page]: (state.measurements[action.page] || []).map(measurement =>
            measurement.id === action.id ? { ...measurement, data: action.data } : measurement,
          ),
        },
      };
    case 'REMOVE_ANNOTATION':
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [action.page]: (state.annotations[action.page] || []).filter(a => a.id !== action.id),
        },
      };
    case 'ADD_MEASUREMENT':
      return {
        ...state,
        measurements: {
          ...state.measurements,
          [action.page]: [...(state.measurements[action.page] || []), action.measurement],
        },
        measurementOrder: [...state.measurementOrder, action.measurement.id],
      };
    case 'REMOVE_MEASUREMENT':
      return {
        ...state,
        measurements: {
          ...state.measurements,
          [action.page]: (state.measurements[action.page] || []).filter(m => m.id !== action.id),
        },
        measurementOrder: state.measurementOrder.filter(id => id !== action.id),
      };
    case 'RENAME_MEASUREMENT':
      return {
        ...state,
        measurements: {
          ...state.measurements,
          [action.page]: (state.measurements[action.page] || []).map(m =>
            m.id === action.id ? { ...m, label: action.label } : m
          ),
        },
      };
    case 'UPDATE_MEASUREMENT_VALUES':
      return {
        ...state,
        measurements: {
          ...state.measurements,
          [action.page]: (state.measurements[action.page] || []).map(m =>
            m.id === action.id
              ? {
                  ...m,
                  label: action.label,
                  realWorldValue: action.realWorldValue,
                  unit: action.unit,
                  data: action.data,
                }
              : m,
          ),
        },
        remoteStateRevision: state.remoteStateRevision + 1,
      };
    case 'REORDER_MEASUREMENTS':
      return { ...state, measurementOrder: action.orderedIds };
    case 'CLEAR_MEASUREMENTS':
      return { ...state, measurements: {}, measurementOrder: [] };
    case 'SET_SEARCH_STATE':
      return { ...state, searchQuery: action.query, searchResults: action.results, isSearching: action.isSearching };
    case 'SET_SYNCING':
      return { ...state, isSyncing: action.syncing };
    case 'SET_SERVER_UNREACHABLE':
      return { ...state, serverUnreachable: action.unreachable };
    case 'SET_SAVE_STATUS':
      return { ...state, saveStatus: action.status };
    case 'LOAD_REMOTE_STATE': {
      const allIds = Object.values(action.measurements).flatMap(ms => ms.map(m => m.id));
      return {
        ...state,
        documentId: action.documentId,
        annotations: action.annotations,
        measurements: action.measurements,
        scales: action.scales,
        isSyncing: false,
        shareToken: action.shareToken ?? null,
        measurementOrder: allIds,
        remoteStateRevision: state.remoteStateRevision + 1,
      };
    }
    case 'LOAD_LOCAL_STATE': {
      const allIds = Object.values(action.measurements).flatMap(ms => ms.map(m => m.id));
      return {
        ...state,
        annotations: action.annotations,
        measurements: action.measurements,
        scales: action.scales,
        measurementOrder: allIds,
        remoteStateRevision: state.remoteStateRevision + 1,
      };
    }
    default:
      return state;
  }
}

const ViewerContext = createContext<{
  state: ViewerState;
  dispatch: React.Dispatch<Action>;
} | undefined>(undefined);

export function ViewerProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

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