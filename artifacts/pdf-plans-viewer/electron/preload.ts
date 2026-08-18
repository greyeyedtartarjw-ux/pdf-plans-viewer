// Preload script: runs in a privileged context with access to Node.js APIs
// but renders inside the renderer's context via contextBridge.
// Keep this minimal — expose only what the renderer genuinely needs.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  /** Returns the platform string ("win32", "darwin", "linux") */
  platform: process.platform,

  /** Signals the main process to open the native file-open dialog */
  openFile: () => ipcRenderer.invoke('open-file'),
});
