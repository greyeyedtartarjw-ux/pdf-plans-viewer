import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let saveStateLane: Promise<void> = Promise.resolve();
const SNAPSHOT_FILE = 'desktop-state.json';
const PDF_DIRECTORY = 'plans';

async function atomicWrite(filePath: string, data: string | Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, filePath);
}

async function stagePdf(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('The selected file is not a valid PDF.');
  }
  const recoveryId = `${randomUUID()}.pdf`;
  await atomicWrite(
    path.join(app.getPath('userData'), PDF_DIRECTORY, recoveryId),
    buffer,
  );
  return recoveryId;
}

function registerDesktopHandlers() {
  ipcMain.handle('desktop:open-pdf', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open PDF plan',
      properties: ['openFile'],
      filters: [{ name: 'PDF plans', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const sourcePath = result.filePaths[0];
    const bytes = await readFile(sourcePath);
    const recoveryId = await stagePdf(bytes);
    return { name: path.basename(sourcePath), bytes: new Uint8Array(bytes), recoveryId };
  });
  ipcMain.handle('desktop:stage-pdf', async (_event, bytes: Uint8Array) =>
    stagePdf(bytes),
  );

  ipcMain.handle('desktop:save-state', async (_event, state: unknown) => {
    const serialized = JSON.stringify(state);
    if (serialized.length > 25 * 1024 * 1024) throw new Error('Desktop state is too large to save.');
    const parsed = JSON.parse(serialized) as { recoveryId?: unknown };
    if (
      typeof parsed.recoveryId !== 'string'
      || !/^[0-9a-f-]{36}\.pdf$/.test(parsed.recoveryId)
    ) {
      throw new Error('Desktop state does not reference a valid local PDF.');
    }
    const write = saveStateLane.then(() =>
      atomicWrite(path.join(app.getPath('userData'), SNAPSHOT_FILE), serialized),
    );
    saveStateLane = write.catch(() => undefined);
    await write;
  });

  ipcMain.handle('desktop:load-state', async () => {
    try {
      const serialized = await readFile(path.join(app.getPath('userData'), SNAPSHOT_FILE), 'utf8');
      const state = JSON.parse(serialized) as { recoveryId?: unknown };
      if (
        typeof state.recoveryId !== 'string'
        || !/^[0-9a-f-]{36}\.pdf$/.test(state.recoveryId)
      ) return null;
      const bytes = await readFile(
        path.join(app.getPath('userData'), PDF_DIRECTORY, state.recoveryId),
      );
      return { state, bytes: new Uint8Array(bytes) };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') return null;
      throw error;
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'PDF Plans Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    // macOS traffic-light look on non-Mac is still fine
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  if (isDev) {
    // Point to the Vite dev server — set VITE_PORT env if needed
    const port = process.env['VITE_PORT'] ?? '5173';
    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.webContents.openDevTools();
  } else {
    // Load the production build.  The API base URL is embedded at build time.
    mainWindow.loadFile(path.join(__dirname, '..', 'desktop-public', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Open external links in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('mailto:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerDesktopHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
