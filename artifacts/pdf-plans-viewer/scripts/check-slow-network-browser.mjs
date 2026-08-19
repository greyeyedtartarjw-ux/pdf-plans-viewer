import { createServer } from 'node:http';
import { readFile, writeFile, access, constants } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { devices, firefox, webkit } from 'playwright';

const execFileAsync = promisify(execFile);

const INITIAL_FORBIDDEN_CHUNKS = [
  'PDFPageViewer-',
  'pdfUtils-',
  'PageThumbnails-',
  'SearchPanel-',
  'ScaleDialog-',
  'html2canvas.esm-',
  'pdf.worker.min.js',
];

const OPTIONAL_CHUNKS = [
  'PageThumbnails-',
  'SearchPanel-',
  'ScaleDialog-',
  'html2canvas.esm-',
];

const SLOW_NETWORK_RESPONSE_DELAY_MS = 150;
const PLAN_OPEN_BUDGET_MS = 6_000;
const LARGE_PLAN_PAGE_COUNT = 12;
const LARGE_PLAN_PAGE_BYTES = 512 * 1024;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

let nixRuntimeLibraryPath;

async function getNixRuntimeLibraryPath() {
  if (!nixRuntimeLibraryPath) {
    nixRuntimeLibraryPath = (async () => {
      try {
        const packageResults = await Promise.all(
          ['webkitgtk_6_0', 'libglvnd', 'gst_all_1.gst-libav'].map(async (packageName) => {
            const { stdout } = await execFileAsync(
              'rippkgs',
              ['--exact', '--json', packageName],
              { timeout: 15_000 },
            );
            return JSON.parse(stdout);
          }),
        );
        const storePaths = packageResults.flatMap((result) => result.flatMap(
          (entry) => Object.values(entry.store_paths ?? {}),
        ));
        const directories = await Promise.all(storePaths.flatMap((storePath) => [
          resolve('/nix/store', storePath, 'lib'),
          resolve('/nix/store', storePath, 'lib/gstreamer-1.0'),
        ]).map(async (libraryDirectory) => {
          try {
            await access(libraryDirectory, constants.R_OK);
            return libraryDirectory;
          } catch {
            return null;
          }
        }));
        return directories.filter(Boolean).join(':');
      } catch {
        return '';
      }
    })();
  }

  return nixRuntimeLibraryPath;
}

function sendJson(response, payload) {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function assertNoRequests(requests, forbiddenChunks, stage) {
  const unexpected = requests
    .map((request) => request.pathname)
    .filter((pathname) => forbiddenChunks.some((chunk) => pathname.includes(chunk)));

  if (unexpected.length > 0) {
    throw new Error(
      `${stage} requested feature chunks before they were needed: ${[...new Set(unexpected)].join(', ')}`,
    );
  }
}

function createFixturePdf() {
  const pageContents = 'BT\n/F1 24 Tf\n72 2280 Td\n(Large plan navigation check) Tj\nET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2800 2400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(pageContents, 'utf8')} >>\nstream\n${pageContents}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += object;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

function createLargeFixturePdf() {
  const pageIds = Array.from(
    { length: LARGE_PLAN_PAGE_COUNT },
    (_, index) => index + 3,
  );
  const firstContentId = 3 + LARGE_PLAN_PAGE_COUNT;
  const fontId = firstContentId + LARGE_PLAN_PAGE_COUNT;
  const pageContents = [
    'BT\n/F1 8 Tf\n72 744 Td\n',
    ' (Representative large plan detail) Tj\n',
    'ET\n',
  ].join('');
  const repeatedPageContent = pageContents.repeat(
    Math.ceil(LARGE_PLAN_PAGE_BYTES / Buffer.byteLength(pageContents, 'utf8')),
  );
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${LARGE_PLAN_PAGE_COUNT} >>\nendobj\n`,
    ...pageIds.map((pageId, index) => {
      const contentId = firstContentId + index;
      return `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`;
    }),
    ...pageIds.map((_, index) => {
      const contentId = firstContentId + index;
      return `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(repeatedPageContent, 'utf8')} >>\nstream\n${repeatedPageContent}endstream\nendobj\n`;
    }),
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += object;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

async function createStaticServer(root) {
  const resolvedRoot = resolve(root);
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    // Firefox and WebKit do not expose Chromium's network-emulation protocol.
    // Add latency at the fixture server so every engine verifies the same
    // deferred-loading behavior under a constrained connection.
    await delay(SLOW_NETWORK_RESPONSE_DELAY_MS);

    // The release check must use the normal successful open path. These
    // responses keep the test isolated from the development database while
    // allowing Shell to load its empty remote annotations, measurements, and
    // scale without showing its blocking load-failure alert.
    if (request.method === 'GET' && requestPath === '/api/healthz') {
      sendJson(response, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/documents') {
      sendJson(response, {
        id: 1,
        name: 'plan-render-check.pdf',
        hash: 'release-check',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/documents/1/annotations') {
      sendJson(response, [{
        id: 'release-check-highlight',
        documentId: 1,
        pageNumber: 1,
        type: 'highlight',
        fabricData: {
          type: 'Rect',
          left: 800,
          top: 700,
          width: 100,
          height: 80,
          fill: '#ff0000',
          viewerZoom: 1,
        },
      }]);
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/documents/1/measurements') {
      sendJson(response, [{
        id: 'release-check-measurement',
        documentId: 1,
        pageNumber: 1,
        type: 'distance',
        label: '100 px',
        realWorldValue: 100,
        unit: 'px',
        points: [{ x: 1200, y: 1000 }, { x: 1300, y: 1080 }],
        fabricData: {
          type: 'Rect',
          left: 1200,
          top: 1000,
          width: 100,
          height: 80,
          fill: '#0000ff',
          viewerZoom: 1,
        },
      }]);
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/documents/1/scale') {
      sendJson(response, {
        documentId: 1,
        isSet: false,
        pixelsPerUnit: 1,
        unit: 'px',
        realWorldUnit: 'px',
      });
      return;
    }

    const relativePath = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath).replace(/^\/+/, '');
    const filePath = resolve(resolvedRoot, relativePath);

    if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }

    try {
      const contents = await readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      });
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Could not start the release-build test server.');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function findOpenPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  probe.close();

  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a Chromium debugging port.');
  }
  return address.port;
}

async function waitForJson(url, timeoutMs, description) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function launchChromium() {
  const debuggingPort = await findOpenPort();
  const chromiumPath = process.env.CHROMIUM_PATH ?? 'chromium';
  const browser = spawn(
    chromiumPath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${debuggingPort}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  browser.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const targets = await waitForJson(
      `http://127.0.0.1:${debuggingPort}/json/list`,
      20_000,
      'headless Chromium',
    );
    const pageTarget = targets.find((target) => target.type === 'page');

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('Chromium did not expose a debuggable page target.');
    }

    return { browser, webSocketDebuggerUrl: pageTarget.webSocketDebuggerUrl };
  } catch (error) {
    browser.kill('SIGKILL');
    throw new Error(
      `Could not launch Chromium (${chromiumPath}): ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`,
    );
  }
}

class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.nextMessageId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    return new DevToolsClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextMessageId++;
    return new Promise((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectMessage(new Error(`Timed out waiting for Chrome DevTools to respond to ${method}.`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolveMessage(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectMessage(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket.close();
  }
}

async function waitForCondition(client, expression, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const evaluation = await client.send('Runtime.evaluate', {
      expression: `Boolean(${expression})`,
      returnByValue: true,
    });
    if (evaluation.result.value) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function chooseFixturePdf(client, fixturePath) {
  const document = await client.send('DOM.getDocument');
  const { nodeId } = await client.send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]',
  });

  if (!nodeId) {
    throw new Error('Could not find the PDF file picker on the initial route.');
  }

  await client.send('DOM.setFileInputFiles', {
    files: [fixturePath],
    nodeId,
  });
}

function assertViewerRequests(requests, selectionStartedAt, browserName) {
  const afterFileSelection = requests.filter((request) => request.timestamp >= selectionStartedAt);
  const requestedPaths = afterFileSelection.map((request) => request.pathname);

  for (const expectedChunk of ['pdfUtils-', 'PDFPageViewer-']) {
    if (!requestedPaths.some((pathname) => basename(pathname).startsWith(expectedChunk))) {
      throw new Error(`${browserName}: choosing a PDF did not request the expected ${expectedChunk} chunk.`);
    }
  }

  assertNoRequests(
    afterFileSelection,
    OPTIONAL_CHUNKS,
    `${browserName}: opening a PDF`,
  );
}

function logPassedBrowserCheck(browserName, viewerShownInMs) {
  console.log(
    `Slow-network browser check passed in ${browserName}: the initial route avoided ${INITIAL_FORBIDDEN_CHUNKS.length} deferred assets and the viewer appeared in ${viewerShownInMs}ms.`,
  );
}

async function runChromiumSlowNetworkBrowserCheck({ staticServer, fixturePath }) {
  const { browser, webSocketDebuggerUrl } = await launchChromium();
  const client = await DevToolsClient.connect(webSocketDebuggerUrl);
  const requests = [];

  client.on('Network.requestWillBeSent', ({ request }) => {
    const url = new URL(request.url);
    if (url.origin === staticServer.origin) {
      requests.push({ pathname: url.pathname, timestamp: Date.now() });
    }
  });

  try {
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: 256 * 1024,
      uploadThroughput: 128 * 1024,
      connectionType: 'cellular3g',
    });
    await client.send('Page.enable');
    await client.send('DOM.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url: staticServer.origin });

    await waitForCondition(
      client,
      'document.querySelector("button")?.textContent?.includes("Open")',
      'the initial PDF viewer route',
    );
    await delay(750);
    const beforeFileSelection = [...requests];
    assertNoRequests(
      beforeFileSelection,
      INITIAL_FORBIDDEN_CHUNKS,
      'Chromium: the initial route',
    );

    const selectionStartedAt = Date.now();
    await chooseFixturePdf(client, fixturePath);
    await waitForCondition(
      client,
      `(() => {
        const viewer = document.querySelector("#pdf-viewer-area");
        const renderedPage = viewer?.querySelector('[data-page-rendered="true"]');
        const pdfCanvas = renderedPage?.querySelector("canvas");
        const stillRendering = [...(viewer?.querySelectorAll("span") ?? [])]
          .some((element) => element.textContent?.includes("Rendering page"));
        return Boolean(pdfCanvas && pdfCanvas.width > 0 && pdfCanvas.height > 0 && !stillRendering);
      })()`,
      'a rendered PDF page after choosing a plan',
      6_000,
    );
    const viewerShownInMs = Date.now() - selectionStartedAt;

    if (viewerShownInMs > 6_000) {
      throw new Error(`Chromium: the plan viewer took ${viewerShownInMs}ms to appear on the throttled connection.`);
    }

    await waitForCondition(
      client,
      `(() => {
        const page = document.querySelector('[data-page-rendered="true"]');
        if (!page) return false;
        const hasColorAt = (sceneX, sceneY, color) => [...page.querySelectorAll('canvas')].some((canvas) => {
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const context = canvas.getContext('2d');
          if (!context) return false;
          const x = Math.floor(sceneX * canvas.width / rect.width);
          const y = Math.floor(sceneY * canvas.height / rect.height);
          const pixel = context.getImageData(x, y, 1, 1).data;
          return color === 'red'
            ? pixel[0] > 220 && pixel[1] < 40 && pixel[2] < 40
            : pixel[2] > 220 && pixel[0] < 40 && pixel[1] < 40;
        });
        return hasColorAt(850, 740, 'red') && hasColorAt(1250, 1040, 'blue');
      })()`,
      'the restored annotation and measurement overlays',
    );

    await delay(750);
    assertViewerRequests(requests, selectionStartedAt, 'Chromium');
    const navigationTarget = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const page = document.querySelector('[data-page-rendered="true"]');
        const scroller = document.querySelector('#pdf-scroll-container');
        if (!page || !scroller) return null;
        const pageRect = page.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        return {
          x: Math.min(pageRect.right - 80, Math.max(pageRect.left + 260, scrollerRect.left + 120)),
          y: Math.min(pageRect.bottom - 80, Math.max(pageRect.top + 260, scrollerRect.top + 120)),
        };
      })()`,
      returnByValue: true,
    });
    const target = navigationTarget.result.value;
    if (!target) throw new Error('Could not find a rendered plan for navigation checks.');

    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: target.x,
      y: target.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x - 180,
      y: target.y - 160,
      button: 'left',
      buttons: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: target.x - 180,
      y: target.y - 160,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });

    await delay(200);
    const panPosition = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const scroller = document.querySelector("#pdf-scroll-container");
        const page = document.querySelector('[data-page-rendered="true"]');
        return scroller ? {
          scrollLeft: scroller.scrollLeft,
          scrollTop: scroller.scrollTop,
          scrollWidth: scroller.scrollWidth,
          scrollHeight: scroller.scrollHeight,
          clientWidth: scroller.clientWidth,
          clientHeight: scroller.clientHeight,
          cursor: page?.style.cursor,
        } : null;
      })()`,
      returnByValue: true,
    });
    const panned = panPosition.result.value;
    if (!panned || panned.scrollLeft <= 100 || panned.scrollTop <= 100 || panned.cursor !== 'grab') {
      throw new Error(`Grab-tool panning did not move both axes: ${JSON.stringify(panned)}.`);
    }

    const focalBeforeZoom = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const page = document.querySelector('[data-page-rendered="true"]');
        const scroller = document.querySelector('#pdf-scroll-container');
        if (!page || !scroller) return null;
        const pageRect = page.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const zoom = Number(document.querySelector('select')?.value ?? 1);
        const x = Math.min(pageRect.right - 100, Math.max(pageRect.left + 300, scrollerRect.left + 180));
        const y = Math.min(pageRect.bottom - 100, Math.max(pageRect.top + 300, scrollerRect.top + 180));
        return { x, y, sceneX: (x - pageRect.left) / zoom, sceneY: (y - pageRect.top) / zoom };
      })()`,
      returnByValue: true,
    });
    const focal = focalBeforeZoom.result.value;
    if (!focal) throw new Error('Could not calculate a cursor focal point for wheel zoom.');

    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: focal.x,
      y: focal.y,
      deltaX: 0,
      deltaY: -120,
    });
    await waitForCondition(
      client,
      `document.querySelector('select')?.value === '1.25'`,
      'the cursor-focused wheel zoom level',
    );
    await waitForCondition(
      client,
      `(() => {
        const page = document.querySelector('[data-page-rendered="true"]');
        if (!page) return false;
        const rect = page.getBoundingClientRect();
        const sceneX = (${focal.x} - rect.left) / 1.25;
        const sceneY = (${focal.y} - rect.top) / 1.25;
        return Math.abs(sceneX - ${focal.sceneX}) < 4 && Math.abs(sceneY - ${focal.sceneY}) < 4;
      })()`,
      'wheel zoom focal-point stability',
    );
    await waitForCondition(
      client,
      `(() => {
        const page = document.querySelector('[data-page-rendered="true"]');
        if (!page) return false;
        const hasColorAt = (sceneX, sceneY, color) => [...page.querySelectorAll('canvas')].some((canvas) => {
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const context = canvas.getContext('2d');
          if (!context) return false;
          const x = Math.floor(sceneX * 1.25 * canvas.width / rect.width);
          const y = Math.floor(sceneY * 1.25 * canvas.height / rect.height);
          const pixel = context.getImageData(x, y, 1, 1).data;
          return color === 'red'
            ? pixel[0] > 220 && pixel[1] < 40 && pixel[2] < 40
            : pixel[2] > 220 && pixel[0] < 40 && pixel[1] < 40;
        });
        return hasColorAt(850, 740, 'red') && hasColorAt(1250, 1040, 'blue');
      })()`,
      'aligned annotation and measurement overlays after wheel zoom',
    );

    for (let index = 0; index < 16; index += 1) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: focal.x,
        y: focal.y,
        deltaX: 0,
        deltaY: 120,
      });
    }
    await waitForCondition(
      client,
      `document.querySelector('select')?.value === '0.25'`,
      'the minimum wheel zoom bound',
    );

    console.log(
      `Slow-network browser check passed in Chromium: full-plan pan/zoom navigation worked and the viewer appeared in ${viewerShownInMs}ms.`,
    );
  } finally {
    client.close();
    browser.kill('SIGKILL');
  }
}

async function runPlaywrightSlowNetworkBrowserCheck({
  browserType,
  browserName,
  staticServer,
  fixturePath,
  contextOptions = {},
  openBudgetMs = PLAN_OPEN_BUDGET_MS,
}) {
  const nixLibraryPath = browserType === webkit
    ? await getNixRuntimeLibraryPath()
    : '';
  const priorSkipValidation = process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS;

  if (browserType === webkit) {
    process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  }

  let browser;
  try {
    browser = await browserType.launch({
      headless: true,
      ...(nixLibraryPath
        ? {
          env: {
            ...process.env,
            LD_LIBRARY_PATH: [process.env.LD_LIBRARY_PATH, nixLibraryPath].filter(Boolean).join(':'),
          },
        }
        : {}),
    });
  } finally {
    if (priorSkipValidation === undefined) {
      delete process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS;
    } else {
      process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = priorSkipValidation;
    }
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const requests = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === staticServer.origin) {
      requests.push({ pathname: url.pathname, timestamp: Date.now() });
    }
  });

  try {
    await page.goto(staticServer.origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /open/i }).first().waitFor();
    await page.waitForTimeout(750);
    const beforeFileSelection = [...requests];
    assertNoRequests(
      beforeFileSelection,
      INITIAL_FORBIDDEN_CHUNKS,
      `${browserName}: the initial route`,
    );

    const selectionStartedAt = Date.now();
    await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
    try {
      await page.waitForFunction(
        () => {
          const viewer = document.querySelector('#pdf-viewer-area');
          const renderedPage = viewer?.querySelector('[data-page-rendered="true"]');
          const pdfCanvas = renderedPage?.querySelector('canvas');
          const stillRendering = [...(viewer?.querySelectorAll('span') ?? [])]
            .some((element) => element.textContent?.includes('Rendering page'));
          return Boolean(pdfCanvas && pdfCanvas.width > 0 && pdfCanvas.height > 0 && !stillRendering);
        },
        undefined,
        { timeout: openBudgetMs },
      );
    } catch (error) {
      const elapsedMs = Date.now() - selectionStartedAt;
      throw new Error(
        `${browserName}: the plan viewer did not render within the ${openBudgetMs}ms `
          + `open-time budget (elapsed ${elapsedMs}ms). ${error.message}`,
      );
    }
    const viewerShownInMs = Date.now() - selectionStartedAt;

    if (viewerShownInMs > openBudgetMs) {
      throw new Error(`${browserName}: the plan viewer took ${viewerShownInMs}ms to appear on the throttled connection.`);
    }

    await page.waitForTimeout(750);
    assertViewerRequests(requests, selectionStartedAt, browserName);
    logPassedBrowserCheck(browserName, viewerShownInMs);
  } finally {
    await browser.close();
  }
}

export async function runSlowNetworkBrowserCheck({ viewerRoot }) {
  const staticServer = await createStaticServer(resolve(viewerRoot, 'dist/public'));
  const fixturePath = resolve(tmpdir(), `plans-viewer-release-check-${randomUUID()}.pdf`);
  const largeFixturePath = resolve(tmpdir(), `plans-viewer-iphone-safari-check-${randomUUID()}.pdf`);

  try {
    await writeFile(fixturePath, createFixturePdf());
    await writeFile(largeFixturePath, createLargeFixturePdf());
    await runChromiumSlowNetworkBrowserCheck({ staticServer, fixturePath });
    await runPlaywrightSlowNetworkBrowserCheck({
      browserType: firefox,
      browserName: 'Firefox',
      staticServer,
      fixturePath,
    });
    await runPlaywrightSlowNetworkBrowserCheck({
      browserType: webkit,
      browserName: 'WebKit',
      staticServer,
      fixturePath,
    });
    await runPlaywrightSlowNetworkBrowserCheck({
      browserType: webkit,
      browserName: 'iPhone Safari (WebKit emulation)',
      contextOptions: devices['iPhone 13'],
      openBudgetMs: PLAN_OPEN_BUDGET_MS,
      staticServer,
      fixturePath: largeFixturePath,
    });
  } finally {
    staticServer.close();
  }
}

export {
  assertNoRequests,
  assertViewerRequests,
  createLargeFixturePdf,
  INITIAL_FORBIDDEN_CHUNKS,
  OPTIONAL_CHUNKS,
  PLAN_OPEN_BUDGET_MS,
};