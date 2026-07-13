# Portal — Full Project Specification

**Submission for ZecHub Hackathon 3.0 — Zcash Login track**
**Deadline: July 15, 2026**

---

## 1. What Portal Is

Portal is authentication and access control for the web, built on Zcash shielded
transactions instead of passwords, email, or OAuth.

The core insight: a Zcash memo field is a private, authenticated, timestamped
message channel that already exists on mainnet, with client software already
in millions of pockets (every shielded wallet). Nobody needed to build a new
protocol, get wallets to adopt it, or ask users to install anything. Portal
just watches for a specific message to arrive.

**The one-sentence pitch:** *Log into any website by sending a few cents of
ZEC with a code in the memo — no password, no email, no identity revealed,
and the login itself is a real transaction on Zcash mainnet.*

**The deeper pitch:** because authenticating *is* paying, the same mechanism
that logs you in can gate content, collect payments, and issue receipts. One
engine, three products: **Login, Gates, Paylinks.**

---

## 2. The Problem It Solves

- **Password/email auth** leaks identity to every service you touch, gets
  breached, and gets you tracked across sites via SSO providers (Google,
  Apple, etc. all know everywhere you log in).
- **Wallet-signature auth** (the "obvious" Web3 answer, e.g. Sign-In-With-
  Ethereum style) requires wallets to implement a specific signing standard.
  On Zcash, no deployed shielded wallet supports arbitrary message signing —
  so that approach can't ship a working demo with real wallets today.
- **Paywalls and memberships** are normally a separate system from auth
  entirely (Stripe subscriptions, license keys) bolted onto login.

Portal collapses all of this into one primitive that works with wallets that
already exist, satisfies the hackathon's mainnet-interaction requirement on
every single use, and treats "prove you have an account" and "prove you paid"
as the same act.

---

## 3. How It Works (End to End)

1. **Challenge issuance.** A website (or the Portal demo) requests a
   challenge from the Portal server: `POST /auth/challenge`. The server
   generates a short one-time code (`PT-XXXXXX`), stores it with a 10-minute
   TTL, and returns:
   - a ZIP-321 `zcash:` payment URI (recipient = Portal's shielded address,
     amount = 0.0001 ZEC, memo = the code, base64url-encoded)
   - a QR code rendering of that URI
   - the raw code, for manual entry
2. **User pays.** On desktop, the user scans the QR with any shielded Zcash
   wallet (Zashi, Ywallet, Zingo). On mobile, they tap a deep link that opens
   their wallet app directly with the amount and memo pre-filled. They
   confirm the send — no typing, no new account, no browser extension.
3. **Detection.** A Zcash light client (zingolib's `zingo-cli`), running as a
   sidecar process and connected to a public lightwalletd (`zec.rocks:443`),
   holds the viewing keys for Portal's wallet and continuously polls for
   incoming shielded transactions. When a transaction's decrypted memo
   contains an active challenge code, that challenge flips to `detected`
   (and later `confirmed` once mined).
4. **Session issuance.** The client, which has been polling
   `GET /auth/status/:id`, sees the status change and receives a signed JWT
   (24-hour expiry). The website is now "logged in" — with a session subject
   derived from either an optional reply-to address in the memo (for a
   persistent pseudonym across visits) or an anonymous hash of the
   transaction ID (for a one-time, fully unlinkable login).
5. **Proof, not surveillance.** The website never learns the user's address,
   balance, or transaction history — only that *a* valid payment with *that*
   code arrived. Clicking through to a block explorer shows nothing further:
   sender, receiver, amount, and memo are all shielded by protocol design.

---

## 4. Feature Set

### 4.1 Core (build priority 1 — done or in progress)

| Feature | Status | Description |
|---|---|---|
| Challenge/session server | ✅ built | Express server: challenge issuance, TTL, status polling, JWT sessions |
| ZIP-321 payment URI + QR | ✅ built | Correct `zcash:` URI with amount + base64url memo, rendered as QR |
| Mainnet memo watcher | ✅ built | zingo-cli sidecar polling loop, parses `value_transfers`, matches codes |
| Drop-in JS SDK (`Portal.login()`) | ✅ built | Single script include; handles modal, QR/deep-link switch, polling, resolves a session |
| Mobile deep links | ✅ built | User-agent sniffing renders "Tap to open wallet" instead of QR on mobile |
| Staged status UI | ✅ built | Honest, state-driven copy: "Watching mainnet… → detected → signed in" (no fake progress bars) |
| Session persistence | ✅ built | JWT stored client-side; first login is on-chain, subsequent nav is instant |
| Live mainnet verification | ⏳ pending | First real dust payment + memo, to confirm detection latency end-to-end |

### 4.2 Differentiating features (build priority 2)

| Feature | Status | Description |
|---|---|---|
| **Shielded Wall** | ✅ built | Free-text after the code in the memo becomes a public post — literally written to the world via a mainnet shielded transaction. Every post is proof-of-mainnet-use in itself. |
| **Gates (paywall/membership)** | ⏳ next | Same engine, different amount tiers unlock different content. "VIP Lounge" tier 2 (0.05 ZEC) unlocks a members-only page. |
| **Receipt cards** | ✅ built | Client-side canvas renders a shareable PNG receipt (code, amount, txid, timestamp) after a successful login/payment. |
| **Explorer deep link** | ✅ built | One-click link to view the transaction on a public Zcash block explorer — the punchline is that it shows nothing (privacy as the demo's "wow" moment). |
| **Paylinks** | ⏳ next | Reuses the exact same challenge engine with a custom amount + label, producing a shareable `portal/pay/...` request link — payment-request infrastructure, not just login. |

### 4.3 Narrative / ecosystem features (build priority 3)

| Feature | Status | Description |
|---|---|---|
| Auth-dust forwarding | ⏳ planned | Daily scheduled sweep of accumulated 0.0001 ZEC login dust to ZecHub's official donation address, net of fees; sweep txids published for public verification. Frames Portal as something that funds the ecosystem it's built for. |
| "Hackathon VIP Lounge" demo framing | ✅ built (v1) | The demo site casts community voters as the protagonists of the login flow itself, not passive video-watchers. |

### 4.4 Explicitly out of scope (documented, not built)

- **Card/Stripe/fiat rails** — would require licensed money-transmission and
  KYC, and identifying the payer defeats the entire privacy premise.
- **Paymaster / gasless transactions** — an Ethereum account-abstraction
  concept; doesn't map onto Zcash, which has no smart contracts and already
  charges fixed, sub-cent, native-token fees (~0.0001–0.0002 ZEC via ZIP-317).
  There's no gas problem here to solve.
- **Dust refunds on login** — cute idea (net-free login) but doubles
  transaction-fee overhead for a marginal feature; noted as future work.

---

## 5. Architecture

```
+----------+   1. GET /auth/challenge    +--------------+
| Website  | --------------------------> |    Portal    |
| (any app | <-------------------------- |    server    |
| with SDK)|   challenge + zcash: URI QR |  (Node/Express)
+----------+                             |              |
     ^                                   |  zingo-cli   |
     | 4. session JWT                    |  sidecar     |
     |                                   |  (Rust light |
+----------+   2. shielded dust payment  |   client)    |
|  User's  |      with challenge memo    +------+-------+
|  wallet  | ---------- Zcash mainnet ----------+ 3. polls & detects memo
+----------+           (zec.rocks lightwalletd)      via lightwalletd gRPC
```

**Repo layout**
- `server/` — Node.js auth server (`challenges.js`, `index.js`, `watcher.js`)
- `sdk/` — `portal.js`, the drop-in browser widget
- `demo/` — the reference integration (login button, Wall, lounge)
- `docs/` — this spec, the build playbook, setup/README materials

---

## 6. Tech Stack

- **Server:** Node.js, Express, `jsonwebtoken`, `qrcode`
- **Mainnet client:** zingolib / `zingo-cli` (Rust), built under WSL2 Ubuntu,
  connected to the public `zec.rocks:443` lightwalletd — no local node sync
  required
- **SDK/frontend:** vanilla JS (zero dependencies, so any site can embed it),
  Canvas API for receipts
- **Session format:** JWT, 24h expiry
- **Standards used:** ZIP-321 (payment URIs), Zcash shielded memo field
  (Orchard/Sapling)

---

## 7. Why This Wins the Login Track

| | Portal | ZecAuth (main rival, PR #1801) |
|---|---|---|
| Touches Zcash mainnet | Every login is a real tx | No on-chain interaction at all |
| Works with real wallets today | Yes — Zashi, Ywallet, Zingo, unmodified | No — needs a new signing standard wallets don't support yet |
| Can carry value | Yes — same primitive gates/pays | No — proves key ownership only |
| Demoable by a random voter | Yes — anyone with a shielded wallet can try it live | No — requires their custom tooling |

In a **community-voted** hackathon, "voters can personally experience this
during the vote" is a structural advantage no amount of engineering polish
on a pure-signature scheme can match.

---

## 8. Status Snapshot (as of this writing)

**Working right now**, verified locally:
- Portal server running, serving demo + SDK, mainnet wallet created and address live
- `POST /auth/challenge` returns a correct ZIP-321 URI + QR
- Watcher polling mainnet via zingo-cli, ~8.5s poll cycles after warm-up
- Demo page live at `localhost:8787` with working login button and Shielded Wall

**Next immediate step:** a real dust payment from a live wallet, to confirm
end-to-end detection latency and produce the first authentic login — and
double as raw footage for the demo video.
