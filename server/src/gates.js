import { loadJson, saveJson } from './store.js';

// Configurable multi-tier Gates, owned by a creator. Distinct from the
// built-in single-operator `login` / `gate:vip` gates in index.js (kept for
// backward compatibility with the existing demo) — these are namespaced
// `cgate:<creatorId>:<key>` so the watcher can route a detected payment back
// to the right creator (and fire their webhook) without touching the
// single-operator gates at all.
const store = loadJson('gates.json', {}); // { [creatorId]: { [key]: { amount, label, requireConfirmation } } }

function persist() {
  saveJson('gates.json', store);
}

const KEY_RE = /^[a-z0-9-]{1,40}$/;

export function listGates(creatorId) {
  return store[creatorId] ?? {};
}

export function getGate(creatorId, key) {
  return store[creatorId]?.[key] ?? null;
}

export function upsertGate(creatorId, key, { amount, label, requireConfirmation }) {
  if (!KEY_RE.test(key)) {
    throw new Error('gate key must be 1-40 lowercase letters, numbers, or hyphens');
  }
  if (!(Number(amount) > 0)) {
    throw new Error('amount must be a positive ZEC value');
  }
  store[creatorId] ??= {};
  store[creatorId][key] = {
    amount: String(amount),
    label: label && String(label).trim() ? String(label).trim().slice(0, 80) : key,
    requireConfirmation: !!requireConfirmation,
  };
  persist();
  return store[creatorId][key];
}

export function deleteGate(creatorId, key) {
  if (store[creatorId]) {
    delete store[creatorId][key];
    persist();
  }
}
