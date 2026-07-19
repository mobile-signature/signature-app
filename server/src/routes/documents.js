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

function requireApiKey(req, res, next) {
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!provided || !timingSafeEqual(provided, apiKey())) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

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

    const id = nanoid(12);
    const stored = path.join(UPLOAD_DIR, `${id}.pdf`);

    // Decide from the bytes, not the filename or the browser's Content-Type.
    const raw = await fsp.readFile(req.file.path);
    const kind = sniffImageType(raw);
    await fsp.unlink(req.file.path).catch(() => {});

    let sourceKind;
    try {
      if (kind === 'application/pdf') {
        sourceKind = 'pdf';
        await fsp.writeFile(stored, raw);
      } else if (kind === 'image/jpeg' || kind === 'image/png') {
        // Photos and screenshots are wrapped into a one-page PDF so the rest of
        // the pipeline never has to care which one it started as.
        sourceKind = 'image';
        await fsp.writeFile(stored, await imageToPdf(raw));
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
      token: nanoid(32),
      title: String(req.body.title || req.file.originalname).slice(0, 200),
      signerName: String(req.body.signerName || '').slice(0, 120),
      signerEmail: String(req.body.signerEmail || '').slice(0, 200),
      accessCodeHash: accessCode ? hashCode(accessCode) : null,
      status: 'sent',
      pageCount,
      sourceKind,
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

router.get('/documents', requireApiKey, (_req, res) => {
  res.json(db.listDocuments().map(publicView));
});

router.get('/documents/:id', requireApiKey, (req, res) => {
  const doc = db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ ...publicView(doc), events: db.eventsFor(doc.id) });
});

router.get('/documents/:id/download', requireApiKey, (req, res) => {
  const doc = db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const file = doc.signedPath && fs.existsSync(doc.signedPath) ? doc.signedPath : doc.sourcePath;
  res.download(file, `${doc.title.replace(/[^\w.\- ]+/g, '_')}.pdf`);
});

router.post('/documents/:id/revoke', requireApiKey, (req, res) => {
  const doc = db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  db.updateDocument(doc.id, { status: 'revoked', expiresAt: new Date().toISOString() });
  revokeTicketsFor(doc.id);
  db.logEvent(doc.id, 'revoked');
  res.json(publicView(db.getDocumentById(doc.id)));
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

router.post('/sign/:token/open', (req, res) => {
  const doc = db.getDocumentByToken(req.params.token);
  if (!doc) return res.status(404).json({ error: 'This link is not valid.' });
  if (doc.status === 'revoked') return res.status(410).json({ error: 'This link has been revoked.' });
  if (isExpired(doc)) return res.status(410).json({ error: 'This link has expired.' });

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
    status: db.getDocumentById(doc.id).status,
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

router.post('/sign/:token/complete', async (req, res, next) => {
  try {
    const doc = db.getDocumentByToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'This link is not valid.' });
    if (doc.status === 'revoked' || isExpired(doc)) {
      return res.status(410).json({ error: 'This link is no longer active.' });
    }
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
