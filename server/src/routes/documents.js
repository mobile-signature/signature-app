import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { UPLOAD_DIR, MAX_UPLOAD_BYTES, PUBLIC_URL, LINK_TTL_HOURS, apiKey } from '../config.js';
import * as db from '../db.js';
import { stampPdf, pageCountOf } from '../pdf.js';
import { imageToPdf, sniffImageType } from '../convert.js';
import { renderFirstPageToPng } from '../thumbnail.js';
import { generateLicense, inspectLicense, envRevoked, normalize, SERIAL_LENGTH } from '../license.js';
import {
  COOKIE_NAME, readCookie, readToken, setActivationCookie, clearActivationCookie, describeDevice,
} from '../activation.js';
import { GATE_COOKIE, checkPassword, setGateCookie, verifyGateToken } from '../gate.js';
import { EXPIRED_MESSAGE, sweep } from '../retention.js';
import { issueTicket, redeemTicket, revokeTicketsFor } from '../tickets.js';

export const router = express.Router();

const ACCEPTED = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    // The declared type is only a first pass; the bytes are sniffed after the
    // upload lands, and that is what actually decides how the file is handled.
    if (ACCEPTED.has(file.mimetype)) return cb(null, true);
    // A rejected upload is the user's mistake, not a server fault — tag it so
    // the error handler answers 400 instead of 500.
    const err = new Error('Upload a PDF, photo, or screenshot (PDF, JPEG or PNG)');
    err.status = 400;
    cb(err, false);
  },
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Is this licence still good? Checked on every request, not just at activation,
 * so revoking a licence takes effect immediately on every device using it.
 */
/**
 * A free-tier instance sleeps, and a sleeping process runs no timers — so the
 * hourly sweep alone would silently stop happening. Noticing an expired
 * workspace during a request is itself a reliable trigger, throttled so a
 * burst of requests cannot turn into a burst of full sweeps.
 */
const SWEEP_THROTTLE_MS = 5 * 60 * 1000;
let lastOpportunisticSweep = 0;

function sweepOpportunistically() {
  if (Date.now() - lastOpportunisticSweep < SWEEP_THROTTLE_MS) return;
  lastOpportunisticSweep = Date.now();
  try {
    sweep((ws) => {
      const exp = db.workspaceExpiresAt(ws);
      return Boolean(exp && new Date(exp).getTime() <= Date.now());
    });
  } catch (err) {
    console.error('[retention] opportunistic sweep failed:', err.message);
  }
}

function licenceStatus(serial, wsExp = null) {
  if (!serial) return { ok: false, reason: 'Activation is no longer valid.' };
  if (envRevoked().has(serial) || db.revokedSerials().has(serial)) {
    return { ok: false, reason: 'This licence has been revoked.' };
  }
  if (wsExp && new Date(wsExp).getTime() <= Date.now()) {
    sweepOpportunistically();
    return { ok: false, reason: EXPIRED_MESSAGE, expired: true };
  }
  return { ok: true };
}

/**
 * Establishes req.workspace — the tenant boundary every document route below
 * is scoped to. Nothing downstream may read a document without it.
 */
function requireActivation(req, res, next) {
  const token = readToken(readCookie(req, COOKIE_NAME) || '');
  if (token) {
    if (token.admin) {
      req.workspace = db.ADMIN_WORKSPACE;
      req.isAdmin = true;
      return next();
    }
    const status = licenceStatus(token.serial, token.wsExp);
    if (status.ok) {
      req.workspace = token.serial;
      req.isAdmin = false;
      return next();
    }
    clearActivationCookie(res);
    return res.status(401).json({
      error: status.reason,
      needsActivation: true,
      expired: Boolean(status.expired),
    });
  }

  // Scripts and integrations can still present the admin key directly.
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided && timingSafeEqual(provided, apiKey())) {
    req.workspace = db.ADMIN_WORKSPACE;
    req.isAdmin = true;
    return next();
  }

  res.status(401).json({ error: 'This device is not activated.', needsActivation: true });
}

// Kept as an alias so existing route definitions read unchanged.
const requireApiKey = requireActivation;

/* ------------------------------------------------------------ activation */

const activationAttempts = new Map(); // ip -> { count, resetAt }

function tooManyActivationAttempts(ip) {
  const now = Date.now();
  const rec = activationAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    activationAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
}

// Has this device already activated?
router.get('/activation', (req, res) => {
  const token = readToken(readCookie(req, COOKIE_NAME) || '');
  if (!token) return res.json({ activated: false });
  if (token.admin) return res.json({ activated: true, admin: true });

  const status = licenceStatus(token.serial, token.wsExp);
  if (!status.ok) {
    clearActivationCookie(res);
    return res.json({ activated: false, reason: status.reason, expired: Boolean(status.expired) });
  }
  res.json({
    activated: true,
    admin: false,
    licence: token.serial,
    workspaceExpiresAt: token.wsExp || null,
  });
});

// Activate this device with a licence key. Runs once per device.
router.post('/activation', (req, res) => {
  if (tooManyActivationAttempts(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const supplied = String(req.body?.licenseKey || '').trim();
  if (!supplied) return res.status(400).json({ error: 'Enter your licence key.' });

  // The admin key also activates, so the owner is never locked out.
  if (timingSafeEqual(supplied, apiKey())) {
    setActivationCookie(req, res, { serial: 'ADMIN', admin: true });
    db.recordActivation({ serial: 'ADMIN', device: describeDevice(req), ip: req.ip });
    return res.json({ ok: true, admin: true });
  }

  const inspected = inspectLicense(supplied);
  if (!inspected.valid) return res.status(401).json({ error: inspected.reason });

  // The expiry is carried inside the key itself, so a workspace whose time is
  // up cannot be re-activated even on a device that has never seen it before.
  const status = licenceStatus(inspected.serial, inspected.expiresAt);
  if (!status.ok) {
    return res.status(403).json({ error: status.reason, expired: Boolean(status.expired) });
  }

  setActivationCookie(req, res, {
    serial: inspected.serial,
    admin: false,
    wsExp: inspected.expiresAt,
  });
  db.recordActivation({ serial: inspected.serial, device: describeDevice(req), ip: req.ip });
  activationAttempts.delete(req.ip);
  res.json({ ok: true, licence: inspected.serial, workspaceExpiresAt: inspected.expiresAt });
});

// Deactivate this device. Behind the staff password so a borrowed device
// cannot be signed out by whoever is holding it.
router.delete('/activation', (req, res) => {
  if (!verifyGateToken(readCookie(req, GATE_COOKIE) || '')) {
    return res.status(403).json({ error: 'No permission.' });
  }
  clearActivationCookie(res);
  res.json({ ok: true });
});

/* ------------------------------------------------------- staff password */

const gateAttempts = new Map(); // ip -> { count, resetAt }

router.post('/gate', (req, res) => {
  const now = Date.now();
  const rec = gateAttempts.get(req.ip);
  if (rec && rec.resetAt > now && rec.count >= 8) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  if (!checkPassword(req.body?.password)) {
    const next = rec && rec.resetAt > now
      ? { count: rec.count + 1, resetAt: rec.resetAt }
      : { count: 1, resetAt: now + 10 * 60 * 1000 };
    gateAttempts.set(req.ip, next);
    return res.status(403).json({ error: 'No permission.' });
  }

  gateAttempts.delete(req.ip);
  setGateCookie(req, res);
  res.json({ ok: true });
});

/* ---------------------------------------------------------- admin: keys */

// Only the admin key manages licences — an activated device cannot mint more.
function requireAdmin(req, res, next) {
  // The staff password gates the door; the admin key still authorises the work.
  if (!verifyGateToken(readCookie(req, GATE_COOKIE) || '')) {
    return res.status(403).json({ error: 'No permission.' });
  }
  const token = readToken(readCookie(req, COOKIE_NAME) || '');
  if (token?.admin) return next();
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided && timingSafeEqual(provided, apiKey())) return next();
  res.status(403).json({ error: 'Administrator access required.' });
}

const MAX_TTL_HOURS = 24 * 3650; // ten years; anything longer is "never"

router.post('/licenses', requireAdmin, (req, res) => {
  // TTL arrives as a number plus a unit, so "3 days" and "72 hours" are both
  // expressible without the caller doing arithmetic.
  const unit = req.body?.ttlUnit === 'days' ? 'days' : 'hours';
  const rawTtl = Number(req.body?.ttl);
  let ttlHours = null;
  if (Number.isFinite(rawTtl) && rawTtl > 0) {
    ttlHours = Math.min(unit === 'days' ? rawTtl * 24 : rawTtl, MAX_TTL_HOURS);
  }

  const { serial, key, expiresAt } = generateLicense(ttlHours);
  const record = {
    serial,
    key,
    label: String(req.body?.label || '').slice(0, 80),
    createdAt: new Date().toISOString(),
    // Mirrored into the database purely so the retention sweep knows which
    // workspaces are past their time. Access control never reads this — it
    // reads the tamper-proof expiry inside the key — so if this record is
    // lost to a disk wipe the effect is that purging pauses, never that an
    // expired workspace silently regains access or that data is destroyed
    // early. The safe failure direction for each concern, separately.
    expiresAt: expiresAt || null,
  };
  db.recordLicense(record);
  res.status(201).json(record);
});

router.get('/licenses', requireAdmin, (_req, res) => {
  const revoked = new Set([...envRevoked(), ...db.revokedSerials()]);
  const now = Date.now();
  res.json(
    db.listLicenses().map((l) => ({
      ...l,
      revoked: revoked.has(l.serial),
      expired: Boolean(l.expiresAt && new Date(l.expiresAt).getTime() <= now),
      devices: db.activationsFor(l.serial).length,
      documents: db.listDocuments(l.serial).length,
    })),
  );
});

router.post('/licenses/:serial/revoke', requireAdmin, (req, res) => {
  const serial = normalize(req.params.serial).slice(0, SERIAL_LENGTH);
  db.revokeSerial(serial, String(req.body?.note || '').slice(0, 200));
  res.json({ ok: true, serial, revoked: true });
});

router.post('/licenses/:serial/restore', requireAdmin, (req, res) => {
  const serial = normalize(req.params.serial).slice(0, SERIAL_LENGTH);
  db.unrevokeSerial(serial);
  res.json({ ok: true, serial, revoked: envRevoked().has(serial) });
});

router.get('/activations', requireAdmin, (_req, res) => {
  res.json(db.allActivations());
});

function publicView(doc) {
  return {
    id: doc.id,
    title: doc.title,
    signerName: doc.signerName,
    signerEmail: doc.signerEmail,
    status: doc.status,
    pageCount: doc.pageCount,
    sourceKind: doc.sourceKind || 'pdf',
    hasAccessCode: Boolean(doc.accessCodeHash),
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    signedAt: doc.signedAt || null,
    signUrl: `${PUBLIC_URL}/s/${doc.token}`,
  };
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function isExpired(doc) {
  return new Date(doc.expiresAt).getTime() < Date.now();
}

/* ------------------------------------------------------------------ sender */

router.post('/documents', requireApiKey, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    // Checked here too, not only in the browser: a rule enforced only by the
    // page it ships with is advisory. Bail before any conversion work, and
    // clean up the upload multer already wrote to disk.
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'A title is required.' });
    }

    const id = nanoid(12);
    const stored = path.join(UPLOAD_DIR, `${id}.pdf`);

    // Decide from the bytes, not the filename or the browser's Content-Type.
    const raw = await fsp.readFile(req.file.path);
    const kind = sniffImageType(raw);
    await fsp.unlink(req.file.path).catch(() => {});

    let sourceKind;
    let previewExt = null;
    let previewWidth = null;
    let previewHeight = null;
    try {
      if (kind === 'application/pdf') {
        sourceKind = 'pdf';
        await fsp.writeFile(stored, raw);
        // Best-effort thumbnail of page 1, for the link-preview image. Never
        // lets a rendering problem fail the upload itself — worst case, the
        // document just keeps the plain SAKA logo, exactly like before this
        // existed.
        try {
          const rendered = await renderFirstPageToPng(raw);
          previewExt = 'png';
          previewWidth = rendered.width;
          previewHeight = rendered.height;
          await fsp.writeFile(path.join(UPLOAD_DIR, `${id}-preview.png`), rendered.bytes);
        } catch (err) {
          console.warn(`[preview] page-1 render skipped for ${id}: ${err.message}`);
        }
      } else if (kind === 'image/jpeg' || kind === 'image/png') {
        // Photos and screenshots are wrapped into a one-page PDF so the rest of
        // the pipeline never has to care which one it started as.
        sourceKind = 'image';
        const converted = await imageToPdf(raw);
        await fsp.writeFile(stored, converted.bytes);
        // The page inside that PDF is these exact bytes at full size with no
        // crop (imageToPdf sizes the page to the image's own aspect ratio), so
        // they double as a real link-preview thumbnail at zero extra cost —
        // no PDF rendering needed for this case.
        previewExt = kind === 'image/jpeg' ? 'jpg' : 'png';
        previewWidth = converted.width;
        previewHeight = converted.height;
        await fsp.writeFile(path.join(UPLOAD_DIR, `${id}-preview.${previewExt}`), raw);
      } else {
        return res.status(400).json({
          error: 'That file is not a PDF, JPEG or PNG. If it is a HEIC photo, ' +
                 'reopen it in the app and it will be converted automatically.',
        });
      }
    } catch (err) {
      await fsp.unlink(stored).catch(() => {});
      return res.status(400).json({ error: err.message || 'That file could not be read.' });
    }

    let pageCount;
    try {
      pageCount = await pageCountOf(stored);
    } catch {
      await fsp.unlink(stored).catch(() => {});
      return res.status(400).json({ error: 'That file could not be read as a document' });
    }

    const accessCode = String(req.body.accessCode || '').trim();
    const doc = db.createDocument({
      id,
      // Tenant stamp, taken from the activation cookie rather than anything
      // client-supplied — a caller cannot place a document into someone
      // else's workspace by editing a request.
      workspace: req.workspace,
      token: nanoid(32),
      title,
      signerName: String(req.body.signerName || '').slice(0, 120),
      signerEmail: String(req.body.signerEmail || '').slice(0, 200),
      accessCodeHash: accessCode ? hashCode(accessCode) : null,
      status: 'sent',
      pageCount,
      sourceKind,
      previewExt,
      previewWidth,
      previewHeight,
      sourcePath: stored,
      signedPath: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + LINK_TTL_HOURS * 3600 * 1000).toISOString(),
      signedAt: null,
    });

    db.logEvent(id, 'created', { pageCount, sourceKind });
    res.status(201).json(publicView(doc));
  } catch (err) {
    next(err);
  }
});

// Every read below is scoped to req.workspace. A document belonging to another
// workspace is reported as 404, not 403: "you may not see this" would still
// confirm that the id exists, which is itself a cross-tenant leak.
router.get('/documents', requireApiKey, (req, res) => {
  res.json(db.listDocuments(req.workspace).map(publicView));
});

router.get('/documents/:id', requireApiKey, (req, res) => {
  const doc = db.getDocumentById(req.params.id, req.workspace);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ ...publicView(doc), events: db.eventsFor(doc.id) });
});

router.get('/documents/:id/download', requireApiKey, (req, res) => {
  const doc = db.getDocumentById(req.params.id, req.workspace);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const file = doc.signedPath && fs.existsSync(doc.signedPath) ? doc.signedPath : doc.sourcePath;
  if (!fs.existsSync(file)) {
    return res.status(410).json({ error: 'That document is no longer stored on the server.' });
  }
  res.download(file, `${doc.title.replace(/[^\w.\- ]+/g, '_')}.pdf`);
});

router.post('/documents/:id/revoke', requireApiKey, (req, res) => {
  const doc = db.getDocumentById(req.params.id, req.workspace);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  db.updateDocument(doc.id, { status: 'revoked', expiresAt: new Date().toISOString() });
  revokeTicketsFor(doc.id);
  db.logEvent(doc.id, 'revoked');
  res.json(publicView(db.getDocumentById(doc.id, req.workspace)));
});

/* --------------------------------------------------------------- recipient */

const attempts = new Map(); // token -> { count, resetAt }

function tooManyAttempts(token) {
  const now = Date.now();
  const rec = attempts.get(token);
  if (!rec || rec.resetAt < now) {
    attempts.set(token, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 8;
}

/**
 * A document is unreachable once EITHER its own link TTL has run out or the
 * workspace that issued it has expired. Both cases give the signer the same
 * standardised message naming who to contact, rather than a dead end.
 */
function accessBlockReason(doc) {
  if (doc.status === 'revoked') return 'This link has been revoked.';
  if (isExpired(doc)) return EXPIRED_MESSAGE;
  const wsExp = db.workspaceExpiresAt(db.workspaceOf(doc));
  if (wsExp && new Date(wsExp).getTime() <= Date.now()) return EXPIRED_MESSAGE;
  return null;
}

router.post('/sign/:token/open', (req, res) => {
  const doc = db.getDocumentByToken(req.params.token);
  if (!doc) return res.status(404).json({ error: 'This link is not valid.' });
  const blocked = accessBlockReason(doc);
  if (blocked) return res.status(410).json({ error: blocked });

  if (doc.accessCodeHash) {
    if (tooManyAttempts(req.params.token)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const supplied = String(req.body?.code || '');
    if (!supplied) return res.status(401).json({ error: 'code_required' });
    if (!timingSafeEqual(hashCode(supplied), doc.accessCodeHash)) {
      db.logEvent(doc.id, 'bad_code');
      return res.status(401).json({ error: 'That code is not correct.' });
    }
    attempts.delete(req.params.token);
  }

  if (doc.status === 'sent') {
    db.updateDocument(doc.id, { status: 'opened' });
    db.logEvent(doc.id, 'opened', { ua: req.get('user-agent')?.slice(0, 180) });
  }

  res.json({
    ticket: issueTicket(doc.id),
    title: doc.title,
    signerName: doc.signerName,
    pageCount: doc.pageCount,
    // Unscoped by design: a recipient holds a link token, not a workspace
    // identity, so there is no tenant to scope this lookup to.
    status: db.getDocumentByIdUnscoped(doc.id).status,
    alreadySigned: Boolean(doc.signedAt),
  });
});

router.get('/sign/:token/file', (req, res) => {
  const doc = db.getDocumentByToken(req.params.token);
  if (!doc) return res.sendStatus(404);
  if (!redeemTicket(String(req.query.ticket || ''), doc.id)) {
    return res.status(401).json({ error: 'Session expired. Reopen the link.' });
  }
  const file = doc.signedPath && fs.existsSync(doc.signedPath) ? doc.signedPath : doc.sourcePath;
  // sendFile (not a raw pipe) so Content-Length and Accept-Ranges are set.
  // pdf.js issues range requests to stream large documents; without them it
  // stalls partway through rendering.
  res.sendFile(file, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
    },
  });
});

/**
 * The thumbnail shown in a chat app's link preview, for documents that
 * started life as a photo or screenshot. Deliberately unauthenticated — chat
 * apps fetch link previews with no ticket and no access code — but it still
 * respects revocation, matching the title-hiding rule on the /s/:token page:
 * a revoked or unknown link shows nothing about what it used to contain.
 */
router.get('/sign/:token/preview', (req, res) => {
  const doc = db.getDocumentByToken(req.params.token);
  if (!doc || doc.status === 'revoked' || !doc.previewExt) return res.sendStatus(404);

  const file = path.join(UPLOAD_DIR, `${doc.id}-preview.${doc.previewExt}`);
  if (!fs.existsSync(file)) return res.sendStatus(404);

  res.sendFile(file, {
    headers: {
      'Content-Type': doc.previewExt === 'png' ? 'image/png' : 'image/jpeg',
      // Long-lived: the thumbnail is fixed at upload time and never changes,
      // so there is no correctness reason to refetch it, only a privacy one —
      // and revocation is already checked above on every request.
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

router.post('/sign/:token/complete', async (req, res, next) => {
  try {
    const doc = db.getDocumentByToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'This link is not valid.' });
    const blocked = accessBlockReason(doc);
    if (blocked) return res.status(410).json({ error: blocked });
    if (doc.signedAt) return res.status(409).json({ error: 'This document was already signed.' });
    if (!redeemTicket(String(req.body?.ticket || ''), doc.id)) {
      return res.status(401).json({ error: 'Session expired. Reopen the link.' });
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'Consent to sign electronically is required.' });
    }

    const signerName = String(req.body?.signerName || doc.signerName || '').trim().slice(0, 120);
    if (!signerName) return res.status(400).json({ error: 'Please type your full name.' });

    const signedPath = path.join(UPLOAD_DIR, `${doc.id}-signed.pdf`);
    const signedAt = new Date().toISOString();
    const hash = crypto
      .createHash('sha256')
      .update(await fsp.readFile(doc.sourcePath))
      .digest('hex')
      .slice(0, 32);

    await stampPdf({
      sourcePath: doc.sourcePath,
      outputPath: signedPath,
      fields: req.body?.fields,
      audit: {
        signedAt,
        signerName,
        ip: req.ip,
        documentId: doc.id,
        hash,
      },
    });

    db.updateDocument(doc.id, { status: 'signed', signedPath, signedAt, signerName });
    db.logEvent(doc.id, 'signed', {
      signerName,
      ip: req.ip,
      ua: req.get('user-agent')?.slice(0, 180),
      fieldCount: Array.isArray(req.body?.fields) ? req.body.fields.length : 0,
      sourceHash: hash,
    });
    revokeTicketsFor(doc.id);

    res.json({ ok: true, signedAt });
  } catch (err) {
    if (/field|consent|PNG|array|range|empty/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});
