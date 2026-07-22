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

export function getDocumentById(id) {
  return db.documents.find((d) => d.id === id) || null;
}

export function getDocumentByToken(token) {
  return db.documents.find((d) => d.token === token) || null;
}

export function listDocuments() {
  return [...db.documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateDocument(id, patch) {
  const doc = getDocumentById(id);
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
