import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { getCreator } from './creators.js';

const MAX_ATTEMPTS = 3;
const MAX_LOG_PER_CREATOR = 20;
const deliveryLog = new Map(); // creatorId -> [{ event, status, at }], newest first

function recordDelivery(creatorId, event, status) {
  const log = deliveryLog.get(creatorId) ?? [];
  log.unshift({ event, status, at: Date.now() });
  if (log.length > MAX_LOG_PER_CREATOR) log.length = MAX_LOG_PER_CREATOR;
  deliveryLog.set(creatorId, log);
}

export function getDeliveries(creatorId) {
  return deliveryLog.get(creatorId) ?? [];
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function isPrivateOrLoopback(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (/^fe[89ab]/.test(lower)) return true; // link-local
  return false;
}

// A creator's webhook URL is theirs to point wherever they like — but this
// server is multi-tenant, so a malicious creator registering a webhook that
// targets our own internal network (localhost, cloud metadata IPs, etc.)
// would turn the server into an SSRF proxy against itself. Reject those.
export async function isSafeWebhookUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  let addresses;
  try {
    addresses = await dns.lookup(u.hostname, { all: true });
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.every(({ address }) => !isPrivateOrLoopback(address));
}

async function attempt(url, body, secret) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portal-signature': sign(secret, body) },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

// Fire-and-forget with capped retries and backoff. Never throws into the
// caller — a slow or dead creator endpoint must not stall payment detection
// for everyone else on the shared watcher loop.
export function fireWebhook(creatorId, event) {
  if (!creatorId) return;
  const creator = getCreator(creatorId);
  if (!creator?.webhookUrl) return;
  const body = JSON.stringify({ event: event.type, creatorId, at: Date.now(), data: event.data });
  (async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        await attempt(creator.webhookUrl, body, creator.webhookSecret);
        recordDelivery(creatorId, event.type, 'delivered');
        return;
      } catch (err) {
        console.error(`[webhook] ${creatorId} attempt ${i + 1}/${MAX_ATTEMPTS} failed: ${err.message}`);
        if (i < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    console.error(`[webhook] ${creatorId} gave up after ${MAX_ATTEMPTS} attempts`);
    recordDelivery(creatorId, event.type, 'failed');
  })();
}
