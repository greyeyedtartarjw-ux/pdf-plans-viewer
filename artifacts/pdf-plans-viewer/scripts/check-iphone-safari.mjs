import { chromium, firefox, webkit } from 'playwright';

import {
  assertNoRequests,
  assertViewerRequests,
  createLargeFixturePdf,
  INITIAL_FORBIDDEN_CHUNKS,
  PLAN_OPEN_BUDGET_MS,
} from './check-slow-network-browser.mjs';

const baseUrl = process.env.IOS_SAFARI_BASE_URL;
const wsEndpoint = process.env.IOS_SAFARI_PLAYWRIGHT_WS_ENDPOINT;
const protocol = process.env.IOS_SAFARI_PLAYWRIGHT_PROTOCOL ?? 'playwright';
const browserName = process.env.IOS_SAFARI_PLAYWRIGHT_BROWSER ?? 'chromium';
const latencyMs = Number(process.env.IOS_SAFARI_LATENCY_MS ?? '150');
const openBudgetMs = Number(process.env.IOS_SAFARI_OPEN_BUDGET_MS ?? PLAN_OPEN_BUDGET_MS);
const fixtureName = 'representative-large-plan.pdf';

if (!baseUrl || !wsEndpoint) {
  throw new Error(
    'Hosted iPhone Safari check requires IOS_SAFARI_BASE_URL and IOS_SAFARI_PLAYWRIGHT_WS_ENDPOINT. '
      + 'The base URL must be a reachable hosted build, and the endpoint must point to an iPhone Safari session.',
  );
}

if (!['playwright', 'cdp'].includes(protocol)) {
  throw new Error(`Unsupported IOS_SAFARI_PLAYWRIGHT_PROTOCOL "${protocol}". Use "playwright" or "cdp".`);
}

if (!['chromium', 'firefox', 'webkit'].includes(browserName)) {
  throw new Error(`Unsupported IOS_SAFARI_PLAYWRIGHT_BROWSER "${browserName}".`);
}

if (!Number.isFinite(latencyMs) || latencyMs < 0) {
  throw new Error(`IOS_SAFARI_LATENCY_MS must be a non-negative number; received "${process.env.IOS_SAFARI_LATENCY_MS}".`);
}

if (!Number.isFinite(openBudgetMs) || openBudgetMs <= 0) {
  throw new Error(`IOS_SAFARI_OPEN_BUDGET_MS must be a positive number; received "${process.env.IOS_SAFARI_OPEN_BUDGET_MS}".`);
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function getBrowserType() {
  return { chromium, firefox, webkit }[browserName];
}

function isRenderedPlanReady() {
  const viewer = document.querySelector('#pdf-viewer-area');
  const renderedPage = viewer?.querySelector('[data-page-rendered="true"]');
  const pdfCanvas = renderedPage?.querySelector('canvas');
  const stillRendering = [...(viewer?.querySelectorAll('span') ?? [])]
    .some((element) => element.textContent?.includes('Rendering page'));
  return Boolean(pdfCanvas && pdfCanvas.width > 0 && pdfCanvas.height > 0 && !stillRendering);
}

async function main() {
  const pdf = Buffer.from(createLargeFixturePdf(), 'utf8');
  const browser = protocol === 'cdp'
    ? await chromium.connectOverCDP(wsEndpoint)
    : await getBrowserType().connect(wsEndpoint);

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    const pageErrors = [];
    const baseOrigin = new URL(baseUrl).origin;

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === baseOrigin) {
        requests.push({ pathname: url.pathname, timestamp: Date.now() });
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', async (route) => {
      await delay(latencyMs);
      await route.continue();
    });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    if (
      !/\biPhone\b/.test(userAgent)
      || !/\bSafari\b/.test(userAgent)
      || /\b(?:CriOS|FxiOS|EdgiOS|OPiOS)\b/.test(userAgent)
    ) {
      throw new Error(
        `Hosted iPhone Safari check requires an iPhone Safari session; received user agent "${userAgent}".`,
      );
    }

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /open/i }).first().waitFor({
      timeout: openBudgetMs,
    });
    await page.waitForTimeout(750);
    assertNoRequests(
      requests,
      INITIAL_FORBIDDEN_CHUNKS,
      'Hosted iPhone Safari: the initial route',
    );

    const selectionStartedAt = Date.now();
    await page.locator('input[type="file"]').first().setInputFiles({
      name: fixtureName,
      mimeType: 'application/pdf',
      buffer: pdf,
    });

    try {
      await page.waitForFunction(isRenderedPlanReady, undefined, {
        timeout: openBudgetMs,
      });
    } catch (error) {
      const elapsedMs = Date.now() - selectionStartedAt;
      const details = pageErrors.length > 0 ? ` Page errors: ${pageErrors.join(' | ')}` : '';
      throw new Error(
        `Hosted iPhone Safari: the large plan did not render within ${openBudgetMs}ms `
          + `(elapsed ${elapsedMs}ms).${details} ${error.message}`,
      );
    }

    const viewerShownInMs = Date.now() - selectionStartedAt;
    if (viewerShownInMs > openBudgetMs) {
      throw new Error(
        `Hosted iPhone Safari: the large plan took ${viewerShownInMs}ms to appear `
          + `on the constrained connection; budget is ${openBudgetMs}ms.`,
      );
    }

    await page.waitForTimeout(750);
    assertViewerRequests(requests, selectionStartedAt, 'Hosted iPhone Safari');
    console.log(
      `Hosted iPhone Safari check passed: the initial route avoided ${INITIAL_FORBIDDEN_CHUNKS.length} `
        + `deferred assets, and the ${pdf.byteLength}-byte plan rendered in ${viewerShownInMs}ms `
        + `(budget ${openBudgetMs}ms, ${latencyMs}ms request latency).`,
    );
  } finally {
    await browser.close();
  }
}

await main();