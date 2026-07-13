import express from 'express';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChallenge, getChallenge, sweepExpired, wallPosts } from './challenges.js';
import { startWatcher, selfSendMemo } from './watcher.js';
import { createPaylink, getPaylink } from './paylinks.js';
import { rateLimit } from './rateLimit.js';

const PORT = process.env.PORT ?? 8787;
// Falls back to a secret persisted on disk (not a random one per boot) so
// sessions survive a server restart even without PORTAL_JWT_SECRET set.
function loadOrCreateJwtSecret() {
  if (process.env.PORTAL_JWT_SECRET) return process.env.PORTAL_JWT_SECRET;
  const secretPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.jwt-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, 'utf8');
    return secret;
  }
}
const JWT_SECRET = loadOrCreateJwtSecret();
// The server's shielded receiving address (unified address). Set via env once the
// mainnet wallet is generated.
const RECEIVE_ADDRESS = process.env.PORTAL_ADDRESS;
// Zero-value shielded outputs with memos are explicitly valid on Zcash
// (ZIP-231). Login costs nothing beyond the unavoidable network fee, which
// goes to the network, not to Portal. Gates are different: paying is the
// point, so they carry a real minimum amount.
//
// Pricing is server-authoritative — a client picks a *purpose*, never an
// amount, so nobody can request the "vip" purpose while claiming it costs 0.
const LOGIN_AMOUNT = process.env.PORTAL_AMOUNT ?? '0';
// requireConfirmation: false accepts a payment the instant it's seen in the
// mempool (fast, the default). true waits for it to actually be mined before
// issuing a session — the right choice for a Gate expensive enough that a
// vanishingly rare mempool reorg would matter to you.
const GATES = {
  login: { amount: LOGIN_AMOUNT, label: 'Sign in', requireConfirmation: false },
  'gate:vip': {
    amount: process.env.PORTAL_GATE_VIP_AMOUNT ?? '0.05',
    label: 'VIP Alpha Access',
    requireConfirmation: process.env.PORTAL_GATE_VIP_REQUIRE_CONFIRMATION === '1',
  },
};

if (!RECEIVE_ADDRESS) {
  console.error('PORTAL_ADDRESS is not set. Generate the mainnet wallet and export its address.');
  process.exit(1);
}

const app = express();
app.use(express.json());
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Public, unauthenticated endpoints get a generous but real ceiling per IP.
const challengeRateLimit = rateLimit({ windowMs: 5 * 60_000, max: 40 }); // 40 challenges / 5 min
const paylinkCreateRateLimit = rateLimit({ windowMs: 10 * 60_000, max: 10 }); // 10 new paylinks / 10 min

function zecToZats(zec) {
  return Math.round(Number(zec) * 1e8);
}

// ZIP-321 payment URI carrying the one-time challenge code in the memo.
function paymentUri(code, amount) {
  const memoB64url = Buffer.from(code, 'utf8').toString('base64url');
  return `zcash:${RECEIVE_ADDRESS}?amount=${amount}&memo=${memoB64url}`;
}

app.post('/auth/challenge', challengeRateLimit, async (req, res) => {
  const requested = req.body?.purpose;
  const purpose = Object.prototype.hasOwnProperty.call(GATES, requested) ? requested : 'login';
  const gate = GATES[purpose];
  const challenge = createChallenge({
    purpose,
    minAmountZats: zecToZats(gate.amount),
    requireConfirmation: gate.requireConfirmation,
  });
  const uri = paymentUri(challenge.code, gate.amount);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 280 });
  res.json({
    id: challenge.id,
    code: challenge.code,
    address: RECEIVE_ADDRESS,
    amount: gate.amount,
    label: gate.label,
    uri,
    qr,
    expiresAt: challenge.expiresAt,
  });
});

app.get('/auth/status/:id', (req, res) => {
  const c = getChallenge(req.params.id);
  if (!c) return res.status(404).json({ error: 'unknown challenge' });
  const out = { id: c.id, status: c.status, txid: c.txid };
  if (c.status === 'underpaid') {
    out.requiredZats = c.minAmountZats;
    out.receivedZats = c.receivedZats;
  }
  // A Gate configured with requireConfirmation waits for the transaction to
  // actually be mined; everything else accepts it the moment it's seen in
  // the mempool. Either way the client just keeps polling and sees an
  // honest "detected" (unconfirmed) state until the token is ready.
  const readyForToken = c.requireConfirmation ? c.status === 'confirmed' : (c.status === 'detected' || c.status === 'confirmed');
  if (readyForToken) {
    // Pseudonymous subject: hash of reply-to address when provided, else the txid.
    const subject = c.replyTo
      ? crypto.createHash('sha256').update(c.replyTo).digest('hex').slice(0, 16)
      : `anon-${(c.txid ?? c.id).slice(0, 12)}`;
    out.token = jwt.sign({ sub: subject, portal: c.purpose }, JWT_SECRET, { expiresIn: '24h' });
  }
  res.json(out);
});

app.get('/wall', (req, res) => {
  res.json({ posts: wallPosts() });
});

// --- Paylinks: shareable payment requests built on the same challenge engine ---

app.post('/paylinks', paylinkCreateRateLimit, (req, res) => {
  const amt = Number(req.body?.amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'amount must be a positive ZEC value' });
  const link = createPaylink({ amount: req.body.amount, label: req.body?.label });
  res.json({ slug: link.slug, url: `/pay/${link.slug}`, amount: link.amount, label: link.label });
});

app.get('/paylinks/:slug', (req, res) => {
  const link = getPaylink(req.params.slug);
  if (!link) return res.status(404).json({ error: 'not found' });
  const totalZats = link.payments.reduce((s, p) => s + (p.valueZats ?? 0), 0);
  res.json({ slug: link.slug, amount: link.amount, label: link.label, paymentCount: link.payments.length, totalZats });
});

app.post('/paylinks/:slug/challenge', challengeRateLimit, async (req, res) => {
  const link = getPaylink(req.params.slug);
  if (!link) return res.status(404).json({ error: 'not found' });
  const challenge = createChallenge({ purpose: `paylink:${link.slug}`, minAmountZats: zecToZats(link.amount) });
  const uri = paymentUri(challenge.code, link.amount);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 280 });
  res.json({
    id: challenge.id,
    code: challenge.code,
    address: RECEIVE_ADDRESS,
    amount: link.amount,
    label: link.label,
    uri,
    qr,
    expiresAt: challenge.expiresAt,
  });
});

// Pretty URL for the pay page; the client reads the slug from the path.
app.get('/pay/:slug', (req, res) => {
  res.sendFile(path.join(root, '..', 'demo', 'pay.html'));
});

// Debug-only: prove the pipeline end-to-end by sending a real zero-value
// memo transaction from the Portal wallet to itself. Never enable in prod.
if (process.env.PORTAL_DEBUG === '1') {
  // Create a challenge with a forced code, so an existing on-chain memo can be
  // replayed against fresh challenge state after a server restart.
  app.post('/debug/challenge', (req, res) => {
    const forcedCode = String(req.body?.code ?? '');
    if (!forcedCode) return res.status(400).json({ error: 'code required' });
    const challenge = createChallenge({ purpose: 'login', forcedCode });
    res.json({ id: challenge.id, code: challenge.code });
  });

  app.post('/debug/selfsend', async (req, res) => {
    try {
      const memo = String(req.body?.memo ?? '');
      if (!memo) return res.status(400).json({ error: 'memo required' });
      const out = await selfSendMemo(RECEIVE_ADDRESS, 0, memo);
      res.json({ sent: true, result: out });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Static hosting for the SDK and demo app.
app.use('/sdk', express.static(path.join(root, '..', 'sdk')));
app.use('/', express.static(path.join(root, '..', 'demo')));

setInterval(sweepExpired, 60_000);

startWatcher();

app.listen(PORT, () => {
  console.log(`Portal auth server listening on http://localhost:${PORT}`);
  console.log(`Watching mainnet address: ${RECEIVE_ADDRESS.slice(0, 20)}...`);
});
