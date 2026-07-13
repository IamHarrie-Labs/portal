import express from 'express';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChallenge, getChallenge, sweepExpired, wallPosts } from './challenges.js';
import { startWatcher, selfSendMemo, newAddress } from './watcher.js';
import { createPaylink, getPaylink, listByCreator } from './paylinks.js';
import { rateLimit } from './rateLimit.js';
import { JWT_SECRET, signCreatorToken, requireCreator } from './jwtAuth.js';
import { createCreator, findByIdentityHash, getCreator, setDisplayName, setWebhookUrl, publicCreator } from './creators.js';
import { listGates, getGate, upsertGate, deleteGate } from './gates.js';
import { isSafeWebhookUrl } from './webhooks.js';

const PORT = process.env.PORT ?? 8787;
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
  // A creator account is authenticated the exact same way an end user is:
  // send a zero-value memo with the code. No password, ever. See the
  // 'creator-login' branch in GET /auth/status/:id for what happens once
  // it's detected.
  'creator-login': { amount: '0', label: 'Creator sign-in', requireConfirmation: false },
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
// `address` defaults to the single operator's address; creator Gates and
// creator Paylinks pass their own diversified address instead.
function paymentUri(code, amount, address = RECEIVE_ADDRESS) {
  const memoB64url = Buffer.from(code, 'utf8').toString('base64url');
  return `zcash:${address}?amount=${amount}&memo=${memoB64url}`;
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
    // Creator sign-in needs the sender to identify themselves INSIDE the
    // memo (shielded Zcash has no sender field) — surface that in the modal.
    note: purpose === 'creator-login'
      ? 'Important: add your own Zcash address (u1...) in the memo after the code. That address is your account.'
      : undefined,
    uri,
    qr,
    expiresAt: challenge.expiresAt,
  });
});

// Concurrent status polls for the same brand-new creator identity must not
// each independently mint a diversified address — the first poll to detect
// the payment starts creation, every other poll for the same identity
// arriving before it finishes just awaits the same in-flight promise.
const pendingCreatorCreation = new Map(); // identityHash -> Promise<creator>

async function getOrCreateCreator(identityHash) {
  const existing = findByIdentityHash(identityHash);
  if (existing) return existing;
  if (pendingCreatorCreation.has(identityHash)) return pendingCreatorCreation.get(identityHash);
  const creation = (async () => {
    const address = await newAddress();
    return createCreator({ identityHash, address });
  })();
  pendingCreatorCreation.set(identityHash, creation);
  try {
    return await creation;
  } finally {
    pendingCreatorCreation.delete(identityHash);
  }
}

app.get('/auth/status/:id', async (req, res) => {
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
    if (c.purpose === 'creator-login') {
      // The account key is a reply address parsed out of the memo TEXT
      // (there is no protocol-level sender field on shielded Zcash — see
      // extractReplyAddress in challenges.js). Persistence depends on the
      // creator using the same address each login. Missing address = we
      // tell them exactly how to include one, from any wallet.
      if (!c.replyTo) {
        out.error = 'No reply address found in your memo. Add your own Zcash address (u1...) after the code in the memo, or enable "include reply address" in Ywallet, then request a new code and try again.';
      } else {
        try {
          const identityHash = crypto.createHash('sha256').update(c.replyTo).digest('hex').slice(0, 32);
          const creator = await getOrCreateCreator(identityHash);
          out.token = signCreatorToken(creator);
          out.creator = publicCreator(creator);
        } catch (err) {
          out.error = `wallet unavailable: ${err.message}`;
        }
      }
    } else {
      // Pseudonymous subject: hash of reply-to address when provided, else the txid.
      const subject = c.replyTo
        ? crypto.createHash('sha256').update(c.replyTo).digest('hex').slice(0, 16)
        : `anon-${(c.txid ?? c.id).slice(0, 12)}`;
      out.token = jwt.sign({ sub: subject, portal: c.purpose }, JWT_SECRET, { expiresIn: '24h' });
    }
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
  const payAddress = link.address ?? RECEIVE_ADDRESS;
  const challenge = createChallenge({ purpose: `paylink:${link.slug}`, minAmountZats: zecToZats(link.amount) });
  const uri = paymentUri(challenge.code, link.amount, payAddress);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 280 });
  res.json({
    id: challenge.id,
    code: challenge.code,
    address: payAddress,
    amount: link.amount,
    label: link.label,
    uri,
    qr,
    expiresAt: challenge.expiresAt,
  });
});

// --- Creator accounts: multi-tenant on top of the same single wallet seed ---
// Each creator gets their own diversified receiving address (see
// watcher.js#newAddress) so their Gates, Paylinks, and webhooks are fully
// isolated from the single-operator demo and from each other, without
// running a separate wallet process per creator. Authentication is the
// 'creator-login' Gate above — no registration endpoint, no password: the
// account is created (or recognized) the first time a wallet signs in.

app.get('/creators/me', requireCreator, (req, res) => {
  const creator = getCreator(req.creatorId);
  if (!creator) return res.status(404).json({ error: 'creator not found' });
  const paylinks = listByCreator(creator.id).map((l) => ({
    slug: l.slug,
    amount: l.amount,
    label: l.label,
    paymentCount: l.payments.length,
    totalZats: l.payments.reduce((s, p) => s + (p.valueZats ?? 0), 0),
  }));
  res.json({ creator: publicCreator(creator), gates: listGates(creator.id), paylinks });
});

app.patch('/creators/me/profile', requireCreator, (req, res) => {
  const raw = req.body?.displayName;
  const displayName = raw && String(raw).trim() ? String(raw).trim().slice(0, 60) : null;
  const creator = setDisplayName(req.creatorId, displayName);
  res.json({ creator: publicCreator(creator) });
});

app.patch('/creators/me/webhook', requireCreator, async (req, res) => {
  const url = req.body?.url ? String(req.body.url) : null;
  if (url) {
    const safe = await isSafeWebhookUrl(url);
    if (!safe) return res.status(400).json({ error: 'webhook url must be a public http(s) endpoint' });
  }
  const creator = setWebhookUrl(req.creatorId, url);
  res.json({ creator: publicCreator(creator) });
});

// --- Configurable multi-tier Gates, owned by a creator ---

app.get('/creators/me/gates', requireCreator, (req, res) => {
  res.json({ gates: listGates(req.creatorId) });
});

app.put('/creators/me/gates/:key', requireCreator, (req, res) => {
  try {
    const gate = upsertGate(req.creatorId, req.params.key, req.body ?? {});
    res.json({ key: req.params.key, gate });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/creators/me/gates/:key', requireCreator, (req, res) => {
  deleteGate(req.creatorId, req.params.key);
  res.json({ ok: true });
});

// Public: anyone paying into a creator's Gate. No auth — this is the
// end-user side, mirroring /auth/challenge and /paylinks/:slug/challenge.
app.post('/creators/:creatorId/gates/:key/challenge', challengeRateLimit, async (req, res) => {
  const creator = getCreator(req.params.creatorId);
  if (!creator) return res.status(404).json({ error: 'creator not found' });
  const gate = getGate(req.params.creatorId, req.params.key);
  if (!gate) return res.status(404).json({ error: 'gate not found' });
  const challenge = createChallenge({
    purpose: `cgate:${req.params.creatorId}:${req.params.key}`,
    minAmountZats: zecToZats(gate.amount),
    requireConfirmation: gate.requireConfirmation,
  });
  const uri = paymentUri(challenge.code, gate.amount, creator.address);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 280 });
  res.json({
    id: challenge.id,
    code: challenge.code,
    address: creator.address,
    amount: gate.amount,
    label: gate.label,
    uri,
    qr,
    expiresAt: challenge.expiresAt,
  });
});

// Authenticated: a creator's own dashboard can create Paylinks that pay into
// their own address, distinct from the anonymous single-operator /paylinks.
app.post('/creators/me/paylinks', requireCreator, paylinkCreateRateLimit, (req, res) => {
  const amt = Number(req.body?.amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'amount must be a positive ZEC value' });
  const creator = getCreator(req.creatorId);
  const link = createPaylink({
    amount: req.body.amount,
    label: req.body?.label,
    creatorId: creator.id,
    address: creator.address,
  });
  res.json({ slug: link.slug, url: `/pay/${link.slug}`, amount: link.amount, label: link.label });
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
