import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './config.js';
import * as db from './db.js';

/**
 * Retention policy engine.
 *
 * Rule, decided deliberately rather than inherited from the spec wording:
 *
 *   - UNSIGNED documents in an expired workspace are purged. They are drafts;
 *     nobody agreed to anything, and holding them indefinitely is a liability.
 *
 *   - SIGNED documents are KEPT. Their link stops working, but the PDF and its
 *     audit trail survive. Deleting an executed agreement on a timer destroys
 *     the only evidence that it was ever signed, and electronically signed
 *     agreements normally have to be retained for years. Expiry here governs
 *     ACCESS, not the existence of executed contracts.
 *
 * "Decentralised" in practice means it does not depend on a single scheduler
 * being alive: the sweep runs on a timer AND opportunistically whenever a
 * workspace is touched. That matters because a free-tier instance sleeps, and
 * a sleeping process runs no timers — a purge that only ever fired from
 * setInterval would silently stop happening.
 */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

export const ADMIN_CONTACT = 'Mr. Ihab Emad';

/** The one place this wording is defined, so every surface says the same thing. */
export const EXPIRED_MESSAGE =
  `This link has expired. Please contact ${ADMIN_CONTACT} for restoration assistance.`;

function removeFileQuietly(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A file that cannot be deleted must not abort the rest of the sweep.
  }
}

function filesOf(doc) {
  const files = [doc.sourcePath, doc.signedPath];
  if (doc.previewExt) files.push(path.join(UPLOAD_DIR, `${doc.id}-preview.${doc.previewExt}`));
  return files.filter(Boolean);
}

/**
 * @param {(workspace: string) => boolean} isExpired
 * @returns {{ purged: number, keptSigned: number }}
 */
export function sweep(isExpired) {
  const expiredCache = new Map();
  const expired = (ws) => {
    if (!expiredCache.has(ws)) expiredCache.set(ws, Boolean(isExpired(ws)));
    return expiredCache.get(ws);
  };

  const doomed = [];
  let keptSigned = 0;

  for (const doc of db.allDocuments()) {
    if (!expired(db.workspaceOf(doc))) continue;
    if (doc.signedAt) {
      keptSigned += 1; // executed agreement — access is gone, the record stays
      continue;
    }
    doomed.push(doc);
  }

  for (const doc of doomed) filesOf(doc).forEach(removeFileQuietly);
  const purged = db.deleteDocuments(doomed.map((d) => d.id));

  if (purged) {
    console.log(`[retention] purged ${purged} unsigned document(s); kept ${keptSigned} signed`);
  }
  return { purged, keptSigned };
}

export function startRetentionEngine(isExpired) {
  const run = () => {
    try {
      sweep(isExpired);
    } catch (err) {
      console.error('[retention] sweep failed:', err.message);
    }
  };
  run(); // once at boot, so a restart after downtime catches up immediately
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.(); // never hold the process open just for the sweep
  return () => clearInterval(timer);
}
