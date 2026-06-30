// IndexedDB storage for user-added song assets (cover + audio).
//
// Each asset is keyed by `${kind}:${videoId}` so the playlist item only needs
// to keep a tiny reference (`audioKey`, `coverKey`) instead of inlining the
// blob into metadata. The app reads from this DB at playback time and turns
// the resulting Blob into an object URL via URL.createObjectURL().
//
// IMPORTANT: This DB is the runtime source of truth for user-added songs.
// The extension must NOT depend on files under Downloads/Documents/uploads
// to play these songs — the blobs in here are what `<audio src=...>` and
// `<img src=...>` consume.

import { deleteLrcText } from "./lrcStorage";
import { removeUserSongByVideoId } from "./songStorage.js";

const DB_NAME = "svdmusic-user-assets";
const DB_VERSION = 1;
const STORE_NAME = "assets";

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB không khả dụng trong môi trường này."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
  });
}

function withStore(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let result;
        Promise.resolve(fn(store))
          .then((value) => {
            result = value;
          })
          .catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Saves a Blob asset under the given composite key (e.g. `audio:OmqWQ-W0mjI`
 * or `cover:OmqWQ-W0mjI`). Overwrites any existing entry.
 *
 * @param {string} kind - "audio" | "cover" | anything you want, but stick to the spec.
 * @param {string} videoId
 * @param {Blob} blob
 */
export async function saveAsset(kind, videoId, blob) {
  if (!kind) throw new Error("saveAsset: thiếu kind");
  if (!videoId) throw new Error("saveAsset: thiếu videoId");
  if (!(blob instanceof Blob)) {
    throw new Error("saveAsset: blob không hợp lệ");
  }
  const key = `${kind}:${videoId}`;
  return withStore("readwrite", (store) =>
    new Promise((resolve, reject) => {
      const req = store.put({ key, kind, videoId, blob, savedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })
  );
}

/**
 * Loads a Blob asset. Returns null when missing.
 *
 * @param {string} kind
 * @param {string} videoId
 * @returns {Promise<Blob|null>}
 */
export async function loadAsset(kind, videoId) {
  if (!kind || !videoId) return null;
  const key = `${kind}:${videoId}`;
  return withStore("readonly", (store) =>
    new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.blob ?? null);
      req.onerror = () => reject(req.error);
    })
  );
}

/**
 * Loads a Blob and converts it to an object URL on the fly. Caller is
 * responsible for revoking the URL when no longer needed (track via the
 * returned `revoke` function).
 *
 * @param {string} kind
 * @param {string} videoId
 * @returns {Promise<{ url: string|null, revoke: () => void }>}
 */
export async function loadAssetAsObjectURL(kind, videoId) {
  let revoke = () => {};
  try {
    const blob = await loadAsset(kind, videoId);
    if (!blob) return { url: null, revoke };
    const url = URL.createObjectURL(blob);
    revoke = () => {
      try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
    };
    return { url, revoke };
  } catch (error) {
    console.warn(`[assetStorage] loadAssetAsObjectURL(${kind}:${videoId}) failed`, error);
    return { url: null, revoke };
  }
}

/**
 * Loads a Blob asset by composite key (e.g. `audio:OmqWQ-W0mjI`). The key
 * shape is `<kind>:<videoId>` — the spec for storage.
 *
 * @param {string} compositeKey
 * @returns {Promise<Blob|null>}
 */
export async function loadAssetByKey(compositeKey) {
  if (!compositeKey || typeof compositeKey !== "string") return null;
  const idx = compositeKey.indexOf(":");
  if (idx <= 0) return null;
  const kind = compositeKey.slice(0, idx);
  const videoId = compositeKey.slice(idx + 1);
  return loadAsset(kind, videoId);
}

/**
 * Same as loadAssetByKey but wraps the blob into an object URL and returns
 * the revoke function so callers can free memory when swapping songs.
 *
 * @param {string} compositeKey
 * @returns {Promise<{ url: string|null, revoke: () => void, kind: string|null, videoId: string|null }>}
 */
export async function loadAssetByKeyAsObjectURL(compositeKey) {
  let revoke = () => {};
  let kind = null;
  let videoId = null;
  try {
    if (!compositeKey || typeof compositeKey !== "string") {
      return { url: null, revoke, kind, videoId };
    }
    const idx = compositeKey.indexOf(":");
    if (idx <= 0) return { url: null, revoke, kind, videoId };
    kind = compositeKey.slice(0, idx);
    videoId = compositeKey.slice(idx + 1);
    const blob = await loadAsset(kind, videoId);
    if (!blob) return { url: null, revoke, kind, videoId };
    const url = URL.createObjectURL(blob);
    revoke = () => {
      try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
    };
    return { url, revoke, kind, videoId };
  } catch (error) {
    console.warn(`[assetStorage] loadAssetByKeyAsObjectURL(${compositeKey}) failed`, error);
    return { url: null, revoke, kind, videoId };
  }
}

/**
 * Internal helper: removes a single asset row from the store. No-op if
 * missing; rejects on transaction failure.
 */
function deleteAsset(kind, videoId) {
  if (!kind || !videoId) return Promise.resolve();
  const key = `${kind}:${videoId}`;
  return withStore("readwrite", (store) =>
    new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })
  );
}

/**
 * Removes a single asset by composite key (e.g. `audio:OmqWQ-W0mjI`).
 * Safe on missing keys / malformed input.
 */
export async function deleteAssetByKey(compositeKey) {
  if (!compositeKey || typeof compositeKey !== "string") return false;
  const idx = compositeKey.indexOf(":");
  if (idx <= 0) return false;
  try {
    await deleteAsset(compositeKey.slice(0, idx), compositeKey.slice(idx + 1));
    return true;
  } catch (error) {
    console.warn(`[assetStorage] deleteAssetByKey(${compositeKey}) failed`, error);
    return false;
  }
}

/** Saves a Blob asset by composite key. Throws on missing/malformed key. */
export async function saveAssetByKey(compositeKey, blob) {
  if (!compositeKey || typeof compositeKey !== "string") {
    throw new Error("saveAssetByKey: compositeKey không hợp lệ");
  }
  const idx = compositeKey.indexOf(":");
  if (idx <= 0) {
    throw new Error("saveAssetByKey: compositeKey phải có dạng '<kind>:<videoId>'");
  }
  return saveAsset(compositeKey.slice(0, idx), compositeKey.slice(idx + 1), blob);
}

/** Removes every asset belonging to a videoId (cover + audio + lyrics variants + LRC text). */
export async function deleteAllAssetsForVideo(videoId) {
  if (!videoId) return;
  await Promise.allSettled([
    deleteAsset("audio", videoId),
    deleteAsset("cover", videoId),
    deleteAsset("lyrics", videoId),
    deleteAsset("lyricsText", videoId),
    deleteLrcText(videoId),
  ]);
}

/**
 * Atomic-rollback helper for the AddSong flow.
 *
 * Deletes every per-video asset we know about, in addition to any extra
 * composite keys the caller passed in. We intentionally resolve (never
 * reject) so the rollback path stays best-effort: if one key is already
 * gone, or the IndexedDB transaction glitches, we still continue and try
 * the rest. The whole point of rollback is that the user-visible state
 * ends up clean — we don't want one missing row to abort the cleanup and
 * leak the rest.
 *
 * @param {string} videoId
 * @param {string[]} [extraKeys] additional composite keys (e.g. legacy
 *   `lyrics:{videoId}` rows) the caller wants removed in the same pass.
 * @returns {Promise<{ removed: string[], failed: { key: string, error: string }[] }>}
 */
export async function rollbackAddSongAssets(videoId, extraKeys = []) {
  const result = { removed: [], failed: [] };
  if (!videoId) return result;
  const baseKeys = [
    `cover:${videoId}`,
    `lrc:${videoId}`,
    `audio:${videoId}`,
    `lyricsText:${videoId}`,
    `lyrics:${videoId}`,
  ];
  const allKeys = [...new Set([...baseKeys, ...(Array.isArray(extraKeys) ? extraKeys : [])])]
    .filter((key) => typeof key === "string" && key.length > 0);

  for (const key of allKeys) {
    try {
      // The LRC text lives in a separate DB (lrcStorage) — `deleteAssetByKey`
      // only touches the asset store, so we route the `lrc:` prefix through
      // deleteLrcText() ourselves and skip the asset store for those keys.
      if (key.startsWith("lrc:")) {
        await deleteLrcText(key.slice(4));
      } else {
        const ok = await deleteAssetByKey(key);
        if (!ok) {
          // already gone / nothing to do — treat as success
        }
      }
      result.removed.push(key);
      console.log("[AddSongRollback] deleted", key);
    } catch (error) {
      const msg = error?.message || String(error);
      result.failed.push({ key, error: msg });
      console.warn("[AddSongRollback] delete failed", key, msg);
    }
  }

  // Best-effort: also remove any userSongs entry the rollback might have
  // already created (defence-in-depth — the modal normally never persists
  // a song when an asset write fails, but a crash between asset write and
  // appendUserSong could leave one dangling).
  try {
    await removeUserSongByVideoId(videoId);
  } catch (error) {
    console.warn(
      "[AddSongRollback] removeUserSongByVideoId failed",
      videoId,
      error?.message || error
    );
  }

  return result;
}

/** Lists every stored videoId that has at least one asset. */
export async function listStoredVideoIds() {
  return withStore("readonly", (store) =>
    new Promise((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const ids = new Set();
        for (const key of req.result || []) {
          if (typeof key !== "string") continue;
          const idx = key.indexOf(":");
          if (idx <= 0) continue;
          ids.add(key.slice(idx + 1));
        }
        resolve(Array.from(ids));
      };
      req.onerror = () => reject(req.error);
    })
  );
}