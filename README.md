# Portal — Sign in with Zcash 🛡️

**Passwordless, private authentication, access control, and payments on Zcash mainnet.** A drop-in "Login with Zcash" button — like "Sign in with Google," except nobody learns who you are. And because authenticating *is* paying, the same engine powers private paywalls, memberships, and shareable payment links: one shielded transaction = login + access + value.

Built for [ZecHub Hackathon 3.0](https://zechub.wiki/hackathon) — Zcash Login track.

## How it works

1. A website shows a QR code (desktop) or a "Tap to open wallet" deep link (mobile) — a standard ZIP-321 `zcash:` payment URI carrying a one-time challenge code in the memo field.
2. The user scans/taps it with any shielded Zcash wallet (Zashi, Ywallet, Zingo) and sends a dust payment (0.0001 ZEC) to the site's shielded address.
3. The Portal server — a Zcash light client watching mainnet via a public lightwalletd — detects the memo (0-conf, within seconds) and issues a session token (JWT, 24h).
4. Optional: a reply-to address in the memo becomes a persistent pseudonymous identity, letting the site "remember" the user across logins without ever knowing who they are.
5. After any transaction: save a receipt card as an image, or open the tx in a block explorer — where the world sees *nothing* (no sender, receiver, amount, or memo). That's the point.

No password. No email. No cookies-across-sites. No identity provider watching your logins.

## One engine, three products

- **Login** — passwordless private auth for any website
- **Gates** — paywalls & memberships: the login payment *is* the access fee
- **Paylinks** — shareable `portal/pay/...` request links: set an amount and label, get paid straight to your shielded wallet, with live detection and receipts

## Architecture

```
+----------+   1. GET /auth/challenge    +--------------+
| Website  | --------------------------> |    Portal    |
| (any app | <-------------------------- |    server    |
| with SDK)|   challenge + zcash: URI QR |              |
+----------+                             |  zingo-cli   |
     ^                                   |  sidecar     |
     | 4. session JWT                    |  (light      |
     |                                   |   client)    |
+----------+   2. shielded dust payment  +------+-------+
|  User's  |      with challenge memo           | 3. detects memo
|  wallet  | ---------- Zcash mainnet ----------+    via lightwalletd
+----------+           (zec.rocks)               (mempool, 0-conf)
```

- **server/** — Node.js auth server: challenge issuance, memo watching, JWT sessions, paylinks
- **sdk/** — drop-in JS widget: `<script>` tag + `portal.login()` → QR/deep-link modal → session
- **demo/** — demo app: login, Shielded Wall, gated content, paylinks
- **docs/** — setup guide, integration guide, submission materials

## Zcash mainnet usage

Every login and payment is a real shielded Orchard/Sapling transaction on Zcash mainnet, detected by a zingolib light client connected to `https://zec.rocks:443`. No testnet, no simulation.

## License

MIT
