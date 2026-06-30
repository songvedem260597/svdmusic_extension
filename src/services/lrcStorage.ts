// LRC text storage using IndexedDB.
// Keyed by `lrc:{videoId}` so the playlist item can keep a tiny reference
// (`lyricsTextKey`) instead of copying the full LRC into the song metadata.
//
// The app reads from this DB first when loading lyrics, then falls back to
// `fetch(song.lyrics)` (which loads the file from the bundled public folder).
//
// Persists across browser restarts.

const DB_NAME = "svdmusic-lrc-text";
const DB_VERSION = 1;
const STORE_NAME = "lrc";

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

/**
 * Saves LRC text for the given videoId. Overwrites existing entry.
 *
 * @param {string} videoId
 * @param {string} lrcText
 */
export async function saveLrcText(videoId, lrcText) {
  if (!videoId) throw new Error("saveLrcText: thiếu videoId");
  if (typeof lrcText !== "string") throw new Error("saveLrcText: lrcText không phải chuỗi");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      key: "lrc:" + videoId,
      videoId,
      text: lrcText,
      savedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Loads LRC text for the given videoId. Returns null if not found.
 *
 * @param {string} videoId
 * @returns {Promise<string|null>}
 */
export async function loadLrcText(videoId) {
  if (!videoId) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get("lrc:" + videoId);
    req.onsuccess = () => resolve(req.result?.text ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Loads LRC text by composite key (e.g. `lrc:OmqWQ-W0mjI`). Returns null
 * if key is malformed or text is absent.
 *
 * @param {string} compositeKey
 * @returns {Promise<string|null>}
 */
export async function loadLrcByKey(compositeKey) {
  if (!compositeKey || typeof compositeKey !== "string") return null;
  const idx = compositeKey.indexOf(":");
  if (idx <= 0) return null;
  const kind = compositeKey.slice(0, idx);
  if (kind !== "lrc") return null;
  return loadLrcText(compositeKey.slice(idx + 1));
}

/** Removes the LRC text for the given videoId. */
export async function deleteLrcText(videoId) {
  if (!videoId) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete("lrc:" + videoId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Lists all stored videoIds. */
export async function listStoredVideoIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => {
      const keys = req.result || [];
      const ids = keys
        .filter((k) => typeof k === "string" && k.startsWith("lrc:"))
        .map((k) => k.slice(4));
      resolve(ids);
    };
    req.onerror = () => reject(req.error);
  });
}