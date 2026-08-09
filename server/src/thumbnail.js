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

// JPEG, not PNG. A chat app will only show the card it has already fetched by
// the time the message is sent, so every kilobyte here is time the preview
// might not get. Measured on a real page: 147KB as PNG against 73KB at this
// quality, for a difference invisible at the size a chat actually draws it.
const JPEG_QUALITY = 82;
const THUMB_EXT = 'jpg';

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

export async function renderFirstPageThumbnail(pdfBytes) {
  const canvas = await loadCanvas();
  if (!canvas) throw new Error('PDF thumbnail rendering is not available on this deployment.');

  return withTimeout(render(pdfBytes, canvas), RENDER_TIMEOUT_MS);
}

/**
 * Shrinks an uploaded photo or screenshot down to preview size.
 *
 * Without this the upload's own bytes stand in as the thumbnail, which can be
 * megabytes — the heaviest possible thing to put in front of a chat app that
 * gives up on fetching it after a moment.
 */
export async function renderImageThumbnail(imageBytes) {
  const canvas = await loadCanvas();
  if (!canvas) throw new Error('Image thumbnail rendering is not available on this deployment.');

  return withTimeout(shrink(imageBytes, canvas), RENDER_TIMEOUT_MS);
}

async function shrink(imageBytes, { createCanvas, loadImage }) {
  const img = await loadImage(Buffer.from(imageBytes));
  const scale = Math.min(1, MAX_WIDTH_PX / img.width);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency: anything see-through would come out black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  return {
    bytes: Buffer.from(await canvas.encode('jpeg', JPEG_QUALITY)),
    width,
    height,
    ext: THUMB_EXT,
  };
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
    // A PDF page renders onto transparency, and JPEG cannot carry that — the
    // page would arrive black. White first is what makes it look like paper.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const jpeg = await canvas.encode('jpeg', JPEG_QUALITY);
    return {
      bytes: Buffer.from(jpeg), width: canvas.width, height: canvas.height, ext: THUMB_EXT,
    };
  } finally {
    await doc.destroy();
  }
}
