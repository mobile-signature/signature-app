import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { PORT, PUBLIC_URL, WEB_DIR, apiKey } from './config.js';
import { router as api } from './routes/documents.js';
import * as db from './db.js';
import { backfill } from './store/files.js';
import { startRetentionEngine } from './retention.js';

const app = express();

app.set('trust proxy', true); // correct req.ip behind ngrok / Render / nginx
app.use(cors());
app.use(express.json({ limit: '12mb' })); // signature PNGs travel as data URLs

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use('/api', api);

/**
 * Recipient signing page. The token stays in the path so the page can read it.
 *
 * The Open Graph tags are filled in per document, so a link pasted into
 * WhatsApp previews as "Rental agreement" rather than the page's generic title.
 * Chat apps fetch this page anonymously to build that preview, so only the
 * title is exposed here — never the document itself.
 */
const SIGN_TEMPLATE = fs.readFileSync(path.join(WEB_DIR, 'sign.html'), 'utf8');

function escapeAttr(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Status word for the link preview. Kept to one or two words: it sits on its
// own line under the title, and a long phrase there would just move the
// truncation problem down a line instead of solving anything.
function statusLabel(doc) {
  if (doc.status === 'signed') return 'Signed';
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) return 'Expired';
  return 'Pending signature';
}

app.get('/s/:token', (req, res) => {
  const doc = db.getDocumentByToken(req.params.token);

  // An unknown or dead link gets the neutral wording: the preview should not
  // confirm whether a token is real.
  const known = doc && doc.status !== 'revoked';
  const title = known ? doc.title : 'Sign document';
  const description = known ? statusLabel(doc) : undefined;

  // For a photo/screenshot document, show the actual page 1 as the preview
  // thumbnail — deliberately chosen despite the tradeoff: chat apps fetch this
  // unauthenticated, so anyone with the link sees this image before entering
  // any access code. Revocation is still checked (see /sign/:token/preview),
  // and a genuine PDF upload keeps the plain SAKA logo — real rendering of an
  // arbitrary PDF's first page is a separate, heavier piece of work.
  const hasRealPreview = known && doc.previewExt && doc.previewWidth && doc.previewHeight;
  // Ends in a real image extension on purpose: some chat apps skip an og:image
  // whose URL does not look like a file, no matter what Content-Type it serves.
  const image = hasRealPreview
    ? `${PUBLIC_URL}/api/sign/${req.params.token}/preview.${doc.previewExt}`
    : `${PUBLIC_URL}/saka-preview.png`;
  // Real content is worth showing at a readable size (a large banner); the
  // brand-only fallback stays a small square next to the title, as designed.
  const imageWidth = hasRealPreview ? doc.previewWidth : 400;
  const imageHeight = hasRealPreview ? doc.previewHeight : 400;
  const cardType = hasRealPreview ? 'summary_large_image' : 'summary';

  const meta = [
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    description ? `<meta property="og:description" content="${escapeAttr(description)}" />` : '',
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(`${PUBLIC_URL}/s/${req.params.token}`)}" />`,
    `<meta property="og:site_name" content="SAKA" />`,
    `<meta property="og:image" content="${escapeAttr(image)}" />`,
    // secure_url and type are what stricter parsers look for before they will
    // render a thumbnail at all; og:image alone is enough for some clients and
    // silently not enough for others.
    `<meta property="og:image:secure_url" content="${escapeAttr(image)}" />`,
    `<meta property="og:image:type" content="${hasRealPreview && doc.previewExt === 'jpg' ? 'image/jpeg' : 'image/png'}" />`,
    `<meta property="og:image:width" content="${imageWidth}" />`,
    `<meta property="og:image:height" content="${imageHeight}" />`,
    `<meta property="og:image:alt" content="SAKA" />`,
    `<meta name="twitter:card" content="${cardType}" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    description ? `<meta name="twitter:description" content="${escapeAttr(description)}" />` : '',
    `<meta name="twitter:image" content="${escapeAttr(image)}" />`,
  ].filter(Boolean).join('\n  ');

  const html = SIGN_TEMPLATE
    .replace('<title>Sign document</title>', `<title>${escapeAttr(title)}</title>\n  ${meta}`);

  res.type('html');
  // Chat apps keep their own preview cache, and a `no-store` response is one
  // they are entitled to refuse to store — which shows up as a link that
  // previews as nothing but the bare domain. A short public lifetime is enough
  // for them to hold onto the card while still bounding how long a stale title
  // or status (including one that has since been revoked) can be shown.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(html);
});

// Licence management. The page itself is public; every action behind it
// requires the administrator key.
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'admin.html'));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Renders a link as a scannable QR so a phone can pick it up without typing.
// Restricted to this server's own URLs — it is not a general QR service.
app.get('/api/qr', async (req, res, next) => {
  try {
    const text = String(req.query.text || '');
    if (!text || text.length > 512) return res.status(400).json({ error: 'Bad QR text' });
    if (!text.startsWith(PUBLIC_URL) && !text.startsWith('http://localhost')) {
      return res.status(400).json({ error: 'QR codes are limited to this server\'s links' });
    }
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-store');
    res.send(svg);
  } catch (err) {
    next(err);
  }
});

// The setup page shows the API key, so it is reachable only from the machine
// running the server. A request arriving through the public tunnel is not
// loopback and gets nothing — otherwise anyone with the link would own the key.
function localOnly(req, res, next) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isLoopback = ip === '127.0.0.1' || ip === '::1';
  // A tunnel client (cloudflared, localtunnel) runs on this same machine, so
  // its forwarded requests are ALSO loopback at the socket level. The
  // forwarding headers are what distinguish them from a genuine local browser.
  const forwarded = req.get('x-forwarded-for') || req.get('x-forwarded-host') ||
                    req.get('cf-connecting-ip') || req.get('x-real-ip');
  if (isLoopback && !forwarded) return next();
  res.status(403).type('text/plain')
    .send('The setup page is only available on the computer running the server.');
}

app.get('/setup', localOnly, (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'setup.html'));
});

app.get('/api/setup-info', localOnly, (_req, res) => {
  res.json({ publicUrl: PUBLIC_URL, apiKey: apiKey(), tunnelled: !PUBLIC_URL.includes('localhost') });
});

app.use(express.static(WEB_DIR, { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

// Durable state first, before anything is served and before the retention
// sweep below runs. Sweeping an unloaded database would see no documents, and
// answering a request from one would report that a document does not exist.
try {
  const state = await db.hydrate();
  console.log(`[boot] ${state.documents} document(s) loaded from ${state.source}`);
} catch (err) {
  console.error(`[boot] ${err.message}`);
  console.error('[boot] refusing to start on an empty database — retrying is safer than overwriting it.');
  process.exit(1);
}

// Documents that predate the durable store still exist only on this disk.
// Deliberately not awaited: protecting old files must not delay serving.
backfill(db.allDocuments()).catch((err) => console.error(`[boot] backfill failed: ${err.message}`));

// Purges unsigned documents belonging to workspaces whose time is up. Signed
// documents are deliberately retained — see retention.js.
startRetentionEngine((workspace) => {
  const expiresAt = db.workspaceExpiresAt(workspace);
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
});

app.listen(PORT, () => {
  console.log(`\n  Mobile Signature running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Public:  ${PUBLIC_URL}`);
  console.log(`  API key: ${apiKey()}\n`);
});
