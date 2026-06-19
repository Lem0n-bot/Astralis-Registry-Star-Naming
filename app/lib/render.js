/**
 * Chromium renderer: certificate HTML -> { pdf, png } Buffers. A single browser
 * is reused across invocations (warm-start friendly). Uses the local system
 * Chrome when PUPPETEER_EXECUTABLE_PATH is set, otherwise @sparticuz/chromium
 * for serverless Linux (Vercel).
 */
import puppeteer from 'puppeteer-core';
import { ENV } from './env.js';

// A4 portrait @96dpi; the certificate is authored at a 1:1.414 ratio.
export const CERT_W = 794;
export const CERT_H = Math.round(CERT_W * 1.414); // 1123

let _browserPromise = null;

async function launch() {
  if (ENV.PUPPETEER_EXECUTABLE_PATH) {
    return puppeteer.launch({
      executablePath: ENV.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
    });
  }
  const chromium = (await import('@sparticuz/chromium')).default;
  // The certificate only uses 2D <canvas> (no WebGL), so skip Chromium's GPU
  // graphics stack — meaningfully less memory + faster cold start on Vercel.
  try { chromium.setGraphicsMode = false; } catch {}
  const executablePath = await chromium.executablePath();
  try {
    return await puppeteer.launch({
      args: [...chromium.args, '--font-render-hinting=none'],
      executablePath,
      headless: chromium.headless,
    });
  } catch (e) {
    // Surface the real reason in the function logs (binary missing / OOM / etc.)
    console.error('[render] chromium launch failed:', e?.message, '| executablePath:', executablePath);
    throw e;
  }
}

function isConnected(b) {
  if (!b) return false;
  return typeof b.isConnected === 'function' ? b.isConnected() : !!b.connected;
}

async function getBrowser() {
  if (_browserPromise) {
    const b = await _browserPromise.catch(() => null);
    if (isConnected(b)) return b;
    _browserPromise = null;
  }
  _browserPromise = launch();
  return _browserPromise;
}

/** Render certificate HTML to a high-resolution PDF + PNG. */
export async function renderCertificate(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: CERT_W, height: CERT_H, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    // wait for web fonts + the in-page cert script to finish painting canvas/SVG
    await page.evaluate(async () => {
      try { await document.fonts.ready; } catch {}
    });
    await page.waitForFunction('window.__certReady === true', { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    const pdf = await page.pdf({
      width: `${CERT_W}px`,
      height: `${CERT_H}px`,
      printBackground: true,
      pageRanges: '1',
    });

    const stage = await page.$('#stage');
    const png = stage
      ? await stage.screenshot({ type: 'png' })
      : await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: CERT_W, height: CERT_H } });

    return { pdf: Buffer.from(pdf), png: Buffer.from(png) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Best-effort cleanup (tests / graceful shutdown). */
export async function closeBrowser() {
  if (!_browserPromise) return;
  const b = await _browserPromise.catch(() => null);
  _browserPromise = null;
  if (b) await b.close().catch(() => {});
}
