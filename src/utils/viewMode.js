// Sidepanel ↔ standalone view-mode plumbing.
//
// Two contexts mount the same React tree:
//   - "sidepanel"  → chrome.sidePanel surface (current default).
//   - "standalone" → regular Chrome tab opened via chrome.tabs.create.
//
// With the popup migration (v1.1.7) standalone is now a popup window
// opened via chrome.windows.create({ type: 'popup' }). The standalone
// URL includes ?view=standalone&surface=popup so the React tree can
// detect which surface it is running on.
// The two contexts must NEVER play audio at the same time and MUST
// preserve the playback snapshot across the transition.
//
// Detection: URL query `?view=standalone`. Anything else → "sidepanel".
// We never rely on viewport width because both surfaces can render at
// similar widths (a narrow tab vs. a wide side panel).
//
// Coordination: BroadcastChannel("svdmusic-player-view") between the
// two contexts. Chrome scope: same browser, same extension. The
// channel is the only thing the two React trees share directly;
// chrome.runtime messages go through the SW.
//
// Ownership model:
//   - On mount, the new instance sends `VIEW_READY` and asks for
//     ownership.
//   - If the other side is alive, it pauses its audio, writes a fresh
//     snapshot, releases ownership, then the new side takes over.
//   - If the other side is gone, ownership transfers automatically.
//   - Only the owner may call audio.play(); the non-owner keeps its
//     <audio> paused but stays mounted (so its UI stays responsive
//     and the next swap is instant).
//
// Snapshot: we reuse the v2 `playbackSessionStorage` schema, plus we
// also broadcast it via the channel for instant transfer. We do NOT
// persist media blobs or object URLs — only ids, timestamps, and
// playback flags.

const CHANNEL_NAME = "svdmusic-player-view";
const VIEW_QUERY_KEY = "view";
const TRANSFER_QUERY_KEY = "transferId";
const SURFACE_QUERY_KEY = "surface";
export const STANDALONE = "standalone";
export const SIDEPANEL = "sidepanel";
const POPUP_SURFACE = "popup";

export const ACTIVE_VIEW_TRANSFER_KEY = "svdmusic.activeViewTransfer";
export const VIEW_OWNER_KEY = "svdmusic.viewOwner";
export const STANDALONE_TAB_ID_KEY = "svdmusic.standaloneTabId";
export const ORIGIN_WINDOW_ID_KEY = "svdmusic.originWindowId";
export const STANDALONE_WINDOW_ID_KEY = "svdmusic.standaloneWindowId";
export const POPUP_BOUNDS_KEY = "svdmusic.popupBounds";
export const VIEW_TRANSFER_TIMEOUT_MS = 10_000;

// Lazy BroadcastChannel — Chrome MV3 supports it but we still gate on
// typeof so a degraded context can no-op without throwing.
let channel = null;
function getChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    return channel;
  } catch (_) {
    return null;
  }
}

function viewModeLog(...args) {
  try {
    console.log("[SVDMusic][ViewMode]", ...args);
  } catch (_) {
    /* noop */
  }
}

function viewModeWarn(...args) {
  try {
    console.warn("[SVDMusic][ViewMode]", ...args);
  } catch (_) {
    /* noop */
  }
}

/**
 * Resolve the current view mode from the document URL. Pure, safe
 * to call from a top-level constant initializer.
 */
export function detectViewMode() {
  if (typeof window === "undefined") return SIDEPANEL;
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get(VIEW_QUERY_KEY) === STANDALONE ? STANDALONE : SIDEPANEL;
  } catch (_) {
    return SIDEPANEL;
  }
}

export function detectPopupSurface() {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get(SURFACE_QUERY_KEY) === POPUP_SURFACE;
  } catch (_) {
    return false;
  }
}

export function getTransferIdFromUrl() {
  if (typeof window === "undefined") return "";
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get(TRANSFER_QUERY_KEY) || "";
  } catch (_) {
    return "";
  }
}

export function isStandaloneView(mode) {
  return mode === STANDALONE;
}

/**
 * URL for the standalone popup. Keep this as the single source of truth
 * so click handlers and the SW open path stay in lockstep.
 */
export function getStandaloneUrl(transferId) {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) {
    return null;
  }
  const params = new URLSearchParams({ view: STANDALONE, surface: POPUP_SURFACE });
  if (transferId) params.set(TRANSFER_QUERY_KEY, transferId);
  return chrome.runtime.getURL(`sidepanel.html?${params.toString()}`);
}

export function createViewTransfer({
  transferId,
  sourceMode,
  targetMode,
  sourceInstanceId,
  originWindowId = null,
  standaloneTabId = null,
  standaloneWindowId = null,
}) {
  return {
    transferId,
    sourceMode,
    targetMode,
    sourceInstanceId,
    originWindowId,
    standaloneTabId,
    standaloneWindowId,
    status: "preparing",
    createdAt: Date.now(),
  };
}

export async function readSessionValue(key) {
  if (typeof chrome === "undefined" || !chrome.storage?.session) return null;
  const result = await chrome.storage.session.get(key);
  return result?.[key] ?? null;
}

export async function writeSessionValue(key, value) {
  if (typeof chrome === "undefined" || !chrome.storage?.session) {
    throw new Error("chrome.storage.session unavailable");
  }
  await chrome.storage.session.set({ [key]: value });
  return value;
}

export async function removeSessionValue(key) {
  if (typeof chrome === "undefined" || !chrome.storage?.session) return;
  await chrome.storage.session.remove(key);
}

export function readActiveViewTransfer() {
  return readSessionValue(ACTIVE_VIEW_TRANSFER_KEY);
}

export function writeActiveViewTransfer(transfer) {
  return writeSessionValue(ACTIVE_VIEW_TRANSFER_KEY, transfer);
}

export async function updateActiveViewTransfer(transferId, updates) {
  const active = await readActiveViewTransfer();
  if (!active || active.transferId !== transferId) return null;
  const next = { ...active, ...updates };
  await writeActiveViewTransfer(next);
  return next;
}

/**
 * Atomic upsert: write the patch only if the session entry either
 * matches `transferId` or is currently empty. Returns the resulting
 * transfer object on success, null when another active transfer has
 * already taken the slot.
 *
 * Use this when you need to self-heal a dropped session entry without
 * accidentally clobbering a newer transfer that was created in the
 * meantime (e.g. user detached twice in a row).
 */
export async function upsertActiveViewTransfer(transferId, fallback, updates) {
  const active = await readActiveViewTransfer();
  if (active && active.transferId !== transferId) return null;
  const base = active || fallback || { transferId };
  const next = { ...base, ...updates, transferId };
  await writeActiveViewTransfer(next);
  return next;
}

export async function clearActiveViewTransfer(transferId) {
  const active = await readActiveViewTransfer();
  if (!active || active.transferId !== transferId) return false;
  await removeSessionValue(ACTIVE_VIEW_TRANSFER_KEY);
  return true;
}

/**
 * Send a typed message on the view-mode channel. Returns true when
 * the message was dispatched, false when the channel is unavailable
 * (e.g. SSR / non-extension context).
 */
export function postViewMessage(type, payload) {
  const ch = getChannel();
  if (!ch) return false;
  try {
    ch.postMessage({ type, payload, at: Date.now() });
    return true;
  } catch (err) {
    viewModeWarn("postViewMessage failed", type, err);
    return false;
  }
}

/**
 * Subscribe to view-mode messages. Returns an unsubscribe function.
 *
 * Handler receives the full message envelope `{ type, payload, at }`.
 */
export function subscribeViewMessages(handler) {
  const ch = getChannel();
  if (!ch || typeof handler !== "function") return () => {};
  const listener = (event) => {
    try {
      handler(event?.data || {});
    } catch (err) {
      viewModeWarn("view-message handler threw", err);
    }
  };
  ch.addEventListener("message", listener);
  return () => {
    try {
      ch.removeEventListener("message", listener);
    } catch (_) {
      /* noop */
    }
  };
}

/**
 * Build the playback snapshot we'll hand to the next view. Mirrors
 * the v2 schema in `playbackSessionStorage.js` plus a view tag.
 */
export function buildPlaybackSnapshot({
  activeSong,
  currentTime,
  duration,
  isPlaying,
  volume,
  repeatMode,
  isShuffle,
  isMuted,
}) {
  const songId =
    activeSong?.id || activeSong?.videoId
      ? String(activeSong.id || activeSong.videoId)
      : "";
  const safeTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 78;
  return {
    songId,
    videoId: activeSong?.videoId ? String(activeSong.videoId) : "",
    currentTime: safeTime,
    duration: safeDuration,
    isPlaying: Boolean(isPlaying),
    volume: safeVolume,
    muted: Boolean(isMuted),
    repeat: repeatMode === "one" || repeatMode === "all" ? repeatMode : "off",
    shuffle: Boolean(isShuffle),
    updatedAt: Date.now(),
  };
}

/**
 * Apply a snapshot to live React state. We deliberately do NOT touch
 * `currentIndex` / `currentSong` here — those are derived from the
 * library effect on mount. This helper is for the *post-mount* updates
 * that happen after the audio src is resolved.
 */
export function isMeaningfulSnapshot(snap) {
  if (!snap || typeof snap !== "object") return false;
  if (!snap.songId) return false;
  if (!Number.isFinite(snap.currentTime)) return false;
  return true;
}

/**
 * Tiny test helper — exported so debug code can poke the channel from
 * DevTools without rebuilding. Always available, never logs on its
 * own.
 */
export function __viewModeDebug() {
  return {
    mode: detectViewMode(),
    isPopupSurface: detectPopupSurface(),
    hasChannel: Boolean(getChannel()),
    channelName: CHANNEL_NAME,
  };
}

export { viewModeLog, viewModeWarn };