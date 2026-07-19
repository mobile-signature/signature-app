import crypto from 'node:crypto';

// Short-lived capability tokens handed to a recipient once they have unlocked a
// document. They keep the access code out of URLs and query strings.

const TTL_MS = 30 * 60 * 1000;
const tickets = new Map(); // ticket -> { documentId, expiresAt }

export function issueTicket(documentId) {
  const ticket = crypto.randomBytes(18).toString('base64url');
  tickets.set(ticket, { documentId, expiresAt: Date.now() + TTL_MS });
  return ticket;
}

export function redeemTicket(ticket, documentId) {
  const entry = tickets.get(ticket);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    tickets.delete(ticket);
    return false;
  }
  return entry.documentId === documentId;
}

export function revokeTicketsFor(documentId) {
  for (const [ticket, entry] of tickets) {
    if (entry.documentId === documentId) tickets.delete(ticket);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt < now) tickets.delete(ticket);
  }
}, 5 * 60 * 1000).unref();
