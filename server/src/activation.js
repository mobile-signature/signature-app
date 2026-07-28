import crypto from 'node:crypto';
import { apiKey } from './config.js';

/**
 * A device activates once with a license key and receives a signed cookie that
 * lasts a year. The license key itself is never stored in the browser.
 *
 * Why a cookie rather than localStorage:
 *  - httpOnly means page scripts cannot read it, so an XSS bug cannot steal it
 *  - Safari's tracking prevention clears localStorage after ~7 days of non-use,
 *    which would log people out of an app they had "installed"
 *  - it travels automatically, so no request has to carry the key
 *
 * The cookie carries the licence serial, so revoking a licence takes effect on
 * the next request without needing to track individual devices.
 */

export const COOKIE_NAME = 'ms_activation';
const MAX_AGE_DAYS = 365;

function secret() {
  return process.env.LICENSE_SECRET || apiKey();
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueToken({ serial, admin = false, wsExp = null }) {
  // The device session never outlives its workspace: if the licence expires
  // in 6 hours, so does this cookie. wsExp is kept alongside it so an expired
  // workspace can be reported as such, rather than as a generic "not
  // activated" that would send the user hunting for a key that still works.
  let exp = Date.now() + MAX_AGE_DAYS * 24 * 3600 * 1000;
  if (wsExp) exp = Math.min(exp, new Date(wsExp).getTime());
  const payload = Buffer.from(JSON.stringify({ serial, admin, exp, wsExp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** @returns {{ serial: string, admin: boolean } | null} */
export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.', 2);
  const expected = sign(payload);
  // timingSafeEqual throws on a length mismatch, so check that first.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return {
      serial: String(data.serial || ''),
      admin: Boolean(data.admin),
      wsExp: data.wsExp || null,
    };
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function setActivationCookie(req, res, payload) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  let maxAge = MAX_AGE_DAYS * 24 * 3600;
  if (payload.wsExp) {
    const remaining = Math.floor((new Date(payload.wsExp).getTime() - Date.now()) / 1000);
    maxAge = Math.max(0, Math.min(maxAge, remaining));
  }
  const bits = [
    `${COOKIE_NAME}=${issueToken(payload)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export function clearActivationCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Best-effort device label for the activation log. Not used for security. */
export function describeDevice(req) {
  const ua = req.get('user-agent') || '';
  const platform =
    /iPhone|iPad/i.test(ua) ? 'iPhone/iPad'
      : /Android/i.test(ua) ? 'Android'
        : /Macintosh/i.test(ua) ? 'Mac'
          : /Windows/i.test(ua) ? 'Windows'
            : 'Unknown device';
  const browser =
    /Edg\//i.test(ua) ? 'Edge'
      : /Chrome\//i.test(ua) ? 'Chrome'
        : /Safari\//i.test(ua) ? 'Safari'
          : /Firefox\//i.test(ua) ? 'Firefox'
            : 'browser';
  return `${platform} · ${browser}`;
}
