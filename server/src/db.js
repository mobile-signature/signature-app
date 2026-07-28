import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Tiny synchronous JSON store. No native modules, so `npm install` never needs
// a C++ toolchain on Windows. Swap for Postgres/SQLite if you outgrow it.

const DB_FILE = path.join(DATA_DIR, 'db.json');

function emptyDb() {
  return { documents: [], events: [], licenses: [], revoked: [], activations: [] };
}

function load() {
  try {
    // Merge over the empty shape so a file written by an older version still
    // has every collection present.
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return emptyDb();
  }
}

let db = load();

function persist() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomic-ish: never leaves a half-written db.json
}

export function createDocument(doc) {
  db.documents.push(doc);
  persist();
  return doc;
}

/**
 * Every document belongs to exactly one workspace (a licence serial).
 * Documents created before workspaces existed have no field, and are treated
 * as the administrator's own — they were all created with the admin key.
 */
export const ADMIN_WORKSPACE = 'ADMIN';
export const workspaceOf = (doc) => doc.workspace || ADMIN_WORKSPACE;

/**
 * Isolation is enforced HERE rather than in each route. A route that forgets
 * to filter is the single most likely way to leak one tenant's documents to
 * another, so the scope is a required argument of the lookup itself: pass no
 * workspace and you get nothing back, rather than everything.
 */
export function getDocumentById(id, workspace) {
  const doc = db.documents.find((d) => d.id === id) || null;
  if (!doc) return null;
  if (!workspace) return null;
  return workspaceOf(doc) === workspace ? doc : null;
}

// Recipient path: the unguessable link token IS the capability, and a
// recipient has no workspace identity at all, so this is deliberately
// unscoped. Expiry/revocation are still checked by the caller.
export function getDocumentByToken(token) {
  return db.documents.find((d) => d.token === token) || null;
}

export function listDocuments(workspace) {
  if (!workspace) return [];
  return db.documents
    .filter((d) => workspaceOf(d) === workspace)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Unscoped, for internal use only (signing by token, retention sweeps) —
// never wired to a route that a workspace user can reach.
export function getDocumentByIdUnscoped(id) {
  return db.documents.find((d) => d.id === id) || null;
}

export function updateDocument(id, patch) {
  const doc = getDocumentByIdUnscoped(id);
  if (!doc) return null;
  Object.assign(doc, patch);
  persist();
  return doc;
}

export function logEvent(documentId, type, detail = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    documentId,
    type,
    detail,
    at: new Date().toISOString(),
  };
  db.events.push(event);
  persist();
  return event;
}

export function eventsFor(documentId) {
  return db.events.filter((e) => e.documentId === documentId);
}

/* ------------------------------------------------------------- licensing */

export function recordLicense(license) {
  if (!db.licenses.some((l) => l.serial === license.serial)) {
    db.licenses.push(license);
    persist();
  }
  return license;
}

export function listLicenses() {
  return [...db.licenses].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Expiry of a workspace, for the retention sweep only. Returns null when
 * unknown — an unknown workspace is deliberately treated as "not expired" so
 * a lost database can never trigger deletion of documents it knows nothing
 * about. Access control does not use this; it reads the signed key.
 */
export function workspaceExpiresAt(serial) {
  const lic = db.licenses.find((l) => l.serial === serial);
  return lic?.expiresAt || null;
}

/**
 * The stored licence record, or null if there is none.
 *
 * Callers need to tell "no record" apart from "record says never expires" —
 * workspaceExpiresAt() above collapses both to null, which is fine for the
 * retention sweep (both mean "do not purge") but not for access control,
 * where the two must lead to different decisions.
 */
export function licenseFor(serial) {
  return db.licenses.find((l) => l.serial === serial) || null;
}

/**
 * Overrides the expiry baked into the key. The key itself cannot be edited —
 * its expiry is covered by the HMAC — so a change is recorded here and takes
 * precedence, in exactly the way revocation already does.
 *
 * @param {string|null} expiresAt  ISO date, or null for "never expires"
 */
export function setLicenseExpiry(serial, expiresAt) {
  const lic = db.licenses.find((l) => l.serial === serial);
  if (!lic) return null;
  lic.expiresAt = expiresAt;
  lic.expiryUpdatedAt = new Date().toISOString();
  persist();
  return lic;
}

export function revokeSerial(serial, note = '') {
  if (!db.revoked.some((r) => r.serial === serial)) {
    db.revoked.push({ serial, note, at: new Date().toISOString() });
    persist();
  }
}

export function unrevokeSerial(serial) {
  const before = db.revoked.length;
  db.revoked = db.revoked.filter((r) => r.serial !== serial);
  if (db.revoked.length !== before) persist();
}

export function revokedSerials() {
  return new Set(db.revoked.map((r) => r.serial));
}

/** One row per device that has activated, so licence use is visible. */
export function recordActivation({ serial, device, ip }) {
  const existing = db.activations.find((a) => a.serial === serial && a.device === device);
  if (existing) {
    existing.lastSeen = new Date().toISOString();
    existing.count = (existing.count || 1) + 1;
  } else {
    db.activations.push({
      serial,
      device,
      ip,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      count: 1,
    });
  }
  persist();
}

export function activationsFor(serial) {
  return db.activations.filter((a) => a.serial === serial);
}

export function allActivations() {
  return [...db.activations].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

/* -------------------------------------------------------------- retention */

/** Unscoped snapshot, for retention sweeps only. */
export function allDocuments() {
  return [...db.documents];
}

/** Drops document records by id and returns how many were removed. */
export function deleteDocuments(ids) {
  const doomed = new Set(ids);
  if (doomed.size === 0) return 0;
  const before = db.documents.length;
  db.documents = db.documents.filter((d) => !doomed.has(d.id));
  // Their audit events go too — keeping an audit trail for a document that no
  // longer exists is just orphaned personal data.
  db.events = db.events.filter((e) => !doomed.has(e.documentId));
  const removed = before - db.documents.length;
  if (removed) persist();
  return removed;
}
