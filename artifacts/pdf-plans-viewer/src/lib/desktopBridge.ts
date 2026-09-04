import type { Annotation, Measurement, Scale } from '../types';
import type { PendingOp } from './pendingQueue';

export interface DesktopSnapshot {
  version: 2;
  recoveryId: string;
  savedAt: number;
  name: string;
  hash: string;
  size: number;
  documentId: number | null;
  annotations: Record<number, Annotation[]>;
  measurements: Record<number, Measurement[]>;
  scales: Record<number, Scale>;
  pendingOps: PendingOp[];
}

interface OpenedDesktopPdf {
  name: string;
  bytes: Uint8Array;
  recoveryId: string;
}

interface RecoveredDesktopPlan {
  state: DesktopSnapshot;
  bytes: Uint8Array;
}

export interface ElectronAPI {
  platform: string;
  openPdf(): Promise<OpenedDesktopPdf | null>;
  stagePdf(bytes: Uint8Array): Promise<string>;
  saveState(state: DesktopSnapshot): Promise<void>;
  loadState(): Promise<RecoveredDesktopPlan | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export function desktopApi(): ElectronAPI | null {
  return window.electronAPI ?? null;
}

export function bytesToPdfFile(name: string, bytes: Uint8Array): File {
  return new File([bytes.slice().buffer], name, { type: 'application/pdf' });
}