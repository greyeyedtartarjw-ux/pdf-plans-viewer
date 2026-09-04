// Preload script: runs in a privileged context with access to Node.js APIs
// but renders inside the renderer's context via contextBridge.
// Keep this minimal — expose only what the renderer genuinely needs.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openPdf: () => ipcRenderer.invoke('desktop:open-pdf'),
  stagePdf: (bytes: Uint8Array) => ipcRenderer.invoke('desktop:stage-pdf', bytes),
  saveState: (state: unknown) => ipcRenderer.invoke('desktop:save-state', state),
  loadState: () => ipcRenderer.invoke('desktop:load-state'),
});
