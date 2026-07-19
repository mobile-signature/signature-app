import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Tiny synchronous JSON store. No native modules, so `npm install` never needs
// a C++ toolchain on Windows. Swap for Postgres/SQLite if you outgrow it.

const DB_FILE = path.join(DATA_DIR, 'db.json');

function emptyDb() {
  return { documents: [], events: [] };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
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
