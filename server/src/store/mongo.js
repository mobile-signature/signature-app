import { MongoClient, GridFSBucket } from 'mongodb';

/**
 * Durable storage, for when the machine's own disk is not durable.
 *
 * Render's free tier gives every deploy — and every wake from sleep — a fresh
 * filesystem. Anything written to it can vanish without warning, which is why
 * documents were disappearing: both the record (db.json) and the PDF bytes
 * under data/uploads/ lived there and nowhere else.
 *
 * This module is the second copy. It is deliberately OPTIONAL: with no
 * MONGODB_URI set, every function here is an inert no-op and the app behaves
 * exactly as it did before this file existed — local development needs no
 * database, and the deployment keeps working untouched until the variable is
 * added. Nothing about how the app behaves changes when it is switched on;
 * the same data simply survives the disk being wiped.
 */

const URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'mobile_signature';

/** Records keyed by something already unique, so a re-save updates in place. */
const KEY_OF = {
  documents: (r) => r.id,
  events: (r) => r.id,
  licenses: (r) => r.serial,
  revoked: (r) => r.serial,
  activations: (r) => `${r.serial}::${r.device}`,
};

export const COLLECTIONS = Object.keys(KEY_OF);

export const mongoEnabled = () => Boolean(URI);

let client = null;
let database = null;
let bucket = null;

/**
 * True once the boot-time load has succeeded.
 *
 * Writing is gated on this. If the load failed we hold a blank slate in
 * memory, and saving that would overwrite good data in the database with
 * nothing — turning a temporary outage into permanent data loss. Better to
 * keep serving from whatever is on disk and write nothing at all.
 */
let readable = false;

export const mongoReady = () => readable;

export async function connect({ attempts = 3 } = {}) {
  if (!URI) return false;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      client = new MongoClient(URI, {
        serverSelectionTimeoutMS: 15_000,
        retryWrites: true,
      });
      await client.connect();
      database = client.db(DB_NAME);
      bucket = new GridFSBucket(database, { bucketName: 'files' });
      // Looked up by name on every restore, so it must not be a table scan.
      await database.collection('files.files').createIndex({ filename: 1 }).catch(() => {});
      console.log(`[mongo] connected to ${DB_NAME}`);
      return true;
    } catch (err) {
      console.error(`[mongo] connection attempt ${i}/${attempts} failed: ${err.message}`);
      await client?.close().catch(() => {});
      client = null;
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  return false;
}

/** Every collection, in the shape db.js keeps in memory. */
export async function loadAll() {
  const out = {};
  for (const name of COLLECTIONS) {
    const rows = await database.collection(name).find({}).toArray();
    // _id is this module's business, not the app's — strip it so the objects
    // handed back are byte-for-byte the shape the JSON file used to produce.
    out[name] = rows.map(({ _id, ...rest }) => rest);
  }
  readable = true;
  const counts = COLLECTIONS.map((c) => `${c}=${out[c].length}`).join(' ');
  console.log(`[mongo] loaded ${counts}`);
  return out;
}

// Saves run one at a time. Two overlapping bulk writes could otherwise
// interleave a delete from an older snapshot with an insert from a newer one.
let saveChain = Promise.resolve();
let pendingSnapshot = null;

/**
 * Rows deleted since the last flush, per collection.
 *
 * Removal used to be inferred rather than recorded: whatever was absent from
 * the in-memory snapshot got deleted. That reads correctly only while exactly
 * one process owns this database. Two instances each hold their own memory, so
 * each sees the other's records as absent, and every save wipes everything the
 * other one wrote — silent, total loss of documents and their audit trail,
 * from nothing more than both being briefly alive at once.
 *
 * Recording deletions makes removal follow something that actually happened.
 * It is also less work: no full-collection delete on every single save.
 *
 * CONSTRAINT for anything added later: removing rows from the in-memory state
 * in db.js is no longer enough to remove them here. Any new code path that
 * drops a record must call noteDeleted() with its ids, or the record will
 * linger in the database and come back at the next restart.
 */
const pendingDeletes = Object.fromEntries(COLLECTIONS.map((name) => [name, new Set()]));

/** Records rows to remove on the next flush. Ids are keys, per KEY_OF above. */
export function noteDeleted(name, ids) {
  if (!URI) return;
  const doomed = pendingDeletes[name];
  if (!doomed) throw new Error(`[mongo] noteDeleted called for unknown collection "${name}"`);
  for (const id of ids) doomed.add(String(id));
}

/**
 * Mirrors the in-memory state into MongoDB.
 *
 * Called after a change has already been applied in memory, so the caller
 * never waits on the network: a slow database makes saving slower, never the
 * request. Coalescing means a burst of changes costs one write, not one each.
 */
export function saveAll(snapshot) {
  if (!URI || !readable) return saveChain;
  pendingSnapshot = snapshot;
  saveChain = saveChain.then(async () => {
    const snap = pendingSnapshot;
    if (!snap) return;
    pendingSnapshot = null;
    try {
      for (const name of COLLECTIONS) {
        // Deletions first, so an id dropped and re-created within the same
        // window ends up present: the upsert below puts it back.
        const doomed = pendingDeletes[name];
        if (doomed.size) {
          const ids = [...doomed];
          doomed.clear();
          try {
            await database.collection(name).deleteMany({ _id: { $in: ids } });
          } catch (err) {
            // Put them back so the next save retries; dropping them here would
            // leave a purged record to be reloaded at the next restart.
            for (const id of ids) doomed.add(id);
            throw err;
          }
        }

        const rows = snap[name] || [];
        if (rows.length) {
          await database.collection(name).bulkWrite(
            rows.map((r) => ({
              replaceOne: {
                filter: { _id: String(KEY_OF[name](r)) },
                replacement: { _id: String(KEY_OF[name](r)), ...r },
                upsert: true,
              },
            })),
            { ordered: false },
          );
        }
      }
    } catch (err) {
      console.error(`[mongo] save failed: ${err.message}`);
    }
  });
  return saveChain;
}

/** Lets callers wait for queued writes — used by tests, not by requests. */
export const flush = () => saveChain;

/* ----------------------------------------------------------------- files */

/**
 * PDFs are up to 20MB (MAX_UPLOAD_BYTES), above the 16MB ceiling on a single
 * MongoDB document, so file bytes go through GridFS rather than a field.
 *
 * Files are addressed by bare filename ("abc123.pdf"), never by the absolute
 * path stored on the document record: that path is specific to the machine
 * that wrote it, and the whole point here is to survive losing that machine.
 */
export async function putFile(name, bytes) {
  if (!URI || !readable) return false;
  try {
    await deleteFile(name); // replace rather than accumulate revisions
    await new Promise((resolve, reject) => {
      const stream = bucket.openUploadStream(name);
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(bytes);
    });
    return true;
  } catch (err) {
    console.error(`[mongo] storing ${name} failed: ${err.message}`);
    return false;
  }
}

export async function getFile(name) {
  if (!URI || !readable) return null;
  try {
    const chunks = [];
    for await (const chunk of bucket.openDownloadStreamByName(name)) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch {
    return null; // genuinely absent, which every caller already handles
  }
}

export async function hasFile(name) {
  if (!URI || !readable) return false;
  try {
    return Boolean(await database.collection('files.files').findOne({ filename: name }));
  } catch {
    return false;
  }
}

export async function deleteFile(name) {
  if (!URI || !readable) return;
  try {
    const existing = await database.collection('files.files').find({ filename: name }).toArray();
    for (const f of existing) await bucket.delete(f._id).catch(() => {});
  } catch (err) {
    console.error(`[mongo] deleting ${name} failed: ${err.message}`);
  }
}

export async function close() {
  await client?.close().catch(() => {});
  client = null;
  readable = false;
}
