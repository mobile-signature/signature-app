import crypto from 'node:crypto';
import { apiKey } from './config.js';

/**
 * License keys look like  MSIG-4K7QA-9WXHB-2NPRD-8TYFC
 *
 * They are self-validating: the last three groups are an HMAC of the first
 * group's serial, computed with the server secret. Checking a key means
 * recomputing that HMAC — no database lookup.
 *
 * That matters because Render's free tier wipes the disk on every restart. A
 * key list stored on disk would disappear and lock every customer out; signed
 * keys keep working. Revocation is the only thing that needs storage, and it
 * falls back to an environment variable so it survives restarts too.
 */

// Crockford base32: no I, L, O or U, so keys cannot be misread or misheard.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'MSIG';
const SERIAL_LEN = 5;
const MAC_LEN = 15;

function secret() {
  // A dedicated secret is better, but falling back to API_KEY means licensing
  // works out of the box without extra configuration.
  return process.env.LICENSE_SECRET || apiKey();
}

function toBase32(buf, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i % buf.length] % 32];
  return out;
}

function macFor(serial) {
  const digest = crypto.createHmac('sha256', secret()).update(`license:${serial}`).digest();
  return toBase32(digest, MAC_LEN);
}

function format(serial, mac) {
  const body = serial + mac;
  const groups = body.match(/.{1,5}/g) || [];
  return `${PREFIX}-${groups.join('-')}`;
}

/** Strips formatting and fixes characters people commonly mistype. */
export function normalize(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/^MSIG/, '')
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function generateLicense() {
  const serial = toBase32(crypto.randomBytes(SERIAL_LEN * 2), SERIAL_LEN);
  return { serial, key: format(serial, macFor(serial)) };
}

/**
 * @returns {{ valid: true, serial: string } | { valid: false, reason: string }}
 */
export function inspectLicense(input) {
  const body = normalize(input);
  if (body.length !== SERIAL_LEN + MAC_LEN) {
    return { valid: false, reason: 'That key is not the right length.' };
  }
  const serial = body.slice(0, SERIAL_LEN);
  const mac = body.slice(SERIAL_LEN);
  const expected = macFor(serial);
  // Both are fixed-length base32, so lengths always match here.
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { valid: false, reason: 'That key is not valid.' };
  }
  return { valid: true, serial };
}

/**
 * Revoked serials come from the environment first (survives a wiped disk) and
 * from the database second (editable at runtime).
 */
export function envRevoked() {
  return new Set(
    String(process.env.REVOKED_LICENSES || '')
      .split(/[,\s]+/)
      .map((s) => normalize(s).slice(0, SERIAL_LEN))
      .filter(Boolean),
  );
}

export const KEY_PREFIX = PREFIX;
export const SERIAL_LENGTH = SERIAL_LEN;
