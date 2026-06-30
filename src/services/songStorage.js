// Persists user-added song metadata in window.localStorage.
//
// We intentionally use the plain Web Storage API (localStorage) instead of
// chrome.storage.local so the persistence contract matches what the spec
// calls "localStorage". Reload of the extension sidepanel/popup keeps the
// list because localStorage is origin-scoped and persistent across browser
// restarts.
//
// The actual blobs (cover, audio, lrc) live in IndexedDB via
// services/assetStorage.ts and services/lrcStorage.ts — this file only
// stores the small JSON metadata the playlist needs.

const STORAGE_KEY = "svdmusic:userSongs";
const MAX_ENTRIES = 200;

const memoryFallback = { current: [] };
const listeners = new Set();

function hasLocalStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch (_) {
    return false;
  }
}

function notify(list) {
  listeners.forEach((cb) => {
    try {
      cb(list);
    } catch (error) {
      console.warn("[songStorage] listener error", error);
    }
  });
}

const LEGACY_BASE = "http://127.0.0.1:5173";

function stripLegacyBase(url) {
  if (typeof url !== "string") return url;
  return url.startsWith(LEGACY_BASE) ? url.slice(LEGACY_BASE.length) : url;
}

function normalizeLegacySong(song) {
  if (!song || typeof song !== "object") return song;
  return {
    ...song,
    audio: stripLegacyBase(song.audio),
    lyrics: stripLegacyBase(song.lyrics),
    cover: stripLegacyBase(song.cover),
    banner: stripLegacyBase(song.banner),
  };
}

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object" && item.id)
    .map((item) => normalizeLegacySong(item))
    .slice(0, MAX_ENTRIES);
}

function readRaw() {
  if (!hasLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn("[songStorage] JSON parse failed, resetting", error);
    return null;
  }
}

function writeRaw(value) {
  if (!hasLocalStorage()) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn("[songStorage] localStorage.setItem failed", error);
    return false;
  }
}

export async function loadUserSongs() {
  const parsed = readRaw();
  const list = sanitize(parsed);
  memoryFallback.current = list;
  return list;
}

export async function appendUserSong(song) {
  if (!song || !song.id) throw new Error("appendUserSong: missing song.id");
  const current = await loadUserSongs();
  const without = current.filter((item) => item.id !== song.id);
  const next = [song, ...without].slice(0, MAX_ENTRIES);
  return persist(next);
}

export async function removeUserSong(id) {
  const current = await loadUserSongs();
  const next = current.filter((item) => item.id !== id);
  return persist(next);
}

/**
 * Best-effort delete for the atomic AddSong rollback path. Accepts either
 * the synthetic song id (`user-{videoId}`) or just the bare videoId; we
 * normalise both shapes so callers don't have to think about the prefix.
 */
export async function removeUserSongByVideoId(videoId) {
  if (!videoId) return loadUserSongs();
  const syntheticId = videoId.startsWith("user-") ? videoId : `user-${videoId}`;
  const current = await loadUserSongs();
  const next = current.filter(
    (item) => item && item.id !== syntheticId && item.id !== videoId
  );
  if (next.length === current.length) return current;
  return persist(next);
}

export async function updateUserSong(id, patch) {
  if (!id) throw new Error("updateUserSong: thiếu id");
  if (!patch || typeof patch !== "object") return loadUserSongs();
  const current = await loadUserSongs();
  const next = current.map((item) =>
    item.id === id ? normalizeLegacySong({ ...item, ...patch }) : item
  );
  return persist(next);
}

export async function clearUserSongs() {
  return persist([]);
}

async function persist(list) {
  const sanitized = sanitize(list);
  memoryFallback.current = sanitized;
  writeRaw(sanitized);
  notify(sanitized);
  return sanitized;
}

export function subscribeUserSongs(cb) {
  listeners.add(cb);
  // Push current value immediately so the UI doesn't wait for the next change.
  try {
    const initial = memoryFallback.current.length
      ? memoryFallback.current
      : sanitize(readRaw() || []);
    memoryFallback.current = initial;
    cb(initial);
  } catch (error) {
    console.warn("[songStorage] initial push failed", error);
  }
  return () => listeners.delete(cb);
}

// ── Favorites (separate from song metadata) ─────────────────────────────
//
// Built-in songs live in src/data/songs.js and shouldn't be mutated, so we
// keep a parallel map { [songId]: true } in localStorage. User-added songs
// still expose `favorite: true|false` on the song object itself for symmetry
// (and to survive list rendering without a second lookup).
const FAVORITES_KEY = "svdmusic:favorites";
const favoritesListeners = new Set();

function readFavoritesRaw() {
  if (!hasLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeFavoritesRaw(value) {
  if (!hasLocalStorage()) return false;
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

function notifyFavorites(map) {
  favoritesListeners.forEach((cb) => {
    try { cb(map); } catch (_) { /* noop */ }
  });
}

export function loadFavorites() {
  return readFavoritesRaw();
}

export function isFavorite(songId) {
  if (!songId) return false;
  return !!readFavoritesRaw()[songId];
}

export function setFavorite(songId, value) {
  if (!songId) return readFavoritesRaw();
  const map = { ...readFavoritesRaw() };
  if (value) map[songId] = true;
  else delete map[songId];
  writeFavoritesRaw(map);
  notifyFavorites(map);
  return map;
}

export function toggleFavorite(songId) {
  if (!songId) return false;
  const next = !isFavorite(songId);
  setFavorite(songId, next);
  return next;
}

export function subscribeFavorites(cb) {
  favoritesListeners.add(cb);
  try { cb(readFavoritesRaw()); } catch (_) { /* noop */ }
  return () => favoritesListeners.delete(cb);
}

// ── Playback state (last-played song + resume time) ───────────────────
//
// Tiny KV record persisted in localStorage so reloading the extension side
// panel returns the user to the exact song and position they were listening
// to. Schema is intentionally minimal — we don't try to recreate full queue
// or audio playback graph, just enough state to seek back into the right
// place on next mount.
const PLAYBACK_KEY = "svdmusic:playback";

function readPlaybackRaw() {
  if (!hasLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(PLAYBACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.songId) return null;
    if (!Number.isFinite(parsed.currentTime)) return null;
    return {
      songId: String(parsed.songId),
      currentTime: Math.max(0, Number(parsed.currentTime)),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch (_) {
    return null;
  }
}

function writePlaybackRaw(value) {
  if (!hasLocalStorage()) return false;
  try {
    window.localStorage.setItem(PLAYBACK_KEY, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Read the last persisted playback record, or `null` when nothing was saved
 * or the record is malformed. Caller is responsible for matching `songId`
 * against the current library before applying `currentTime`.
 */
export function loadPlaybackState() {
  return readPlaybackRaw();
}

export function savePlaybackState(songId, currentTime) {
  if (!songId) return clearPlaybackState();
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return clearPlaybackState();
  }
  writePlaybackRaw({
    songId: String(songId),
    currentTime: Math.max(0, Number(currentTime)),
    updatedAt: Date.now(),
  });
  return true;
}

export function clearPlaybackState() {
  if (!hasLocalStorage()) return false;
  try {
    window.localStorage.removeItem(PLAYBACK_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

// Cross-tab sync: when another tab updates the same key, react.
if (hasLocalStorage() && typeof window.addEventListener === "function") {
  try {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      const next = sanitize(readRaw() || []);
      memoryFallback.current = next;
      notify(next);
    });
  } catch (error) {
    console.warn("[songStorage] cannot listen to storage events", error);
  }
}