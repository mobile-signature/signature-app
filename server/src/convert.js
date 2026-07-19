import { PDFDocument } from 'pdf-lib';

/**
 * Photos and screenshots become a one-page PDF the moment they are uploaded.
 * Everything downstream — pdf.js rendering, field placement, stamping, the
 * audit footer — then works on images without knowing they were ever images.
 */

// A4 width in points. Portrait images match this width; landscape ones match
// A4's height as their width, so a screenshot never renders as a thin sliver.
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MAX_EDGE = 2000; // points; guards against absurdly large source images

export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

export function isImageType(mimetype) {
  return IMAGE_TYPES.has(mimetype);
}

/** Sniff the real format instead of trusting the client's Content-Type. */
export function sniffImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length >= 8 && pngMagic.every((b, i) => buffer[i] === b)) {
    return 'image/png';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

export async function imageToPdf(buffer) {
  const kind = sniffImageType(buffer);
  if (kind !== 'image/jpeg' && kind !== 'image/png') {
    throw new Error('That image format is not supported. Use JPEG or PNG.');
  }

  const pdf = await PDFDocument.create();
  const image = kind === 'image/jpeg' ? await pdf.embedJpg(buffer) : await pdf.embedPng(buffer);

  const { width: pxW, height: pxH } = image;
  if (!pxW || !pxH) throw new Error('That image appears to be empty or corrupt.');

  const landscape = pxW > pxH;
  let pageW = landscape ? A4_HEIGHT : A4_WIDTH;
  let pageH = (pageW * pxH) / pxW;

  if (pageH > MAX_EDGE) {
    pageH = MAX_EDGE;
    pageW = (pageH * pxW) / pxH;
  }

  const page = pdf.addPage([pageW, pageH]);
  page.drawImage(image, { x: 0, y: 0, width: pageW, height: pageH });

  return Buffer.from(await pdf.save());
}
