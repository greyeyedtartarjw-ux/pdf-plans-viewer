export type Tool = 
  | 'pan' 
  | 'select' 
  | 'measure-distance' 
  | 'measure-area' 
  | 'highlight' 
  | 'note' 
  | 'text' 
  | 'set-scale';

export type SidebarTab = 'pages' | 'search' | 'measurements';

export interface Scale {
  set: boolean;
  pixelsPerUnit: number;
  unit: 'px';
  realWorldUnit: 'ft';
  scaleKind: 'preset' | 'custom';
  presetRatio: '1/8' | '1/4' | '3/6' | '3/4' | '1' | null;
  calibrationDistanceFeet: number | null;
}

export const SCALE_PRESETS = [
  { ratio: '1/8', pixelsPerFoot: 9 },
  { ratio: '1/4', pixelsPerFoot: 18 },
  { ratio: '3/6', pixelsPerFoot: 36 },
  { ratio: '3/4', pixelsPerFoot: 54 },
  { ratio: '1', pixelsPerFoot: 72 },
] as const;

export type ScalePresetRatio = typeof SCALE_PRESETS[number]['ratio'];

export const DEFAULT_SCALE: Scale = {
  set: false,
  pixelsPerUnit: 1,
  unit: 'px',
  realWorldUnit: 'ft',
  scaleKind: 'custom',
  presetRatio: null,
  calibrationDistanceFeet: null,
};

export interface Annotation {
  id: string;
  pageNumber: number;
  type: 'highlight' | 'note' | 'text';
  data: any; // Serialized Fabric object data
}

export interface Measurement {
  id: string;
  pageNumber: number;
  type: 'distance' | 'area';
  label: string;
  valueLabel: string;
  realWorldValue: number;
  unit: string;
  points: { x: number; y: number }[];
  data: any; // Serialized Fabric object data
}

export interface SearchResult {
  pageNumber: number;
  snippet: string;
  matchIndex: number;
  transform: number[]; // From pdf.js text content
}

export interface PDFDocumentData {
  name: string;
  size: number;
  hash: string;
}
