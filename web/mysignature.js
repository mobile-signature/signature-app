/**
 * The sender's own saved signature image, so it can be reused when placing a
 * signature on a document instead of drawing one by hand every time.
 *
 * Kept in IndexedDB, never sent to the server: it only needs to exist on this
 * device, the same reasoning `destination.js` uses for the download folder.
 *
 * A single fixed slot, not one per licence key: sign.js (the page that places
 * it) is opened straight from a signing link and has no licence key of its
 * own to look one up by — only whatever this browser already has saved.
 * Saving a new image always replaces whatever was there before.
 */

const DB_NAME = 'ms-my-signature';
const STORE = 'signature';
const KEY = 'default';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

/** @returns {Promise<{dataUrl: string, w: number, h: number} | null>} */
export async function loadSavedSignature() {
  try {
    return (await run('readonly', (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

export async function saveSavedSignature(dataUrl, w, h) {
  await run('readwrite', (s) => s.put({ dataUrl, w, h }, KEY));
}

export async function clearSavedSignature() {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch { /* nothing stored, or storage unavailable — already the default */ }
}
