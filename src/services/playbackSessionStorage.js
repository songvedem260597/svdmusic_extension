// Persists the user's last-played song + resume timestamp across
// extension reloads / sidepanel reopens.
//
// The schema is intentionally versioned (`version: 1`) so future shape
// changes can either migrate or skip the record. We store the *songId*
// (and its bare `videoId` companion) rather than a list-index, because
// the merged `allSongs` list can shuffle at any time (Add Song, deletion,
// library import, etc.) and index-based restoration would jump to the
// wrong track.
//
// Storage backend: `window.localStorage` (origin-scoped, persistent
// across browser restarts). The sidepanel extension popup shares the
// same origin so this Just Works without an extra wrapper.
//
// Debug verbosity is gated by `svdmusic:debug:playback` in localStorage
// (see App.jsx for the matching gate). Real errors / parse failures
// still log via console.warn regardless of the gate.

// v1 schema: { version: 1, songId, videoId, currentTime, duration, updatedAt }
// v2 schema: { version: 2, songId, videoId, currentTime, duration,
//              volume, muted, shuffle, repeat, isPlaying, updatedAt }
//
// v2 adds the extended playback state we need to keep the user experience
// consistent when the player swaps between sidepanel and standalone tabs:
//   - volume / muted  (was hard-coded to 78 / false before)
//   - shuffle / repeat
//   - isPlaying (used to decide whether to autoplay after a swap)
//
// Backward compatibility: reading a v1 record returns null for the new
// fields and the App.jsx restore flow fills in the defaults. We never
// silently downgrade a v2 record to v1.

const PLAYBACK_SESSION_KEY = "svdmusic:playback-session:v1";
const PLAYBACK_SESSION_VERSION = 2;

function readDebugFlag() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem("svdmusic:debug:playback") === "1";
  } catch (_) {
    return false;
  }
}
const DEBUG = readDebugFlag();

function debugLog(...args) {
  if (!DEBUG) return;
  try { console.log("[PlaybackSession:storage]", ...args); } catch (_) { /* noop */ }
}

function hasLocalStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch (_) {
    return false;
  }
}

function readRaw() {
  if (!hasLocalStorage()) {
    // No localStorage is a runtime anomaly (extension popup always has
    // it); keep this on console.warn so a degraded mode is visible.
    console.warn("[PlaybackSession:storage] load skip: no localStorage");
    return null;
  }
  let raw = null;
  try {
    raw = window.localStorage.getItem(PLAYBACK_SESSION_KEY);
  } catch (err) {
    console.warn("[PlaybackSession:storage] load readItem failed", err);
    return null;
  }
  debugLog("load raw=", raw);
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[PlaybackSession:storage] load parse failed", err);
    return null;
  }
  debugLog("load parsed=", parsed);
  if (!parsed || typeof parsed !== "object") {
    console.warn("[PlaybackSession:storage] load invalid: not an object");
    return null;
  }
  if (!parsed.songId) {
    console.warn("[PlaybackSession:storage] load invalid: missing songId");
    return null;
  }
  if (!Number.isFinite(parsed.currentTime)) {
    console.warn(
      "[PlaybackSession:storage] load invalid: currentTime not finite",
      parsed.currentTime
    );
    return null;
  }
  const normalized = {
    version: PLAYBACK_SESSION_VERSION,
    songId: String(parsed.songId),
    videoId: parsed.videoId ? String(parsed.videoId) : "",
    currentTime: Math.max(0, Number(parsed.currentTime)),
    duration: Number.isFinite(parsed.duration) ? Math.max(0, Number(parsed.duration)) : 0,
    // v2 additions — null when reading a v1 record so the App.jsx restore
    // flow can apply defaults without us overloading the schema check above.
    volume: Number.isFinite(parsed.volume) ? clampVolume(parsed.volume) : null,
    muted: typeof parsed.muted === "boolean" ? parsed.muted : null,
    shuffle: typeof parsed.shuffle === "boolean" ? parsed.shuffle : null,
    repeat:
      parsed.repeat === "off" || parsed.repeat === "one" || parsed.repeat === "all"
        ? parsed.repeat
        : null,
    isPlaying: typeof parsed.isPlaying === "boolean" ? parsed.isPlaying : null,
    updatedAt: Number(parsed.updatedAt) || Date.now(),
  };
  debugLog("load normalized=", normalized);
  return normalized;
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function writeRaw(value) {
  if (!hasLocalStorage()) {
    console.warn("[PlaybackSession:storage] save skip: no localStorage");
    return false;
  }
  try {
    const json = JSON.stringify(value);
    debugLog("save json=", json);
    window.localStorage.setItem(PLAYBACK_SESSION_KEY, json);
    return true;
  } catch (err) {
    console.warn("[PlaybackSession:storage] save failed", err);
    return false;
  }
}

/**
 * Read the last persisted playback session, or `null` when nothing was
 * saved or the record is malformed. The caller is responsible for matching
 * `songId` (or `videoId`) against the current library before applying
 * `currentTime`.
 */
export function loadPlaybackSession() {
  const session = readRaw();
  debugLog("load result", session ? "ok" : "null");
  return session;
}

/**
 * Persist the currently playing song and resume timestamp.
 *
 * Skips silently when:
 *   - `songId` is empty
 *   - `currentTime` is not a finite number
 *   - `currentTime` is negative
 *
 * `videoId` and `duration` are optional but recommended — `videoId`
 * gives us a fallback match key for user songs whose id has a
 * `user-` prefix, and `duration` lets the caller clamp the resume
 * position before applying it to the audio element.
 */
export function savePlaybackSession(session) {
  debugLog("save called", session);
  if (!session || typeof session !== "object") {
    console.warn("[PlaybackSession:storage] save invalid: not an object");
    return clearPlaybackSession("save-invalid-session");
  }
  const songId = session.songId ? String(session.songId) : "";
  if (!songId) {
    console.warn("[PlaybackSession:storage] save invalid: missing songId");
    return clearPlaybackSession("save-missing-songId");
  }
  if (!Number.isFinite(session.currentTime) || session.currentTime < 0) {
    console.warn(
      "[PlaybackSession:storage] save invalid: bad currentTime",
      session.currentTime
    );
    return clearPlaybackSession("save-bad-currentTime");
  }
  const payload = {
    version: PLAYBACK_SESSION_VERSION,
    songId,
    videoId: session.videoId ? String(session.videoId) : "",
    currentTime: Math.max(0, Number(session.currentTime)),
    duration: Number.isFinite(session.duration)
      ? Math.max(0, Number(session.duration))
      : 0,
    // v2 additions. Any unknown / missing value is dropped from the payload
    // rather than written as null so a later read sees `null` and applies
    // the matching default. This keeps the on-disk record minimal when a
    // caller intentionally only writes the v1 subset.
    volume: clampVolume(session.volume),
    muted: typeof session.muted === "boolean" ? session.muted : undefined,
    shuffle: typeof session.shuffle === "boolean" ? session.shuffle : undefined,
    repeat:
      session.repeat === "off" || session.repeat === "one" || session.repeat === "all"
        ? session.repeat
        : undefined,
    isPlaying: typeof session.isPlaying === "boolean" ? session.isPlaying : undefined,
    updatedAt: Date.now(),
  };
  // Strip undefined keys — JSON.stringify already drops them, but doing it
  // explicitly keeps the debug log readable.
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });
  debugLog("save commit", payload);
  writeRaw(payload);
  return true;
}

export function clearPlaybackSession(reason) {
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    console.warn(
      "[PlaybackSession:storage] clear called without reason — caller should pass an explicit tag (deleted-active-song / deleted-session-song / manual-debug / library-empty-after-hydration / save-invalid-session / save-missing-songId / save-bad-currentTime / restore-song-not-found)"
    );
  }
  const why = (reason && typeof reason === "string" && reason.trim()) || "unspecified";
  debugLog("clear reason=", why);
  if (!hasLocalStorage()) {
    console.warn("[PlaybackSession:storage] clear skip: no localStorage");
    return false;
  }
  try {
    window.localStorage.removeItem(PLAYBACK_SESSION_KEY);
    debugLog("clear ok reason=", why);
    return true;
  } catch (err) {
    console.warn("[PlaybackSession:storage] clear failed", err);
    return false;
  }
}

export const PLAYBACK_SESSION_STORAGE_KEY = PLAYBACK_SESSION_KEY;
export const PLAYBACK_SESSION_SCHEMA_VERSION = PLAYBACK_SESSION_VERSION;