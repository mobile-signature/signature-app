import fs from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Field coordinates arrive normalised (0..1) with a top-left origin, because
 * that is how the browser overlay measures them. pdf-lib draws from the
 * bottom-left, so every field gets flipped here — one conversion, one place.
 *
 * field = {
 *   type: 'signature' | 'pen' | 'text' | 'date',
 *   page: 0-based index,
 *   x, y, w, h: 0..1 relative to the page box,
 *   value: data URL (signature/pen) or string (text/date),
 * }
 *
 * 'pen' is freehand markup drawn directly on the page (highlighting a line,
 * circling a problem) rather than a signature — validated and stamped
 * identically to 'signature' (both are just a transparent PNG placed in a
 * box), but kept as a distinct type so the audit trail and the "a signature
 * is required" check never confuse markup with an actual signature.
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
    if (!['signature', 'pen', 'text', 'date'].includes(type)) {
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
    if (type === 'signature' || type === 'pen') {
      if (typeof f.value !== 'string' || !f.value.startsWith('data:image/png;base64,')) {
        throw new Error(`${where}: ${type} must be a PNG data URL`);
      }
      out.value = f.value;
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

    if (field.type === 'signature' || field.type === 'pen') {
      // Pen markup is a full-page-sized box (x=0,y=0,w=1,h=1), so this scale
      // is always ~1 for it — the transparent PNG lands pixel-for-pixel where
      // it was drawn. A tap-placed signature uses a small box instead, so the
      // same scale-to-fit math is what centres it there.
      const png = await pdf.embedPng(Buffer.from(field.value.split(',')[1], 'base64'));
      const scale = Math.min(w / png.width, h / png.height);
      const drawW = png.width * scale;
      const drawH = png.height * scale;
      page.drawImage(png, {
        x: x + (w - drawW) / 2,
        y: y + (h - drawH) / 2,
        width: drawW,
        height: drawH,
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
    `Consent given: "${toWinAnsi(audit.consentText) || 'n/a'}"`,
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
