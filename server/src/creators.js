import crypto from 'node:crypto';
import { loadJson, saveJson } from './store.js';

// Multi-tenant creator accounts, authenticated by wallet, not password.
// A creator "logs in" the same way anyone logs into Portal: send a zero-value
// shielded memo with a one-time code (purpose `creator-login`, see index.js).
// The wallet's reply-to address, hashed, is the account key — the same
// mechanism the end-user pseudonymous Login subject already uses, just
// promoted from a one-off session identity into a persistent account lookup.
// First login from a given wallet auto-creates the account (and mints it a
// diversified receiving address); every later login from the same wallet
// resolves back to the same account. No usernames, no passwords, no signup
// form — proving control of the wallet *is* the account.
const creators = new Map(Object.entries(loadJson('creators.json', {})));
const byIdentityHash = new Map([...creators.values()].map((c) => [c.identityHash, c]));

function persist() {
  saveJson('creators.json', Object.fromEntries(creators));
}

export function findByIdentityHash(identityHash) {
  return byIdentityHash.get(identityHash) ?? null;
}

export function createCreator({ identityHash, address }) {
  const id = crypto.randomUUID();
  const creator = {
    id,
    identityHash,
    displayName: null,
    address,
    webhookUrl: null,
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    createdAt: Date.now(),
  };
  creators.set(id, creator);
  byIdentityHash.set(identityHash, creator);
  persist();
  return creator;
}

export function getCreator(id) {
  return creators.get(id) ?? null;
}

export function setDisplayName(id, name) {
  const c = creators.get(id);
  if (!c) return null;
  c.displayName = name;
  persist();
  return c;
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
  return {
    id: c.id,
    displayName: c.displayName,
    address: c.address,
    webhookUrl: c.webhookUrl,
    createdAt: c.createdAt,
  };
}
