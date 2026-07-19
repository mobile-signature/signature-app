import fs from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Field coordinates arrive normalised (0..1) with a top-left origin, because
 * that is how the browser overlay measures them. pdf-lib draws from the
 * bottom-left, so every field gets flipped here — one conversion, one place.
 *
 * field = {
 *   type: 'signature' | 'text' | 'date' | 'check',
 *   page: 0-based index,
 *   x, y, w, h: 0..1 relative to the page box,
 *   value: data URL (signature) or string (text/date),
 * }
 */

const MAX_FIELDS = 200;

// pdf-lib's standard fonts are WinAnsi-encoded, which covers Latin-1 plus a
// handful of typographic extras. Anything else (Arabic, Chinese, emoji, even a
// bare "✓") throws deep inside pdf-lib. Catch it here so the signer gets a clear
// message instead of a 500.
const WIN_ANSI_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

function isEncodable(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x20 && code <= 0x7e) return true;      // ASCII printable
  if (code >= 0xa0 && code <= 0xff) return true;      // Latin-1 supplement
  return WIN_ANSI_EXTRAS.includes(ch);
}

function unencodableChars(text) {
  return [...new Set([...text].filter((ch) => !isEncodable(ch)))].slice(0, 6);
}

// Used for the audit footer, where dropping a stray character beats failing the
// whole signature after the signer has already committed.
function toWinAnsi(text) {
  return [...String(text)].filter(isEncodable).join('');
}

export function validateFields(fields, pageCount) {
  if (!Array.isArray(fields)) throw new Error('fields must be an array');
  if (fields.length === 0) throw new Error('No fields were placed on the document');
  if (fields.length > MAX_FIELDS) throw new Error(`Too many fields (max ${MAX_FIELDS})`);

  return fields.map((f, i) => {
    const where = `field ${i + 1}`;
    const type = String(f.type || '');
    if (!['signature', 'text', 'date', 'check'].includes(type)) {
      throw new Error(`${where}: unknown type "${type}"`);
    }
    const page = Number(f.page);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
      throw new Error(`${where}: page ${f.page} is out of range`);
    }
    const num = (v, name) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < -0.5 || n > 1.5) {
        throw new Error(`${where}: ${name} out of range`);
      }
      return n;
    };
    const out = {
      type,
      page,
      x: num(f.x, 'x'),
      y: num(f.y, 'y'),
      w: num(f.w, 'w'),
      h: num(f.h, 'h'),
    };
    if (type === 'signature') {
      if (typeof f.value !== 'string' || !f.value.startsWith('data:image/png;base64,')) {
        throw new Error(`${where}: signature must be a PNG data URL`);
      }
      out.value = f.value;
    } else if (type === 'check') {
      out.value = null; // drawn as vector strokes, not text
    } else {
      const v = String(f.value ?? '').slice(0, 500);
      if (!v.trim()) throw new Error(`${where}: text is empty`);
      const bad = unencodableChars(v);
      if (bad.length) {
        throw new Error(
          `${where}: the character${bad.length > 1 ? 's' : ''} ${bad.join(' ')} cannot be written ` +
          `to this PDF. The built-in font covers Latin text only — see README, "Non-Latin text".`,
        );
      }
      out.value = v;
    }
    return out;
  });
}

export async function stampPdf({ sourcePath, outputPath, fields, audit }) {
  const bytes = await fs.readFile(sourcePath);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();

  const clean = validateFields(fields, pages.length);

  for (const field of clean) {
    const page = pages[field.page];
    const { width, height } = page.getSize();

    const x = field.x * width;
    const w = field.w * width;
    const h = field.h * height;
    // Flip the top-left origin to pdf-lib's bottom-left origin.
    const y = height - field.y * height - h;

    if (field.type === 'signature') {
      const png = await pdf.embedPng(Buffer.from(field.value.split(',')[1], 'base64'));
      // Preserve the drawn aspect ratio inside the placed box.
      const scale = Math.min(w / png.width, h / png.height);
      const drawW = png.width * scale;
      const drawH = png.height * scale;
      page.drawImage(png, {
        x: x + (w - drawW) / 2,
        y: y + (h - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    } else if (field.type === 'check') {
      // Two strokes rather than a "✓" glyph — the standard fonts cannot encode it.
      const ink = rgb(0.05, 0.05, 0.2);
      const thickness = Math.max(1.2, Math.min(w, h) * 0.16);
      page.drawLine({
        start: { x: x + w * 0.12, y: y + h * 0.5 },
        end: { x: x + w * 0.4, y: y + h * 0.18 },
        thickness,
        color: ink,
      });
      page.drawLine({
        start: { x: x + w * 0.4, y: y + h * 0.18 },
        end: { x: x + w * 0.9, y: y + h * 0.85 },
        thickness,
        color: ink,
      });
    } else {
      const size = Math.max(6, Math.min(h * 0.8, 36));
      page.drawText(field.value, {
        x,
        y: y + (h - size) / 2 + size * 0.15,
        size,
        font,
        color: rgb(0.05, 0.05, 0.2),
        maxWidth: w,
      });
    }
  }

  if (audit) {
    stampAuditFooter(pages[pages.length - 1], font, audit);
  }

  const out = await pdf.save({ useObjectStreams: false });
  await fs.writeFile(outputPath, out);
  return outputPath;
}

function stampAuditFooter(page, font, audit) {
  const { width } = page.getSize();
  const lines = [
    `Signed electronically on ${audit.signedAt}`,
    `Signer: ${toWinAnsi(audit.signerName) || 'n/a'}  |  IP: ${audit.ip || 'n/a'}`,
    `Document ID: ${audit.documentId}  |  Integrity hash: ${audit.hash}`,
  ];
  lines.forEach((line, i) => {
    page.drawText(line.slice(0, 140), {
      x: 24,
      y: 30 - i * 9,
      size: 6.5,
      font,
      color: rgb(0.45, 0.45, 0.5),
      maxWidth: width - 48,
    });
  });
}

export async function pageCountOf(filePath) {
  const pdf = await PDFDocument.load(await fs.readFile(filePath));
  return pdf.getPageCount();
}
