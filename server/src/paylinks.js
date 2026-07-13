import crypto from 'node:crypto';
import { loadJson, saveJson } from './store.js';

// A Paylink is a reusable payment request: a creator sets an amount + label
// once and gets a shareable URL. Anyone who opens it gets a fresh one-time
// Challenge (via challenges.js) for that amount, so many people can pay the
// same link (e.g. a tip jar), each independently detected.
//
// Persisted to disk so a server restart doesn't lose every link ever created.
const ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const links = new Map(Object.entries(loadJson('paylinks.json', {})));

function persist() {
  saveJson('paylinks.json', Object.fromEntries(links));
}

function randomSlug(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function createPaylink({ amount, label }) {
  const slug = randomSlug();
  const link = {
    slug,
    amount: String(amount),
    label: label && String(label).trim() ? String(label).trim().slice(0, 80) : 'Payment',
    createdAt: Date.now(),
    payments: [], // { txid, valueZats, at }
  };
  links.set(slug, link);
  persist();
  return link;
}

export function getPaylink(slug) {
  return links.get(slug) ?? null;
}

export function recordPayment(slug, { txid, valueZats, at = Date.now() }) {
  const link = links.get(slug);
  if (!link) return;
  link.payments.push({ txid, valueZats, at });
  persist();
}
