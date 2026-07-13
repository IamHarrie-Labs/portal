import { spawn } from 'node:child_process';
import { matchMemo } from './challenges.js';
import { recordPayment, getPaylink } from './paylinks.js';
import { fireWebhook } from './webhooks.js';

// Persistent zingo-cli session design — verified empirically (2026-07-10):
//   * A session's startup sync does NOT keep following the chain; `messages`
//     output stays frozen at the last completed sync. (This caused missed
//     transactions in v2.)
//   * Interactive `sync` requires a sub-command. `sync run` launches an async
//     sync task; when it finishes it prints a human-readable, NON-JSON blob
//     ("Sync completed succesfully: { sync start height: ... }") that must be
//     tolerated and discarded by the output parser.
//   * After a `sync run` completes, `messages` in the same session DOES
//     reflect the new chain state, including mempool ("mempool" status) txs.
// So each poll cycle: fire-and-forget `sync run`, give it a moment, then read
// `messages`. Worst case a brand-new tx is seen one cycle late (~5s).

const ZINGO_CMD = process.env.PORTAL_ZINGO_CMD ?? 'wsl';
const ZINGO_ARGS = process.env.PORTAL_ZINGO_ARGS
  ? JSON.parse(process.env.PORTAL_ZINGO_ARGS)
  : ['-d', 'Ubuntu', '--', '/root/zingolib/target/release/zingo-cli', '--data-dir', '/root/.portal-wallet'];
const SYNC_SETTLE_MS = Number(process.env.PORTAL_SYNC_SETTLE_MS ?? 3000);
const IDLE_MS = Number(process.env.PORTAL_POLL_MS ?? 2000);

const seenKeys = new Set();
const recordedPaylinkTxids = new Set(); // dedupe: a tx can be seen at mempool then again at confirmation
let proc = null;
let buf = '';
let pending = null; // { resolve, reject }
let warmedUp = false;

/**
 * Pull the first complete top-level {...} or [...] block out of buf.
 * Returns: parsed value | undefined (block found but not valid JSON — e.g.
 * zingo's human-readable "sync completed" blob) | null (nothing complete yet).
 */
function extractJson() {
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === '{' || buf[i] === '[') { start = i; break; }
  }
  if (start === -1) { buf = ''; return null; } // plain text only — discard
  const open = buf[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === open) depth++;
    else if (buf[i] === close) {
      depth--;
      if (depth === 0) {
        const text = buf.slice(start, i + 1);
        buf = buf.slice(i + 1);
        try { return JSON.parse(text); } catch { return undefined; }
      }
    }
  }
  return null; // incomplete — wait for more output
}

function drainForPending() {
  if (!pending) return;
  let value;
  while ((value = extractJson()) !== null) {
    if (value === undefined) continue; // non-JSON blob (sync notice) — skip
    const p = pending;
    pending = null;
    p.resolve(value);
    return;
  }
}

let restarting = false;

function killSession(reason) {
  if (restarting) return; // already tearing down / respawning
  restarting = true;
  console.error(`[watcher] session lost (${reason}) — restarting in 4s`);
  if (pending) { pending.reject(new Error('session lost mid-command')); pending = null; }
  const dead = proc;
  proc = null;
  buf = '';
  warmedUp = false;
  if (dead) { try { dead.kill('SIGKILL'); } catch { /* already gone */ } }
  // Killing the wsl.exe wrapper does not guarantee the zingo-cli process
  // *inside* WSL actually dies — an orphan there would hold the wallet lock
  // and wedge every future respawn. Best-effort explicit cleanup.
  if (ZINGO_CMD === 'wsl') {
    try {
      spawn('wsl', ['-d', 'Ubuntu', '--', 'pkill', '-9', '-f', 'zingo-cli'], { stdio: 'ignore' })
        .on('error', () => {});
    } catch { /* best-effort */ }
  }
  setTimeout(() => { restarting = false; spawnSession(); }, 4000);
}

function spawnSession() {
  console.log(`[watcher] starting persistent session: ${ZINGO_CMD} ${ZINGO_ARGS.join(' ')}`);
  proc = spawn(ZINGO_CMD, ZINGO_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  // A dead/broken pipe (e.g. the WSL host slept overnight) emits an 'error'
  // on these streams. Without a listener, Node treats that as an unhandled
  // error and crashes the whole process — happened once already. Treat it
  // the same as an unexpected exit: tear down and respawn.
  proc.stdin.on('error', (err) => killSession(`stdin ${err.code ?? err.message}`));
  proc.stdout.on('error', (err) => killSession(`stdout ${err.code ?? err.message}`));
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    drainForPending();
  });
  let consecutiveSyncErrors = 0;
  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString('utf8').trim();
    if (!line || line.includes('systemd user session')) return;
    console.error(`[watcher][stderr] ${line}`);
    // `messages` keeps returning its last-known-good snapshot even while sync
    // is silently wedged (e.g. a stuck gRPC connection to lightwalletd) — so
    // our normal command-timeout watchdog never fires. Re-issuing `sync run`
    // on the same broken connection just repeats the same timeout, so treat
    // repeated sync failures as a signal to force a fresh connection.
    if (/Sync error|Deadline expired|ChainTip reply timeout/i.test(line)) {
      consecutiveSyncErrors++;
      if (consecutiveSyncErrors >= 3) {
        consecutiveSyncErrors = 0;
        killSession('sync repeatedly failing — forcing reconnect');
      }
    } else {
      consecutiveSyncErrors = 0;
    }
  });
  proc.stderr.on('error', () => {}); // never let stderr plumbing itself crash us
  proc.on('exit', (code) => killSession(`exited with code ${code}`));
}

/** Send a command expecting a JSON reply. */
function runCommand(cmd, timeoutMs = warmedUp ? 20000 : 90000) {
  if (!proc) return Promise.reject(new Error('session not running'));
  if (pending) return Promise.reject(new Error('a command is already in flight'));
  buf = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending) { pending = null; reject(new Error(`'${cmd}' timed out after ${timeoutMs}ms`)); }
    }, timeoutMs);
    pending = {
      resolve: (v) => { clearTimeout(timer); warmedUp = true; resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    proc.stdin.write(cmd + '\n');
    drainForPending(); // in case the reply raced ahead of registration
  });
}

/** Send a command whose output we don't need (e.g. `sync run`). */
function fireAndForget(cmd) {
  if (proc && !pending) proc.stdin.write(cmd + '\n');
}

function handleValueTransfers(transfers) {
  for (const vt of transfers) {
    if (!vt) continue;
    const kind = (vt.kind ?? '').toLowerCase();
    // Only inbound transfers count. Debug mode also accepts self-sends so the
    // pipeline can be exercised end-to-end without an external wallet.
    const debugSelf = process.env.PORTAL_DEBUG === '1' && kind.includes('self');
    if (kind && !kind.includes('receiv') && !debugSelf) continue;
    const txid = vt.txid ?? vt.tx_id ?? null;
    const memos = Array.isArray(vt.memos) ? vt.memos : (vt.memo ? [vt.memo] : []);
    const status = (vt.status ?? '').toLowerCase();
    const confirmed = status.includes('confirmed') && !status.includes('unconfirmed');
    for (const memo of memos) {
      const key = `${txid}:${memo}`;
      if (seenKeys.has(key) && !confirmed) continue;
      seenKeys.add(key);
      const matched = matchMemo(String(memo), { txid, replyTo: vt.reply_to ?? null, valueZats: vt.value ?? 0 });
      if (matched) {
        if (matched.status === 'underpaid') {
          console.log(`[watcher] challenge ${matched.code} UNDERPAID: got ${vt.value ?? 0} zats, needed ${matched.minAmountZats} (tx ${txid})`);
        } else {
          if (confirmed) matched.status = 'confirmed';
          console.log(`[watcher] challenge ${matched.code} satisfied by tx ${txid} (${confirmed ? 'confirmed' : 'mempool'})`);
          if (matched.purpose?.startsWith('paylink:') && !recordedPaylinkTxids.has(txid)) {
            recordedPaylinkTxids.add(txid);
            recordPayment(matched.purpose.slice('paylink:'.length), { txid, valueZats: vt.value ?? 0 });
          }
          notifyWebhook(matched, { txid, valueZats: vt.value ?? 0 });
        }
      }
    }
  }
}

// Route a matched challenge back to the creator it belongs to (if any) and
// fire their webhook. Fires at most once per (txid, status) pair so a Gate
// that goes mempool -> confirmed triggers two distinct events, not a flood.
const webhookFiredKeys = new Set();
function notifyWebhook(matched, { txid, valueZats }) {
  if (!txid) return;
  const key = `${txid}:${matched.status}`;
  if (webhookFiredKeys.has(key)) return;
  webhookFiredKeys.add(key);
  let creatorId = null;
  if (matched.purpose?.startsWith('cgate:')) {
    creatorId = matched.purpose.split(':')[1];
  } else if (matched.purpose?.startsWith('paylink:')) {
    const link = getPaylink(matched.purpose.slice('paylink:'.length));
    creatorId = link?.creatorId ?? null;
  }
  if (!creatorId) return;
  fireWebhook(creatorId, {
    type: matched.status === 'confirmed' ? 'payment.confirmed' : 'payment.detected',
    data: { txid, code: matched.code, purpose: matched.purpose, valueZats },
  });
}

/** Self-send a memo from the Portal wallet to itself (used by debug self-test). */
export async function selfSendMemo(address, amountZats, memo) {
  const out = await runCommand(`quicksend ${address} ${amountZats} "${memo}"`, 120000);
  return out;
}

// Carve a fresh diversified unified address out of the SAME wallet seed —
// used to give each creator account their own receiving address without
// spinning up a separate wallet process. zingo-cli's `new_address oz`
// replies with (verified live) either a single object or a one-element
// array of objects shaped like { encoded_address: "u1...", ... }.
export async function newAddress() {
  const out = await runCommand('new_address oz', 60000);
  const entry = Array.isArray(out) ? out[0] : out;
  const address = entry?.encoded_address
    ?? entry?.address
    ?? (typeof entry === 'string' ? entry : null);
  if (!address) throw new Error(`unexpected new_address response: ${JSON.stringify(out)}`);
  return address;
}

export function startWatcher() {
  spawnSession();
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3; // e.g. process is alive but wedged, not crashed
  (async function loop() {
    for (;;) {
      try {
        fireAndForget('sync run');
        await new Promise((r) => setTimeout(r, SYNC_SETTLE_MS));
        const out = await runCommand('messages');
        const transfers = out?.value_transfers ?? (Array.isArray(out) ? out : []);
        handleValueTransfers(transfers);
        console.log(`[watcher] heartbeat: cycle ok (${transfers.length} transfers known)`);
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        console.error(`[watcher] cycle failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          killSession('too many consecutive stalled cycles');
        }
      }
      await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  })();
}
