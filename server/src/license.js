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
const EXP_LEN = 4;   // expiry, as hours-since-epoch in base32
const MAC_LEN = 15;

// A key with no expiry segment predates workspace TTLs and never expires.
const LEGACY_BODY_LEN = SERIAL_LEN + MAC_LEN;            // 20
const BODY_LEN = SERIAL_LEN + EXP_LEN + MAC_LEN;         // 24
const NEVER = '0000';

/**
 * The expiry is carried INSIDE the key rather than in db.json, and is covered
 * by the same HMAC, so it cannot be edited by whoever holds the key.
 *
 * This is not a stylistic choice. Render's free tier wipes the disk on every
 * restart, and a wiped expiry record leaves only bad options: treat the
 * missing record as "never expires" and the TTL silently stops being
 * enforced, or treat it as "expired" and every customer is locked out after
 * an unrelated restart. Encoding it in the key removes the failure mode
 * entirely — the key is the source of truth, and it travels with the user.
 *
 * base32^4 = ~1.05M hours, which covers expiry dates out to roughly year 2089.
 */
function encodeHours(hours) {
  let n = Math.max(0, Math.min(hours, 32 ** EXP_LEN - 1));
  let out = '';
  for (let i = 0; i < EXP_LEN; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function decodeHours(text) {
  let n = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 32 + v;
  }
  return n;
}

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

// `exp` is part of the signed payload, so an expiry date cannot be edited
// without invalidating the key. Legacy (expiry-less) keys sign the serial
// alone, exactly as before, so every key already issued keeps working.
function macFor(serial, exp = null) {
  const payload = exp === null ? `license:${serial}` : `license:${serial}:${exp}`;
  const digest = crypto.createHmac('sha256', secret()).update(payload).digest();
  return toBase32(digest, MAC_LEN);
}

function format(body) {
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

/**
 * @param {number|null} ttlHours  null / 0 => never expires
 */
export function generateLicense(ttlHours = null) {
  const serial = toBase32(crypto.randomBytes(SERIAL_LEN * 2), SERIAL_LEN);
  const exp = ttlHours && ttlHours > 0
    ? encodeHours(Math.floor((Date.now() + ttlHours * 3600 * 1000) / 3600000))
    : NEVER;
  const body = serial + exp + macFor(serial, exp);
  return { serial, key: format(body), expiresAt: expiryOf(exp) };
}

function expiryOf(exp) {
  if (exp === NEVER) return null;
  const hours = decodeHours(exp);
  return hours === null ? null : new Date(hours * 3600000).toISOString();
}

/**
 * @returns {{ valid: true, serial, expiresAt: string|null, expired: boolean }
 *          | { valid: false, reason: string }}
 */
export function inspectLicense(input) {
  const body = normalize(input);

  // Legacy keys (no expiry segment) are still honoured and never expire.
  const legacy = body.length === LEGACY_BODY_LEN;
  if (!legacy && body.length !== BODY_LEN) {
    return { valid: false, reason: 'That key is not the right length.' };
  }

  const serial = body.slice(0, SERIAL_LEN);
  const exp = legacy ? null : body.slice(SERIAL_LEN, SERIAL_LEN + EXP_LEN);
  const mac = body.slice(legacy ? SERIAL_LEN : SERIAL_LEN + EXP_LEN);
  const expected = macFor(serial, exp);

  // Both are fixed-length base32, so lengths always match here.
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { valid: false, reason: 'That key is not valid.' };
  }

  const expiresAt = legacy ? null : expiryOf(exp);
  return {
    valid: true,
    serial,
    expiresAt,
    expired: Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now()),
  };
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
