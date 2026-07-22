import crypto from 'node:crypto';
import { apiKey } from './config.js';

/**
 * A short password in front of the actions that undo things — Licences and
 * Deactivate — so someone borrowing an activated device cannot wander into
 * them.
 *
 * Checked on the server, never shipped to the browser. A client-side check
 * would be readable by anyone who opened the page source, which for a
 * password reused elsewhere is worse than having no gate at all.
 *
 * Set STAFF_PASSWORD in the environment to change it.
 */

export const GATE_COOKIE = 'ms_gate';
const TTL_MINUTES = 15;

function expected() {
  return process.env.STAFF_PASSWORD || 'kingqueen';
}

function sign(payload) {
  return crypto
    .createHmac('sha256', process.env.LICENSE_SECRET || apiKey())
    .update(`gate:${payload}`)
    .digest('base64url');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkPassword(supplied) {
  return timingSafeEqual(String(supplied || ''), expected());
}

export function issueGateToken() {
  const exp = Date.now() + TTL_MINUTES * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyGateToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, mac] = token.split('.', 2);
  const want = sign(payload);
  if (mac.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

export function setGateCookie(req, res) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const bits = [
    `${GATE_COOKIE}=${issueGateToken()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TTL_MINUTES * 60}`,
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}
