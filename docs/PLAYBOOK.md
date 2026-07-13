# Portal — Feature & Narrative Playbook

Decisions locked for the submission build. Core architecture unchanged.

## UX features

1. **Mobile deep links (ZIP-321)** — SDK detects mobile user agents and renders a
   "Tap to open wallet" button using the same `zcash:` URI we already generate
   (note: ZIP-321 memo param is `memo=` base64url, not `message=`). Desktop gets
   the QR. Both paths ship in the SDK widget.
2. **Detection-wait theater** — after "I've sent it," the widget shows staged
   status honestly derived from real state: `watching mempool… → transaction
   detected (0-conf) → confirmed`. If mempool detection proves unreliable for
   shielded txs (VERIFY against built zingo-cli), the animation absorbs up to a
   ~75s block wait without feeling broken.
3. **JWT sessions** — already implemented (24h token on detection). First login
   is Zcash-native; subsequent navigation is instant.
4. **Receipt cards + explorer link** — after detection, offer "Save receipt as
   image" (client-side canvas render: txid, amount, code, timestamp) and "View
   on explorer" (Nighthawk zcash-explorer). Demo beat: the explorer shows
   NOTHING for a shielded tx — privacy as the money shot.
5. **Paylinks** — shareable payment request links reusing the challenge engine:
   custom amount + label → QR/deep link → live detection → receipt. Positions
   Portal as payment infrastructure, not just auth. Build AFTER core demo works.

6. **Zero-value login (decided 2026-07-10)** — login amount is 0 ZEC. Zero-
   value shielded outputs with memos are explicitly valid on Zcash (ZIP-231),
   so a login is still a real mainnet transaction, but Portal collects
   nothing. The user pays only Zcash's standard, unavoidable network fee
   (~0.0001 ZEC, a fraction of a cent — same as any private Zcash send), and
   that fee goes to the network, not to us. This directly answers "why do I
   pay to log in?" — you don't; you pay the ordinary cost of a private
   transaction, same as you would anywhere else on Zcash. Superseded the
   auth-dust-forwarding idea below (nothing accumulates to forward).
   **Gates/paywall tiers still charge real ZEC** — the zero-value rule is for
   plain Login only; paying for access is the point of a Gate.

## Community-vote narrative

7. **Demo = "Hackathon VIP Lounge"** — voters are the protagonists:
   - Tier 1 (login, free): access + post to a **Shielded Wall** — the
     message rides in the login memo itself (memo = challenge code + optional
     text), so the wall is literally written via mainnet shielded txs.
   - Tier 2 (0.05 ZEC, a real Gate): unlocks a fun members-only page
     (community easter egg).

## Explicitly rejected (keep for README "future work")

- Card/Stripe fiat rails (licensing + identifies payer = breaks privacy story)
- Paymaster/gasless (EVM concept; Zcash fees are protocol-fixed ~0.0001 ZEC in
  native token already; can't sponsor a shielded sender's fee)
- Auth-dust forwarding to ZecHub (superseded by zero-value login — nothing
  accumulates to forward; note as a possible future *optional* donation tier)

## Verification checklist (before claiming anything publicly)

- [ ] zingo-cli mempool (0-conf) memo decryption works for incoming shielded txs
- [ ] Zashi + Ywallet both parse our ZIP-321 URI with amount + memo prefilled
- [ ] Reply-to address in memo surfaces in zingo-cli output (persistent pseudonym)
- [ ] ZecHub official donation address confirmed from zechub.wiki
