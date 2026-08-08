/**
 * Where signed documents get saved.
 *
 * A web page cannot write to a path someone types in. The browser only ever
 * grants access to a folder the person picked themselves through the system's
 * own dialog, and hands back a handle rather than a path — which is also why
 * the full path can never be displayed back to them, only the folder's name.
 *
 * That handle survives in IndexedDB, so the folder is chosen once and still
 * known on the next visit. It is stored per licence key: two keys are two
 * different people, and one must not inherit the other's folder.
 *
 * Every failure here is answered the same way — return false and let the
 * caller fall back to the browser's ordinary download. A folder that has been
 * deleted, moved onto an offline drive, or had its permission withdrawn is a
 * normal thing to find, not an error worth interrupting anyone over.
 */

const DB_NAME = 'ms-destination';
const STORE = 'handles';

const keyFor = (licence) => licence || 'default';

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

/** Chrome and Edge on a desktop. Firefox, Safari and every phone lack this. */
export function destinationSupported() {
  return typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
}

export async function loadDestination(licence) {
  if (!destinationSupported()) return null;
  try {
    return (await run('readonly', (s) => s.get(keyFor(licence)))) || null;
  } catch {
    return null;
  }
}

export async function clearDestination(licence) {
  try {
    await run('readwrite', (s) => s.delete(keyFor(licence)));
  } catch { /* nothing stored, or storage unavailable — already the default */ }
}

/**
 * Opens the system folder picker. Only ever called straight from a click:
 * the browser refuses to open it otherwise.
 */
export async function chooseDestination(licence) {
  const handle = await window.showDirectoryPicker({ id: 'ms-signed', mode: 'readwrite' });
  if (!(await ensurePermission(handle, { allowPrompt: true }))) {
    throw new Error('Permission to write to that folder was not granted.');
  }
  await run('readwrite', (s) => s.put(handle, keyFor(licence)));
  return handle;
}

export async function ensurePermission(handle, { allowPrompt = false } = {}) {
  if (!handle) return false;
  try {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!allowPrompt) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    // requestPermission throws when there is no user gesture behind it, which
    // is exactly the case during an automatic save.
    return false;
  }
}

/**
 * Never overwrites: a signed document that landed here earlier is somebody's
 * only copy. Matches what a browser does on its own, appending (1), (2)...
 */
async function freeName(dir, filename) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';

  let name = filename;
  for (let n = 1; n < 100; n += 1) {
    try {
      await dir.getFileHandle(name);
    } catch {
      return name; // nothing there under that name
    }
    name = `${stem} (${n})${ext}`;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * @returns {Promise<boolean>} true only if the file is written and closed.
 *   false means the caller should download the ordinary way instead.
 */
export async function saveToDestination(handle, blob, filename) {
  if (!handle) return false;
  try {
    if (!(await ensurePermission(handle, { allowPrompt: true }))) return false;
    const target = await handle.getFileHandle(await freeName(handle, filename), { create: true });
    const writable = await target.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}
