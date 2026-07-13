import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Flat-file persistence for the state that should survive a restart: Paylinks
// and Wall posts. In-flight Challenges are NOT persisted here — they're
// short-lived (10-30 min TTL) by design, and losing an in-progress one just
// means the user re-scans a fresh QR, which is a non-event.
const DATA_DIR = process.env.PORTAL_DATA_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(name, data) {
  try {
    // Write to a temp file then rename, so a crash mid-write can't corrupt
    // the existing file (atomic on the same filesystem).
    const target = path.join(DATA_DIR, name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error(`[store] failed to save ${name}: ${err.message}`);
  }
}
