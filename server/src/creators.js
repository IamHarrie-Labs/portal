import crypto from 'node:crypto';
import { loadJson, saveJson } from './store.js';

// Multi-tenant creator accounts. Each creator gets their own diversified
// receiving address (new_address oz) carved from the SAME wallet seed as the
// main operator — no separate wallet process needed, since the persistent
// zingo-cli session already reports value_transfers across every address the
// seed controls (see watcher.js). Only the memo/purpose namespace decides
// which creator a payment belongs to.
const creators = new Map(Object.entries(loadJson('creators.json', {})));

function persist() {
  saveJson('creators.json', Object.fromEntries(creators));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return check.length === stored.length && crypto.timingSafeEqual(check, stored);
}

export function findByUsername(username) {
  const key = username.trim().toLowerCase();
  for (const c of creators.values()) {
    if (c.username.toLowerCase() === key) return c;
  }
  return null;
}

export function createCreator({ username, password, address }) {
  const id = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);
  const creator = {
    id,
    username: String(username).trim().slice(0, 40),
    passwordSalt: salt,
    passwordHash: hash,
    address,
    webhookUrl: null,
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    createdAt: Date.now(),
  };
  creators.set(id, creator);
  persist();
  return creator;
}

export function getCreator(id) {
  return creators.get(id) ?? null;
}

export function setWebhookUrl(id, url) {
  const c = creators.get(id);
  if (!c) return null;
  c.webhookUrl = url;
  persist();
  return c;
}

export function rotateWebhookSecret(id) {
  const c = creators.get(id);
  if (!c) return null;
  c.webhookSecret = crypto.randomBytes(24).toString('hex');
  persist();
  return c;
}

export function publicCreator(c) {
  return { id: c.id, username: c.username, address: c.address, webhookUrl: c.webhookUrl, createdAt: c.createdAt };
}
