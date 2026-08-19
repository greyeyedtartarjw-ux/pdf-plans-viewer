import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

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

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

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
  const pageContents = 'BT\n/F1 24 Tf\n72 720 Td\n(Plan render check) Tj\nET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
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

async function createStaticServer(root) {
  const resolvedRoot = resolve(root);
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

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
    if (request.method === 'GET' && /^\/api\/documents\/1\/(?:annotations|measurements)$/.test(requestPath)) {
      sendJson(response, []);
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

export async function runSlowNetworkBrowserCheck({ viewerRoot }) {
  const staticServer = await createStaticServer(resolve(viewerRoot, 'dist/public'));
  const fixturePath = resolve(tmpdir(), `plans-viewer-release-check-${randomUUID()}.pdf`);
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
    await writeFile(fixturePath, createFixturePdf());
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
      'The initial route',
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
      throw new Error(`The plan viewer took ${viewerShownInMs}ms to appear on the throttled connection.`);
    }

    await delay(750);
    const afterFileSelection = requests.filter((request) => request.timestamp >= selectionStartedAt);
    const requestedPaths = afterFileSelection.map((request) => request.pathname);

    for (const expectedChunk of ['pdfUtils-', 'PDFPageViewer-']) {
      if (!requestedPaths.some((pathname) => basename(pathname).startsWith(expectedChunk))) {
        throw new Error(`Choosing a PDF did not request the expected ${expectedChunk} chunk.`);
      }
    }

    assertNoRequests(
      afterFileSelection,
      OPTIONAL_CHUNKS,
      'Opening a PDF',
    );

    console.log(
      `Slow-network browser check passed: the initial route avoided ${INITIAL_FORBIDDEN_CHUNKS.length} deferred assets and the viewer appeared in ${viewerShownInMs}ms.`,
    );
  } finally {
    client.close();
    browser.kill('SIGKILL');
    staticServer.close();
  }
}