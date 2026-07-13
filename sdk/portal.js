/**
 * Portal SDK. Sign in with Zcash.
 * Drop-in widget: include this script, then call Portal.login().
 *
 *   const session = await Portal.login({ server: 'https://your-portal-server' });
 *   // session = { token, txid, code }
 *
 * The widget opens a modal with a ZIP-321 QR (desktop) or a tap-to-open
 * wallet deep link (mobile), then polls the Portal server until the shielded
 * payment carrying the challenge memo is detected on Zcash mainnet.
 */
(function (global) {
  'use strict';

  const POLL_MS = 2500;

  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // Styling matches the Portal site design system: near-black glass card,
  // gold accent, Space Grotesk / Inter inherited from the host page.
  const S = {
    overlay: {
      position: 'fixed', inset: '0', background: 'rgba(5,6,9,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '99999', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    },
    card: {
      background: 'rgba(14,16,23,0.96)', color: '#f2f3f7', borderRadius: '24px',
      padding: '32px', width: 'min(380px, 92vw)', textAlign: 'center',
      fontFamily: 'inherit', border: '1px solid rgba(255,255,255,0.10)',
      boxShadow: '0 32px 80px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.06)',
    },
    stage: { fontSize: '13px', color: '#9aa3b2', minHeight: '18px', marginTop: '16px' },
    code: {
      fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '15px', letterSpacing: '2.5px',
      background: 'rgba(244,183,40,0.08)', border: '1px solid rgba(244,183,40,0.25)',
      borderRadius: '10px', padding: '8px 16px',
      display: 'inline-block', marginTop: '12px', color: '#f4b728',
    },
    btn: {
      display: 'inline-block', marginTop: '18px', padding: '13px 24px',
      background: 'linear-gradient(120deg, #f7931a 0%, #f4b728 65%)', color: '#14100a',
      borderRadius: '100px', fontWeight: '700', textDecoration: 'none', border: 'none',
      cursor: 'pointer', fontSize: '15px', fontFamily: 'inherit',
    },
    dismiss: {
      marginTop: '16px', background: 'none', border: 'none', color: '#9aa3b2',
      cursor: 'pointer', fontSize: '13px', textDecoration: 'underline', fontFamily: 'inherit',
    },
  };

  async function requestChallenge(server, url, body) {
    const res = await fetch(`${server}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Portal server error: ${res.status}`);
    return res.json();
  }

  /** Shared modal + polling flow, driven by an already-created challenge. */
  function runChallengeFlow(ch, server, onStage) {
    return new Promise((resolve, reject) => {
      const stageText = el('div', { style: S.stage }, 'Waiting for your wallet…');
      const setStage = (msg) => { stageText.textContent = msg; if (onStage) onStage(msg); };

      const inner = [
        el('div', {
          style: {
            width: '40px', height: '46px', margin: '0 auto 14px',
          },
        }, (() => {
          const wrap = document.createElement('div');
          wrap.innerHTML = '<svg width="40" height="46" viewBox="0 0 24 28" fill="none"><path d="M2 28V12A10 10 0 0 1 22 12V28H2Z" fill="#f4b728" stroke="#14100a" stroke-width="0.6"/></svg>';
          return wrap.firstChild;
        })()),
        el('div', { style: { fontSize: '19px', fontWeight: '700', letterSpacing: '-0.02em' } }, ch.label ?? 'Sign in with Zcash'),
        el('div', { style: { fontSize: '13px', color: '#9aa3b2', marginTop: '8px', lineHeight: '1.55' } },
          Number(ch.amount) > 0
            ? `Send ${ch.amount} ZEC with the memo below to unlock.`
            : `Send a zero-value shielded transaction with the memo below. Your wallet pays only the standard network fee.`),
        el('div', { style: S.code }, ch.code),
      ];

      if (isMobile()) {
        inner.push(el('div', {}, el('a', { href: ch.uri, style: S.btn }, 'Tap to open wallet')));
      } else {
        inner.push(el('img', {
          src: ch.qr, alt: 'Zcash payment QR',
          style: { width: '208px', height: '208px', margin: '18px auto 0', borderRadius: '16px', background: '#fff', padding: '10px', display: 'block' },
        }));
        inner.push(el('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '10px' } },
          'Scan with Zashi, Ywallet, or Zingo'));
      }

      inner.push(stageText);

      // Cancel must be part of `inner` before the modal is built. Children
      // are consumed at creation time, so a later push never renders.
      let timer = null;
      let overlay = null;
      const cleanup = () => { clearInterval(timer); overlay?.remove(); };
      inner.push(el('div', {}, el('button', {
        style: S.dismiss,
        onclick: () => { cleanup(); reject(new Error('cancelled')); },
      }, 'Cancel')));

      overlay = el('div', { style: S.overlay }, el('div', { style: S.card }, inner));
      document.body.append(overlay);

      timer = setInterval(async () => {
        try {
          const s = await (await fetch(`${server}/auth/status/${ch.id}`)).json();
          if (s.status === 'expired') { cleanup(); reject(new Error('challenge expired')); return; }
          else if (s.status === 'underpaid') {
            cleanup();
            const got = (s.receivedZats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
            const need = (s.requiredZats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
            reject(new Error(`underpaid: sent ${got} ZEC, needed ${need} ZEC. Request a new code and resend the full amount.`));
            return;
          }
          // s.error is a per-poll condition (e.g. a creator-login memo missing
          // its reply-to address) — surface it instead of silently sitting on
          // a generic "finalizing" message forever. It isn't necessarily
          // terminal (a transient wallet hiccup can clear on a later poll),
          // so keep polling rather than rejecting outright; Cancel is always
          // available if it doesn't.
          else if (s.error) setStage(s.error);
          else if (s.status === 'detected') setStage('Transaction detected on mainnet, finalizing…');
          else if (s.status === 'pending') setStage('Watching Zcash mainnet…');
          if (s.token) {
            setStage('Done ✓');
            cleanup();
            resolve({ token: s.token, txid: s.txid, code: ch.code });
          }
        } catch { /* transient poll errors are fine */ }
      }, POLL_MS);
    });
  }

  async function login({ server = '', purpose = 'login', onStage = null } = {}) {
    const ch = await requestChallenge(server, '/auth/challenge', { purpose });
    return runChallengeFlow(ch, server, onStage);
  }

  /** Pay an existing Paylink (created via POST /paylinks) by its slug. */
  async function pay({ server = '', slug, onStage = null } = {}) {
    if (!slug) throw new Error('Portal.pay requires a slug');
    const ch = await requestChallenge(server, `/paylinks/${slug}/challenge`, {});
    return runChallengeFlow(ch, server, onStage);
  }

  /** Render a downloadable receipt card PNG for a completed Portal session. */
  function receiptPng({ txid, code, amount = '0', when = new Date() }) {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const x = c.getContext('2d');
    x.fillStyle = '#12151c'; x.fillRect(0, 0, 640, 360);
    x.strokeStyle = '#2a2f3a'; x.lineWidth = 2; x.strokeRect(12, 12, 616, 336);
    x.fillStyle = '#f4b728'; x.font = 'bold 28px system-ui';
    x.fillText('Portal · Zcash Receipt', 40, 70);
    x.fillStyle = '#e8eaf0'; x.font = '16px ui-monospace, monospace';
    x.fillText(`Code:    ${code}`, 40, 130);
    x.fillText(`Amount:  ${Number(amount) > 0 ? amount : '0'} ZEC (shielded)`, 40, 165);
    x.fillText(`Time:    ${when.toISOString()}`, 40, 200);
    x.font = '12px ui-monospace, monospace';
    x.fillText(`Tx: ${txid ?? 'n/a'}`, 40, 240);
    x.fillStyle = '#9aa3b2'; x.font = '13px system-ui';
    x.fillText('Sender, receiver, amount and memo are shielded on-chain.', 40, 296);
    return c.toDataURL('image/png');
  }

  function explorerUrl(txid) {
    return `https://mainnet.zcashexplorer.app/transactions/${txid}`;
  }

  global.Portal = { login, pay, receiptPng, explorerUrl };
})(window);
