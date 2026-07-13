import crypto from 'node:crypto';
import { loadJson, saveJson } from './store.js';

// Challenge codes are short, human-checkable, and collision-safe for the
// active window. Format: PT-XXXXXX (base32, no ambiguous chars).
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

const active = new Map(); // id -> challenge

function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `PT-${out}`;
}

export function createChallenge({ purpose = 'login', minAmountZats = 0, forcedCode = null, requireConfirmation = false } = {}) {
  const id = crypto.randomUUID();
  const code = forcedCode ?? randomCode(); // forcedCode is debug-only (see index.js)
  const challenge = {
    id,
    code,
    purpose,
    minAmountZats, // 0 for plain login; >0 for a Gate that must be paid to unlock
    // High-value Gates can require a mined confirmation instead of accepting
    // the payment the moment it's seen in the mempool (see watcher.js).
    requireConfirmation,
    status: 'pending', // pending -> detected -> confirmed | underpaid | expired
    createdAt: Date.now(),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    txid: null,
    receivedZats: null,
    replyTo: null, // optional reply-to address from memo = persistent pseudonymous identity
  };
  active.set(id, challenge);
  return challenge;
}

export function getChallenge(id) {
  const c = active.get(id);
  if (!c) return null;
  if (c.status === 'pending' && Date.now() > c.expiresAt) c.status = 'expired';
  return c;
}

// The Shielded Wall: any text in a login memo beyond the challenge code is a
// public post, written to us via a mainnet shielded transaction. Persisted to
// disk so a server restart doesn't erase it.
const wall = loadJson('wall.json', []);

// A "reply-to" on Zcash is not a protocol field — it's a convention where the
// sending wallet appends its own shielded address into the memo text (Ywallet
// calls it "include reply address"; a user can also just type their address
// after the code in any wallet). zingolib's value_transfers output has no
// reply_to field, so the ONLY place a sender identity can come from is the
// memo text itself. Matches unified (u1...) and Sapling (zs1...) addresses.
const REPLY_ADDR_RE = /\b(?:u1|zs1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{30,}\b/i;

export function extractReplyAddress(memoText) {
  const m = String(memoText ?? '').match(REPLY_ADDR_RE);
  return m ? m[0] : null;
}

/** Match an incoming memo against active challenges. Returns the challenge if matched. */
export function matchMemo(memoText, { txid, replyTo = null, valueZats = 0 } = {}) {
  if (!memoText) return null;
  for (const c of active.values()) {
    if (c.status !== 'pending' || Date.now() > c.expiresAt) continue;
    if (memoText.includes(c.code)) {
      c.txid = txid ?? null;
      c.replyTo = replyTo ?? extractReplyAddress(memoText);
      c.receivedZats = valueZats;
      if (valueZats < c.minAmountZats) {
        // Code is spent either way — a Gate can't be unlocked twice with the
        // same underpaid proof, so the user must request a fresh challenge.
        c.status = 'underpaid';
        return c;
      }
      c.status = 'detected';
      if (c.purpose === 'login') {
        // Strip the code AND any reply address before publishing — the whole
        // point of the Wall is that posts are anonymous.
        const message = memoText.replace(c.code, '').replace(REPLY_ADDR_RE, '').replace(/^[\s:—-]+|[\s]+$/g, '');
        if (message) {
          wall.unshift({ message: message.slice(0, 280), txid, at: Date.now() });
          if (wall.length > 200) wall.pop();
          saveJson('wall.json', wall);
        }
      }
      return c;
    }
  }
  return null;
}

export function wallPosts() {
  return wall;
}

export function sweepExpired() {
  const now = Date.now();
  for (const [id, c] of active) {
    // keep detected/confirmed challenges around briefly so clients can fetch tokens
    if (now > c.expiresAt + CHALLENGE_TTL_MS) active.delete(id);
  }
}
