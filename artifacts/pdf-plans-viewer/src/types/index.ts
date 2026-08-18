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
  unit: string; // e.g., 'px'
  realWorldUnit: string; // e.g., 'm', 'cm', 'ft'
}

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
