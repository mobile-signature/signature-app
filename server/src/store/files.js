import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_DIR } from '../config.js';
import * as mongo from './mongo.js';

/**
 * The document bytes themselves — the other half of surviving a wiped disk.
 *
 * Moving only db.json to MongoDB would have produced a worse bug than the one
 * being fixed: every document would still be listed, and every single one
 * would fail to open, because the PDF it points at was on the disk that went
 * away. So the bytes are mirrored too.
 *
 * Local disk stays the primary read path. MongoDB is the backstop, consulted
 * only when a file is missing — which today is a dead end (410 "no longer
 * stored on the server") and after this is a transparent recovery. When the
 * file is present, which is nearly always, the behaviour and cost are exactly
 * what they were before.
 */

/** Files are keyed by bare name; the absolute path belongs to one machine. */
const keyOf = (filePath) => path.basename(filePath);

/**
 * Copies a freshly written file into MongoDB.
 *
 * `bytes` is optional and passed when the caller already has them in hand, so
 * writing a document does not read it straight back off the disk.
 */
export async function mirrorFile(filePath, bytes = null) {
  if (!mongo.mongoEnabled()) return;
  try {
    const data = bytes || (await fsp.readFile(filePath));
    await mongo.putFile(keyOf(filePath), data);
  } catch (err) {
    // A document that is on disk but not yet mirrored is still fully usable —
    // it just is not protected yet. Never fail the upload over this.
    console.error(`[files] mirroring ${keyOf(filePath)} failed: ${err.message}`);
  }
}

/**
 * Guarantees the file is on local disk if it exists anywhere, and answers with
 * the path to read, or null if it is genuinely gone.
 *
 * Callers previously wrote `fs.existsSync(file) ? ... : 410`. The null return
 * keeps that shape, so the "really missing" behaviour is unchanged.
 */
export async function ensureLocal(filePath) {
  if (!filePath) return null;
  if (fs.existsSync(filePath)) return filePath;
  if (!mongo.mongoEnabled()) return null;

  const name = keyOf(filePath);
  const bytes = await mongo.getFile(name);
  if (!bytes) return null;

  // Restored beside the other uploads rather than at the recorded absolute
  // path: that path was produced by whichever machine first stored the file,
  // and this may not be that machine.
  const restored = path.join(UPLOAD_DIR, name);
  try {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const tmp = `${restored}.restoring`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, restored); // never leave a half-written PDF in place
    console.log(`[files] restored ${name} from MongoDB`);
    return restored;
  } catch (err) {
    console.error(`[files] restoring ${name} failed: ${err.message}`);
    return null;
  }
}

/** Drops the durable copy too, so a purge is a real purge. */
export async function forgetFile(filePath) {
  if (!mongo.mongoEnabled() || !filePath) return;
  await mongo.deleteFile(keyOf(filePath));
}

/**
 * Protects documents that predate this feature.
 *
 * Their bytes are sitting on the local disk and nowhere else, so the very next
 * wipe would take them. Runs once at boot, after the records are loaded, and
 * deliberately does not block the server from accepting requests.
 */
export async function backfill(documents) {
  if (!mongo.mongoEnabled()) return { uploaded: 0 };
  let uploaded = 0;
  for (const doc of documents) {
    const candidates = [doc.sourcePath, doc.signedPath].filter(Boolean);
    if (doc.previewExt) {
      candidates.push(path.join(UPLOAD_DIR, `${doc.id}-preview.${doc.previewExt}`));
    }
    for (const file of candidates) {
      const name = keyOf(file);
      try {
        if (!fs.existsSync(file)) continue;      // nothing local to copy up
        if (await mongo.hasFile(name)) continue; // already protected
        await mongo.putFile(name, await fsp.readFile(file));
        uploaded += 1;
      } catch (err) {
        console.error(`[files] backfill of ${name} failed: ${err.message}`);
      }
    }
  }
  if (uploaded) console.log(`[files] backfilled ${uploaded} existing file(s) into MongoDB`);
  return { uploaded };
}
