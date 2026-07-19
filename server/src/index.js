import path from 'node:path';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { PORT, PUBLIC_URL, WEB_DIR, apiKey } from './config.js';
import { router as api } from './routes/documents.js';

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

// Recipient signing page. The token stays in the path so the page can read it.
app.get('/s/:token', (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'sign.html'));
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
