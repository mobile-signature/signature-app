import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { PORT, PUBLIC_URL, WEB_DIR, apiKey } from './config.js';
import { router as api } from './routes/documents.js';
import * as db from './db.js';

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

app.get('/s/:token', (req, res) => {
  const doc = db.getDocumentByToken(req.params.token);

  // An unknown or dead link gets the neutral wording: the preview should not
  // confirm whether a token is real.
  const title = doc && doc.status !== 'revoked' ? doc.title : 'Sign document';
  const signer = doc?.signerName ? `for ${doc.signerName}` : '';
  const description = doc
    ? `Tap to review and sign ${signer}. Opens in your browser — nothing to install.`.replace(/\s+/g, ' ')
    : 'Secure document signing.';

  const meta = [
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(`${PUBLIC_URL}/s/${req.params.token}`)}" />`,
    `<meta property="og:image" content="${escapeAttr(`${PUBLIC_URL}/icon-512.png`)}" />`,
    `<meta property="og:site_name" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
  ].join('\n  ');

  const html = SIGN_TEMPLATE
    .replace('<title>Sign document</title>', `<title>${escapeAttr(title)}</title>\n  ${meta}`);

  res.type('html');
  res.setHeader('Cache-Control', 'no-store');
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

app.listen(PORT, () => {
  console.log(`\n  Mobile Signature running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Public:  ${PUBLIC_URL}`);
  console.log(`  API key: ${apiKey()}\n`);
});
