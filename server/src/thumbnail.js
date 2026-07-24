import path from 'node:path';
import url from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Renders page 1 of a PDF to a PNG, for use as a link-preview thumbnail.
 *
 * This is deliberately best-effort. @napi-rs/canvas is a native binary; if it
 * fails to load on some future deploy target, or a given PDF is huge,
 * corrupt, or just slow, this must fail cleanly so the caller falls back to
 * the plain SAKA logo — never so this takes down the upload or the page
 * that displays it.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// fs.readFile(url) is called by pdfjs with this string concatenated to a font
// filename — it wants a real OS path, not a file:// URL, and pdfjs never
// converts it, so passing a URL here silently breaks every glyph.
const FONTS_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;

const MAX_WIDTH_PX = 1000; // plenty for a chat-app preview; keeps render cost bounded
const RENDER_TIMEOUT_MS = 10_000;

let canvasModule; // cached across calls; null means "checked, unavailable"

async function loadCanvas() {
  if (canvasModule !== undefined) return canvasModule;
  try {
    canvasModule = await import('@napi-rs/canvas');
  } catch {
    canvasModule = null; // e.g. the native binary has no build for this platform
  }
  return canvasModule;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Rendering timed out')), ms);
    }),
  ]);
}

export async function renderFirstPageToPng(pdfBytes) {
  const canvas = await loadCanvas();
  if (!canvas) throw new Error('PDF thumbnail rendering is not available on this deployment.');

  return withTimeout(render(pdfBytes, canvas), RENDER_TIMEOUT_MS);
}

async function render(pdfBytes, { createCanvas }) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    standardFontDataUrl: FONTS_DIR,
    isEvalSupported: false, // this is untrusted input; no reason to allow it to eval anything
  }).promise;

  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1, MAX_WIDTH_PX / base.width);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const png = await canvas.encode('png');
    return { bytes: Buffer.from(png), width: canvas.width, height: canvas.height };
  } finally {
    await doc.destroy();
  }
}
