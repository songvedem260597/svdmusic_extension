// Stress + invariant tests for the sidepanel ↔ standalone view transfer lock.
//
// The reported bug was: expand → pin back, repeated, eventually left the
// view-mode button permanently dead. Root cause was a hand-released mutex with
// ~20 escape paths across two long async handlers, plus a false assumption that
// the Side Panel unmounts when closed.
//
// Two things are verified here:
//   1. Behaviour  — the real lock module, hammered with fault injection.
//   2. Structure  — src/App.jsx still obeys the contract that makes (1) enough.
//
// Run: node scripts/stress-view-transfer.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { isLockHeld, acquireLock, releaseLock } from "../src/utils/viewTransferLock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(resolve(HERE, "../src/App.jsx"), "utf8");

const TTL = 30_000;
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
// Mirrors the wrapper in App.jsx exactly: acquire, run, release in `finally`.
function makeGuardedRunner(lockRef, onReject) {
  return async function guarded(body) {
    if (!acquireLock(lockRef, TTL)) {
      onReject?.();
      return "rejected";
    }
    try {
      return await body();
    } finally {
      releaseLock(lockRef);
    }
  };
}

// ── 1. Lock basics ─────────────────────────────────────────────────────────
{
  const ref = { current: 0 };
  check("free lock reads as unheld", isLockHeld(ref, TTL) === false);
  check("acquire succeeds on free lock", acquireLock(ref, TTL) === true);
  check("lock reads as held after acquire", isLockHeld(ref, TTL) === true);
  check("second acquire is refused", acquireLock(ref, TTL) === false);
  releaseLock(ref);
  check("release frees the lock", isLockHeld(ref, TTL) === false);
  check("re-acquire after release succeeds", acquireLock(ref, TTL) === true);
  releaseLock(ref);
}

// ── 2. TTL expiry — the backstop for any future leak ───────────────────────
{
  const t0 = 1_000_000;
  const ref = { current: 0 };
  acquireLock(ref, TTL, t0);
  check("held just before TTL", isLockHeld(ref, TTL, t0 + TTL - 1) === true);
  check("expired exactly at TTL", isLockHeld(ref, TTL, t0 + TTL) === false);
  check("expiry clears the slot", ref.current === 0);

  // A leaked lock (never released) must not disable the button forever.
  const leaked = { current: 0 };
  acquireLock(leaked, TTL, t0);
  check("leaked lock blocks immediately", acquireLock(leaked, TTL, t0 + 5) === false);
  check("leaked lock reclaimable after TTL", acquireLock(leaked, TTL, t0 + TTL + 1) === true);
}

// ── 3. Clock moving backwards (suspend/resume, NTP correction) ─────────────
{
  const ref = { current: 0 };
  acquireLock(ref, TTL, 5_000_000);
  check("backwards clock does not pin the lock", isLockHeld(ref, TTL, 4_000_000) === false);
  check("backwards clock clears the slot", ref.current === 0);
}

// ── 4. Fault-injection stress ──────────────────────────────────────────────
// Every shape a handler body can take — normal return, early return, throw,
// rejected await, throw from a nested finally — must leave the lock free.
{
  const ref = { current: 0 };
  const run = makeGuardedRunner(ref);
  const ITERATIONS = 200_000;
  let leaks = 0;
  let completed = 0;

  const bodies = [
    async () => "ok",
    async () => { return; },
    async () => { throw new Error("sync-ish throw"); },
    async () => { await Promise.resolve(); throw new Error("post-await throw"); },
    async () => { await Promise.reject(new Error("rejected await")); },
    async () => { try { throw new Error("inner"); } finally { /* swallowed below */ } },
    async () => { for (let i = 0; i < 3; i += 1) { if (i === 1) return "early"; } return "late"; },
    async () => { await new Promise((r) => setImmediate(r)); return "async ok"; },
  ];

  for (let i = 0; i < ITERATIONS; i += 1) {
    const body = bodies[i % bodies.length];
    try {
      await run(body);
    } catch (_) {
      // Errors propagate to the caller; that is fine. The lock must not.
    }
    completed += 1;
    if (isLockHeld(ref, TTL)) {
      leaks += 1;
      releaseLock(ref);
    }
  }
  check(`${ITERATIONS} fault-injected runs leave no lock held`, leaks === 0, `${leaks} leaks`);
  check("every run completed", completed === ITERATIONS);
}

// ── 5. Reentrancy: a click during a transfer is refused, never queued ──────
{
  const ref = { current: 0 };
  let rejected = 0;
  const run = makeGuardedRunner(ref, () => { rejected += 1; });

  let releaseInner;
  const gate = new Promise((r) => { releaseInner = r; });
  const first = run(async () => { await gate; return "first"; });
  await Promise.resolve();

  const second = await run(async () => "second");
  check("click during in-flight transfer is refused", second === "rejected");
  check("refusal counted once", rejected === 1);

  releaseInner();
  check("first transfer still completes", (await first) === "first");
  check("lock free after in-flight transfer ends", isLockHeld(ref, TTL) === false);

  const third = await run(async () => "third");
  check("button works again on the next click", third === "third");
}

// ── 6. Hung transfer — the exact "treo" symptom ────────────────────────────
// A body that never settles (the old cross-transfer clearTimeout bug did this)
// must not disable the button forever.
{
  const t0 = 9_000_000;
  const ref = { current: 0 };
  acquireLock(ref, TTL, t0); // handler enters and never returns → no release
  check("hung transfer blocks the button initially", isLockHeld(ref, TTL, t0 + 1000) === true);
  check("hung transfer self-heals after TTL", isLockHeld(ref, TTL, t0 + TTL + 1) === false);
  check("button usable again after a hang", acquireLock(ref, TTL, t0 + TTL + 2) === true);
}

// ── 7. Source invariants — stop the bug class from coming back ─────────────
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

check(
  "the old hand-released boolean mutex is gone",
  !APP.includes("isTransferringRef"),
);

for (const [wrapper, inner] of [
  ["async function handleDetachToStandalone()", "runDetachToStandalone"],
  ["async function handlePinBackToSidePanel(event)", "runPinBackToSidePanel"],
]) {
  const body = extractFunction(APP, wrapper);
  check(`${wrapper} found`, body !== null);
  if (!body) continue;
  check(`${wrapper} acquires the lock`, body.includes("acquireLock(transferLockRef"));
  check(`${wrapper} releases in finally`, /finally\s*\{[^}]*releaseLock\(transferLockRef\)/s.test(body));
  check(`${wrapper} arms the busy-state watchdog`, body.includes("beginTransferUi()"));
  check(`${wrapper} disarms it in finally`, /finally\s*\{[^}]*endTransferUi\(\)/s.test(body));
  check(`${wrapper} clears the in-flight marker`, /finally\s*\{[^}]*inFlightTransferIdRef\.current = null/s.test(body));
  check(`${wrapper} delegates to ${inner}`, body.includes(`${inner}(`));
}

// The long bodies must never touch the lock: that is what made releases leak.
for (const name of ["async function runDetachToStandalone()", "async function runPinBackToSidePanel(event)"]) {
  const body = extractFunction(APP, name);
  check(`${name} found`, body !== null);
  if (!body) continue;
  check(`${name} never acquires the lock`, !body.includes("acquireLock("));
  check(`${name} never releases the lock`, !body.includes("releaseLock("));
  check(`${name} does not touch transferLockRef`, !body.includes("transferLockRef"));
}

{
  const body = extractFunction(APP, "async function processIncomingViewTransfer(transfer, trigger)");
  check("processIncomingViewTransfer found", body !== null);
  if (body) {
    const acquireAt = body.indexOf("acquireLock(transferLockRef");
    const tryAt = body.indexOf("try {", acquireAt);
    const snapshotGuard = body.indexOf('reason: "snapshot_mismatch"');
    const windowGuard = body.indexOf('reason: "wrong_window"');
    check("lock is acquired", acquireAt !== -1);
    check("snapshot_mismatch guard sits inside the try/finally", snapshotGuard > tryAt && tryAt > acquireAt);
    check("wrong_window guard sits inside the try/finally", windowGuard > tryAt);
    check(
      "finally releases the lock",
      /finally\s*\{[\s\S]*?releaseLock\(transferLockRef\)/.test(body),
    );
  }
}

check(
  "transfer-ready only acts on this view's own transfer",
  /msgTransferId !== inFlightTransferIdRef\.current/.test(APP),
);
check(
  "runtime READY listener is unregistered, not invoked",
  APP.includes("chrome.runtime.onMessage.removeListener(readyMessageListener)")
    && !/if \(removeListener\) \{ removeListener\(\);/.test(APP),
);
check(
  "rollback paths drop the pending snapshot too",
  APP.includes("async function discardViewTransfer(transferId)")
    && (APP.match(/await discardViewTransfer\(transferId\)/g) || []).length >= 5,
);
check(
  "both surfaces register the storage intake",
  !/if \(surfaceMode !== SIDEPANEL\) return undefined;\s*const handler/.test(APP),
);
check(
  "a stuck busy state cannot outlive the lock TTL",
  /function beginTransferUi\(\)[\s\S]*?setTimeout\([\s\S]*?releaseLock\(transferLockRef\)[\s\S]*?setIsViewTransitioning\(false\)[\s\S]*?VIEW_TRANSFER_LOCK_TTL_MS\)/.test(APP),
);
check(
  "click gate reads the lock, not the render flag",
  APP.includes("if (isTransferLocked()) return;")
    && !APP.includes("if (isViewTransitioning || isTransferringRef.current) return;"),
);

const BG = readFileSync(resolve(HERE, "../src/background.js"), "utf8");
check(
  "service worker no longer compares a window id to a tab id",
  !BG.includes("transfer.originWindowId === tabId"),
);

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n  passed: ${passed}`);
if (failures.length > 0) {
  console.error(`  FAILED: ${failures.length}`);
  for (const f of failures) console.error(`    ✗ ${f}`);
  process.exit(1);
}
console.log("  all view-transfer lock invariants hold\n");
