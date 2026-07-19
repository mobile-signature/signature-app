import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import 'dotenv/config';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

export const PORT = Number(process.env.PORT || 3000);

// Public origin used to build the signing links that get sent to recipients.
// Must be the HTTPS URL the recipient's phone can reach.
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Protects the sender-side API. Anyone with this key can upload and send docs.
export const API_KEY = process.env.API_KEY || '';

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
export const LINK_TTL_HOURS = Number(process.env.LINK_TTL_HOURS || 168); // 7 days

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!API_KEY) {
  // Generate one on first boot rather than shipping an insecure default.
  const keyFile = path.join(DATA_DIR, 'api-key.txt');
  let generated;
  try {
    generated = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    generated = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(keyFile, generated);
  }
  process.env.API_KEY = generated;
  console.log(`[config] No API_KEY set. Using generated key from ${keyFile}`);
}

export function apiKey() {
  return API_KEY || process.env.API_KEY;
}
