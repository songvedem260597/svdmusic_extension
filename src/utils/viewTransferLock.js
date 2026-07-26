// Self-expiring mutex for the sidepanel ↔ standalone view transfer.
//
// Why a TTL instead of a plain boolean: the previous design used a raw
// `isTransferringRef.current = true/false` that had to be released by hand on
// every early return of two ~250-line async handlers. Any missed release left
// the view-mode button permanently dead, because App.jsx refuses a click while
// the flag is set AND renders the button `disabled`. A leak could only be
// cleared by reloading the surface — and the Side Panel's React tree survives
// close/open (see CLAUDE.md v1.1.8), so it often never got reloaded at all.
//
// The lock now stores the acquisition timestamp. Anything older than the TTL is
// treated as abandoned and reclaimed on the next read. Callers still release
// deterministically in a `finally`; the TTL is the backstop that guarantees the
// UI recovers even if a future edit introduces a new escape path.
//
// The functions take a `{ current }` box (a React ref, or a plain object in
// tests) and an explicit `now` so the behaviour is pure and testable.

/**
 * True while a transfer holds the lock. Reclaims (and clears) an expired lock
 * as a side effect so the caller never has to special-case staleness.
 */
export function isLockHeld(lockRef, ttlMs, now = Date.now()) {
  if (!lockRef || typeof lockRef !== "object") return false;
  const acquiredAt = lockRef.current;
  if (!Number.isFinite(acquiredAt) || acquiredAt <= 0) return false;
  // A clock that jumped backwards (system time change, suspend/resume) would
  // otherwise pin the lock forever — treat any non-positive age as expired too.
  if (now - acquiredAt >= ttlMs || now < acquiredAt) {
    lockRef.current = 0;
    return false;
  }
  return true;
}

/** Take the lock. Returns false when another transfer still holds it. */
export function acquireLock(lockRef, ttlMs, now = Date.now()) {
  if (!lockRef || typeof lockRef !== "object") return false;
  if (isLockHeld(lockRef, ttlMs, now)) return false;
  lockRef.current = now;
  return true;
}

/** Release unconditionally. Safe to call when the lock is already free. */
export function releaseLock(lockRef) {
  if (!lockRef || typeof lockRef !== "object") return;
  lockRef.current = 0;
}
