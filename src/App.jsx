import {
  Headphones,
  ListMusic,
  Mic,
  Pause,
  Play,
  Plus,
  Repeat,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { findActiveLyricIndex, parseLrc } from "./utils/lyrics.js";
import { formatTime } from "./utils/time.js";
import { matchSongQuery } from "./utils/textSearch.js";
import { loadUserSongs, subscribeFavorites, subscribeUserSongs } from "./services/songStorage.js";
import {
  loadPlaybackSession,
  savePlaybackSession,
  clearPlaybackSession,
} from "./services/playbackSessionStorage.js";
import { loadLrcByKey } from "./services/lrcStorage.ts";
import {
  loadAssetByKeyAsObjectURL,
} from "./services/assetStorage.ts";
import AddSongButton from "./components/AddSongButton.jsx";
import AddSongModal from "./components/AddSongModal.jsx";
import SongContextMenu from "./components/SongContextMenu.jsx";
import SettingsModal, {
  SettingsButton,
  useAppSettings,
} from "./components/SettingsModal.jsx";
import SongLibraryPopover from "./components/SongLibraryPopover.jsx";
import WeatherWidget from "./components/WeatherWidget.jsx";
import { getMoodQuote } from "./services/moodQuoteApi.js";
import {
  startBassReactiveCover,
  pauseBassReactiveCover,
  resumeBassReactiveCover,
  disposeBassReactiveCover,
} from "./utils/bassReactiveCover.js";

const COVER_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect fill='%231e3a5f' width='200' height='200'/%3E%3Ccircle cx='100' cy='100' r='60' fill='none' stroke='%2300ffb3' stroke-width='4'/%3E%3Ccircle cx='100' cy='100' r='8' fill='%2300ffb3'/%3E%3C/svg%3E";
const BANNER_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1280 720'%3E%3Crect fill='%230b1220' width='1280' height='720'/%3E%3C/svg%3E";
const LOGO_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 150 40'%3E%3Ctext x='0' y='29' font-family='Lexend,sans-serif' font-weight='700' font-size='22' fill='%2300ffb3'%3ESVD%3C/text%3E%3Ctext x='52' y='29' font-family='Lexend,sans-serif' font-weight='300' font-size='22' fill='%23ececec'%3EMusic%3C/text%3E%3C/svg%3E";

function setImageFallback(img, fallback) {
  if (!img || img.dataset._svdFallbackMarked) return;
  img.dataset._svdFallbackMarked = "1";
  img.src = fallback;
}

const SEEK_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp"]);
const PERSIST_THROTTLE_MS = 1500;

function clampTime(value, max) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(safeValue, 0), safeMax);
}

// Debug gates. All toggled at runtime via localStorage so we don't have
// to rebuild to silence the console. Default off; turn on for one
// session by setting the key to "1" and reloading the sidepanel.
//
//   localStorage.setItem("svdmusic:debug:playback", "1"); location.reload();
//   localStorage.setItem("svdmusic:debug:lrc", "1");     location.reload();
//
// Only verbose "[PlaybackSession]" / "[LRC]" chatter is gated —
// recovery paths and real errors still log via console.warn /
// console.error even when the gate is off.
function readDebugFlag(key) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(key) === "1";
  } catch (_) {
    return false;
  }
}
const PLAYBACK_SESSION_DEBUG = readDebugFlag("svdmusic:debug:playback");
const LRC_DEBUG = readDebugFlag("svdmusic:debug:lrc");

function playbackDebugLog(...args) {
  if (!PLAYBACK_SESSION_DEBUG) return;
  try {
    console.log("[PlaybackSession]", ...args);
  } catch (_) { /* noop */ }
}
function playbackDebugWarn(...args) {
  if (!PLAYBACK_SESSION_DEBUG) return;
  try {
    console.warn("[PlaybackSession]", ...args);
  } catch (_) { /* noop */ }
}

function App() {
  const audioRef = useRef(null);
  const lyricsBoxRef = useRef(null);
  const lyricLineRefs = useRef([]);
  const ignoreNextPlayClickRef = useRef(false);
  const isLyricAutoScrollingRef = useRef(false);
  const isLyricUserScrollingRef = useRef(false);
  const pendingPlayRef = useRef(false);
  const lyricAutoScrollTimerRef = useRef(null);
  const lyricFollowResumeTimerRef = useRef(null);
  const lyricSyncRafRef = useRef(null);
  const lyricsRef = useRef([]);
  const activeLyricIndexRef = useRef(-1);
  // Cached last currentTime we propagated into React state. Used to skip
  // 60fps setCurrentTime calls when the audio hasn't advanced meaningfully.
  const currentTimeRef = useRef(0);
  // Debug-only: tracks the last activeLyricIndex we actually rendered so
  // the render path can log when the visible line changes.
  const activeLyricIndexDebugRef = useRef(-1);
  // One-shot restore guard: we only attempt to seek the audio back to the
  // last persisted position ONCE per App mount (on extension reload).
  const restoredOnceRef = useRef(false);
  // Throttle helper for persisting currentTime. We write at most every
  // ~1.5s during playback and immediately on pause / unmount.
  const lastPersistedTimeRef = useRef(0);
  const lastPersistedSongIdRef = useRef(null);
  // Holds the playback record we're trying to apply once the matching audio
  // src is loaded. Cleared in `handleLoadedMetadata` after seek attempt.
  const pendingRestoreRef = useRef(null);
  // True between "we stashed a pending restore" and "we successfully seeked
  // the audio back to that timestamp". While in this window we MUST NOT
  // let any save path run — otherwise the polling tick or song-change
  // effect would record the freshly-zeroed audio position and overwrite
  // the saved session before the restore actually lands.
  const restoreInProgressRef = useRef(false);
  // Flipped to true the instant `audio.currentTime = clampedTime` runs
  // without throwing. Once true, normal save logic can resume.
  const restoreAppliedRef = useRef(false);
  // Tracks the currentTime we *successfully* applied via the restore
  // branch. Used by the audio tick path to detect "restored, then
  // immediately reset to 0" regressions.
  const lastAppliedRestoreTimeRef = useRef(null);
  // Live snapshots of `currentSong` and `currentTime` updated on every
  // render. Used by the unmount cleanup to write the actual latest values
  // (not stale closure captures from the initial render where the cleanup
  // was registered).
  const currentSongSnapshotRef = useRef(null);
  const currentTimeSnapshotRef = useRef(0);
  // Timestamp of the most recent successful session save. Used to throttle
  // visibility/pagehide/beforeunload saves — no point rewriting the same
  // record we already wrote 200ms ago.
  const lastPlaybackSaveRef = useRef(0);
  // Flag flipped to `true` once the user-songs subscription has produced
  // its first real snapshot (initial loadUserSongs + storage subscription).
  // Until then, an empty `allSongs` is "loading" — not "library truly
  // empty". This guard stops the empty-library effect from clobbering a
  // freshly-loaded playback session on first mount.
  const libraryHydratedRef = useRef(false);

  // Mount-time diagnostic — runs exactly once via useEffect([]), NOT on
  // every render. (Earlier revisions put the log in the render body which
  // fired on every state update and produced dozens of "App mounted" lines
  // in DevTools.)
  useEffect(() => {
    playbackDebugLog("App mounted", {
      url: typeof window !== "undefined" ? window.location.href : "(no window)",
      time: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "(no navigator)",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [query, setQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [viewMode, setViewMode] = useState("list"); // "list" | "lyrics"
  const [userSongs, setUserSongs] = useState([]);
  const [isAddSongOpen, setIsAddSongOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [favoritesMap, setFavoritesMap] = useState({});

  // Merged song list (built-in + user-added). Declared up here — before
  // any useEffect whose deps array references `allSongs` — because
  // `useEffect(fn, [allSongs])` evaluates the deps array *immediately*
  // during component body execution, which would throw "Cannot access
  // 'allSongs' before initialization" if this useMemo ran later in the
  // body. See playback-persistence effects below.
  const allSongs = useMemo(() => {
    const seen = new Set();
    const merged = [];
    for (const song of userSongs) {
      if (!song || !song.id || seen.has(song.id)) continue;
      seen.add(song.id);
      merged.push(song);
    }
    return merged;
  }, [userSongs]);

  // Currently playing index + currently selected song. Declared up here
  // — right after `allSongs` — BEFORE any useEffect whose deps array
  // references `currentSong` or `currentSong?.id`. The persist effect
  // (`}, [currentSong?.id, isPlaying])`) sits at line ~298 below and
  // would throw "Cannot access 'currentSong' before initialization" if
  // this const ran later. `currentSong = allSongs[currentIndex]` mirrors
  // the previous in-place derivation; same shape, just hoisted.
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentSong = allSongs[currentIndex];

  // ═══ Consolidated state + refs block ═══
  //
  // EVERY `useState`/`useRef` declared anywhere in the App component body
  // is hoisted up here (right after `allSongs` + `currentSong` derivation)
  // so that downstream `useEffect(..., [deps])` calls can safely read
  // those identifiers in their dependency arrays.
  //
  // Why this matters: React evaluates the dependency array of
  // `useEffect(fn, [deps])` IMMEDIATELY at the call site — not when the
  // effect fires. If the deps reference a `const` that hasn't been
  // declared yet at that point in the function body, JS throws
  // "Cannot access '<var>' before initialization" (TDZ). The persist
  // effect (`[currentSong?.id, isPlaying]`) below is the canonical
  // example: `isPlaying` must already be declared by the time the
  // effect's deps array is evaluated.
  //
  // Ordering convention:
  //   1. ALL useState / useRef declarations (this block).
  //   2. Custom hooks (useAppSettings) and derived constants.
  //   3. useMemo derivations.
  //   4. useEffect calls + handler functions + render.

  // Context menu state.
  const [contextMenu, setContextMenu] = useState(null);

  // User-added cover object URLs (resolved from IndexedDB).
  const [userCoverUrls, setUserCoverUrls] = useState({});

  // Lyrics playback state.
  const [lyrics, setLyrics] = useState([]);
  const [activeLyricIndex, setActiveLyricIndex] = useState(-1);

  // Player core state. `isPlaying` lives here because the persist effect
  // below keys on it.
  const [isPlaying, setIsPlaying] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState("off");
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreviewTime, setSeekPreviewTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(78);

  // Volume history refs (not state — kept side-by-side for completeness).
  const previousVolumeRef = useRef(78);
  const isMutedRef = useRef(false);

  // Seek state refs.
  const isSeekingRef = useRef(false);
  const pendingSeekTimeRef = useRef(0);

  // Lyric auto-follow ticks + status string.
  const [lyricFollowResumeTick, setLyricFollowResumeTick] = useState(0);
  const [lyricStatus, setLyricStatus] = useState("Đang tải lời bài hát...");

  // Asset URLs resolved from IndexedDB for user-added songs (or kept as-is
  // for bundled songs).
  const [resolvedAudioUrl, setResolvedAudioUrl] = useState("");
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState("");
  const [resolvedBannerUrl, setResolvedBannerUrl] = useState("");
  const [audioMissing, setAudioMissing] = useState(false);
  const [audioLoadError, setAudioLoadError] = useState("");

  // Revokers for the object URLs above; populated lazily by the asset
  // resolution effect below.
  const revokeAudioUrlRef = useRef(() => {});
  const revokeCoverUrlRef = useRef(() => {});
  const revokeBannerUrlRef = useRef(() => {});

  // Typing animation display for the mood-quote line.
  const [typingDisplay, setTypingDisplay] = useState("");

  const settings = useAppSettings({ isLyricsView: viewMode === "lyrics" });
  const {
    theme,
    setTheme,
    backgroundGallery,
    activeBackgroundId,
    activeBackgroundImage,
    backgroundOpacity,
    setBackgroundOpacity,
    handleAddBackgroundImages,
    handleSelectBackgroundImage,
    handleDeleteBackgroundImage,
    autoRotateBackground,
    setAutoRotateBackground,
  } = settings;

  function handleSongContextMenu(event, song) {
    event.preventDefault();
    event.stopPropagation();
    if (!song || !song.id) return;
    setContextMenu({
      song,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handleCloseContextMenu() {
    setContextMenu(null);
  }

  function handleSongDeleted({ songId }) {
    // Pause + reset player if the deleted song is the active one. The
    // userSongs subscription in the existing useEffect will rebuild the
    // merged list and (because we use videoId-derived IDs) currentIndex
    // stays valid for any other song.
    if (currentSong && currentSong.id === songId) {
      const audio = audioRef.current;
      if (audio) {
        try { audio.pause(); } catch (_) { /* noop */ }
        try { audio.removeAttribute("src"); audio.load(); } catch (_) { /* noop */ }
      }
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setLyrics([]);
      setActiveLyricIndex(-1);
      lastPersistedTimeRef.current = 0;
      lastPersistedSongIdRef.current = null;
    }
    // Drop the persisted session record if it points at the deleted song —
    // either by id OR by bare videoId (user-added songs may have a
    // `user-{videoId}` synthetic id but the record carries the bare
    // videoId too). Without this, a deleted-and-not-reloaded session
    // would briefly try to restore a missing track on next mount.
    try {
      const session = loadPlaybackSession();
      if (session && (session.songId === songId || session.videoId)) {
        const deletedVideoId = songId && songId.startsWith("user-")
          ? songId.slice("user-".length)
          : "";
        if (
          session.songId === songId ||
          (deletedVideoId && session.videoId === deletedVideoId)
        ) {
          clearPlaybackSession("deleted-session-song");
          lastPersistedTimeRef.current = 0;
          lastPersistedSongIdRef.current = null;
        }
      }
    } catch (_) { /* noop */ }
    setContextMenu(null);
  }

  useEffect(() => {
    let mounted = true;
    // IMPORTANT: only flip `libraryHydratedRef` from the *initial* load
    // promise. The `subscribeUserSongs` callback below can fire
    // synchronously during component mount with whatever the storage
    // subscriber's initial state is — and that's frequently an empty
    // array (`[]`), NOT a real "library is empty" snapshot. If we flipped
    // on the subscription's first emit too, the empty-library effect
    // would race the still-pending `loadUserSongs()` promise, fire its
    // clear with an empty `allSongs`, and wipe a perfectly valid
    // playback session before the real list arrives.
    loadUserSongs().then((list) => {
      if (mounted) {
        setUserSongs(list);
        libraryHydratedRef.current = true;
        playbackDebugLog("library hydrated (initial load)", {
          count: list ? list.length : 0,
        });
      }
    });
    const unsubscribe = subscribeUserSongs((list) => {
      if (mounted) setUserSongs(list);
    });
    return () => {
      mounted = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  // Subscribe to favorites map so the library popover can render the
  // "Yêu thích" section live when the user toggles a song from the
  // SongContextMenu / Lyrics header actions.
  useEffect(() => {
    const unsubscribe = subscribeFavorites((map) => {
      setFavoritesMap(map && typeof map === "object" ? map : {});
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  // ── Restore last-played song + position on first mount ──────────────────
  //
  // Reads `svdmusic:playback-session:v1` from localStorage once the merged
  // `allSongs` list is populated. If the saved `songId` still exists, we
  // pre-select it and stash the timestamp; `handleLoadedMetadata` then
  // seeks the audio back to the exact spot once the src is ready. If the
  // saved song was deleted in the meantime we silently drop the stale
  // record.
  //
  // We match by songId FIRST, then by bare videoId — user-added songs may
  // have a `user-{videoId}` synthetic id, but the persisted record carries
  // the bare videoId too, so a deleted-and-re-added song still finds its
  // spot.
  useEffect(() => {
    if (restoredOnceRef.current) {
      playbackDebugLog("restore skip: already restored");
      return undefined;
    }
    playbackDebugLog("restore effect tick", {
      restoredOnce: restoredOnceRef.current,
      allSongsCount: allSongs ? allSongs.length : 0,
      currentIndex,
      currentSongId: currentSong?.id,
      currentSongVideoId: currentSong?.videoId,
      currentSongTitle: currentSong?.title || currentSong?.name,
    });
    if (!libraryHydratedRef.current) {
      playbackDebugLog("restore wait: library not hydrated yet");
      return undefined;
    }
    if (!allSongs || allSongs.length === 0) {
      // Library hydrated but empty — that's a real "library empty" state,
      // not a loading state. Drop the session so we don't try to restore
      // a song that no longer exists. (The empty-library effect above
      // handles this for the allSongs-empty case, but if hydrate
      // completed with an empty list before this effect ticked, we
      // double-clean here as a safety net.)
      playbackDebugLog("restore: library hydrated empty — clearing session");
      try {
        clearPlaybackSession("library-empty-after-hydration");
      } catch (_) { /* noop */ }
      lastPersistedTimeRef.current = 0;
      lastPersistedSongIdRef.current = null;
      restoredOnceRef.current = true;
      return undefined;
    }
    let session = null;
    try {
      session = loadPlaybackSession();
    } catch (err) {
      playbackDebugWarn("restore loadPlaybackSession threw", err);
      restoredOnceRef.current = true;
      return undefined;
    }
    playbackDebugLog("loaded session for restore", session);
    if (!session) {
      playbackDebugLog("restore skip: no session on disk");
      restoredOnceRef.current = true;
      return undefined;
    }
    const idx = allSongs.findIndex((s) => {
      if (!s) return false;
      const sId = s.id || s.videoId || "";
      return sId === session.songId || (session.videoId && s.videoId === session.videoId);
    });
    const matchedSong = idx >= 0 ? allSongs[idx] : null;
    playbackDebugLog("restore match result", {
      sessionSongId: session.songId,
      sessionVideoId: session.videoId,
      matchedIndex: idx,
      matchedSong: matchedSong
        ? {
            id: matchedSong.id,
            videoId: matchedSong.videoId,
            title: matchedSong.title || matchedSong.name,
          }
        : null,
    });
    if (idx < 0) {
      // Stale record — song no longer exists in the library.
      playbackDebugWarn("restore failed: song not found", {
        session,
        availableSongs: allSongs
          .slice(0, 20)
          .map((song) => ({
            id: song.id,
            videoId: song.videoId,
            title: song.title || song.name,
          })),
      });
      try { clearPlaybackSession("restore-song-not-found"); } catch (_) { /* noop */ }
      restoredOnceRef.current = true;
      return undefined;
    }
    pendingRestoreRef.current = {
      songId: session.songId,
      videoId: session.videoId || "",
      currentTime: Math.max(0, Number(session.currentTime || 0)),
      duration: Number(session.duration || 0) || 0,
    };
    restoreInProgressRef.current = true;
    restoreAppliedRef.current = false;
    playbackDebugLog("pendingRestoreRef set", pendingRestoreRef.current);
    playbackDebugLog("restore target set", {
      index: idx,
      songId: session.songId,
      videoId: session.videoId,
      currentTime: session.currentTime,
      duration: session.duration,
      restoreInProgress: restoreInProgressRef.current,
    });
    // The audio src swap is declarative (React controls the `<audio
    // src={...}>` prop), so `loadedmetadata` may fire before this effect
    // finishes, after, or never (if metadata was already cached and the
    // listener hasn't been re-attached yet). To cover all three cases we
    // schedule a few retry points from the restore effect itself.
    // `loadedmetadata` is the primary path; the timeouts are fallback
    // safety nets for the rare timing race.
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        applyPendingPlaybackRestore("after-pending-set-0ms");
      }, 0);
      window.setTimeout(() => {
        applyPendingPlaybackRestore("after-pending-set-300ms");
      }, 300);
    }
    // Use plain setState (NOT flushSync) here — flushSync inside an effect
    // body can interact badly with React 18's automatic batching, and the
    // audio seek happens later in `handleLoadedMetadata` anyway.
    if (idx !== currentIndex) {
      playbackDebugLog("setCurrentIndex for restore", {
        previousIndex: currentIndex,
        nextIndex: idx,
      });
      setCurrentIndex(idx);
      setCurrentTime(0);
    }
    // Restore is intentionally non-autoplay — the user resumes manually.
    setIsPlaying(false);
    restoredOnceRef.current = true;
    playbackDebugLog("playback session restored", {
      songId: session.songId,
      index: idx,
      currentTime: session.currentTime,
    });
    return undefined;
    // We intentionally only run this when `allSongs` shape changes — once
    // `restoredOnceRef` flips, the guard short-circuits any future runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSongs]);

  // ── Persist currentTime while playing ─────────────────────────────────────
  //
  // We poll the live `audio.currentTime` every ~1.5s instead of subscribing
  // to a `useEffect([currentTime, ...])` watcher. The React-state-based
  // watcher was triggering an obscure "Cannot access 'ce' before
  // initialization" ReferenceError in the Vite production bundle: the
  // 60fps setCurrentTime updates plus our throttle logic made the minifier
  // generate top-level bindings that hot-reload and the initial render
  // occasionally touched before they were hoisted. Polling the DOM audio
  // element sidesteps all of that and is also cheaper (no React commits
  // per tick).
  const PERSIST_THROTTLE_SEC = PERSIST_THROTTLE_MS / 1000;
  useEffect(() => {
    if (!currentSong || !isPlaying) return undefined;
    if (typeof window === "undefined") return undefined;
    const id = window.setInterval(() => {
      const audio = audioRef.current;
      if (!audio) return;
      const time = audio.currentTime;
      if (!Number.isFinite(time)) return;
      if (isSeekingRef.current) return;
      const songChanged = currentSong.id !== lastPersistedSongIdRef.current;
      const samePosition =
        time === lastPersistedTimeRef.current;
      if (samePosition && !songChanged) return;
      const delta = Math.abs(time - lastPersistedTimeRef.current);
      if (!songChanged && delta < PERSIST_THROTTLE_SEC) return;
      try {
        persistPlaybackSession("polling", { force: false });
        lastPersistedTimeRef.current = time;
        lastPersistedSongIdRef.current = currentSong.id;
      } catch (err) {
        console.warn("[SVD Persist] save failed", err);
      }
    }, PERSIST_THROTTLE_MS);
    return () => window.clearInterval(id);
    // intentionally only depend on song + isPlaying + throttle constant;
    // the timer body reads live audio state, not stale React closures.
  }, [currentSong?.id, isPlaying]);

  // Keep live snapshots of the values we need to write on unmount. Without
  // these refs the cleanup below would read stale values from the render
  // where the effect was first registered (because the deps array is `[]`).
  useEffect(() => {
    currentSongSnapshotRef.current = currentSong;
    currentTimeSnapshotRef.current = currentTime;
  });

  // Snapshot the last known timestamp on unmount so reloading the side panel
  // restores exactly where the user left off, even if they had been paused
  // for a long time (the throttle above skips writes during a paused state).
  useEffect(() => {
    return () => {
      const song = currentSongSnapshotRef.current;
      const time = currentTimeSnapshotRef.current;
      if (song && song.id && Number.isFinite(time) && time > 0) {
        try {
          savePlaybackSession({
            songId: song.id || song.videoId || "",
            videoId: song.videoId || "",
            currentTime: Math.max(0, Number(time)),
            duration: Number.isFinite(duration) ? Math.max(0, Number(duration)) : 0,
          });
          lastPlaybackSaveRef.current = Date.now();
        } catch (_) { /* noop */ }
      }
    };
  }, []);

  // Drop the persisted record if the library is *confirmed* empty AFTER
  // initial hydration. While hydration is still pending, an empty
  // `allSongs` just means "loading" — clearing the session then would
  // wipe a perfectly valid save from the previous run. Without the
  // `libraryHydratedRef` guard this effect fires on the very first render
  // (allSongs = []), deletes the session, and the later restore effect
  // finds nothing to restore.
  useEffect(() => {
    if (!libraryHydratedRef.current) {
      playbackDebugLog("empty-library clear skipped: library not hydrated yet");
      return;
    }
    if (!allSongs || allSongs.length === 0) {
      playbackDebugLog("library hydrated and empty — clearing session", {
        libraryHydrated: libraryHydratedRef.current,
      });
      clearPlaybackSession("library-empty-after-hydration");
      lastPersistedTimeRef.current = 0;
      lastPersistedSongIdRef.current = null;
    } else {
      playbackDebugLog("library hydrated and non-empty — keeping session", {
        allSongsCount: allSongs.length,
      });
    }
  }, [allSongs]);

  // Resolves cover object URLs for every user song in the playlist so the
  // song list rows can render the actual cover thumbnail (otherwise we'd be
  // stuck with the placeholder fallback for every user song). We drive
  // lookups by `coverKey`, not by slicing the user- prefix off `id`.
  useEffect(() => {
    let cancelled = false;
    const next = {};
    const tasks = [];
    for (const song of userSongs) {
      if (!song || !song.id || !song.coverKey) continue;
      tasks.push(
        loadAssetByKeyAsObjectURL(song.coverKey).then(({ url, revoke }) => {
          if (cancelled) {
            revoke();
            return;
          }
          if (url) next[song.id] = { url, revoke };
        }).catch(() => { /* keep silent */ })
      );
    }
    Promise.all(tasks).then(() => {
      if (cancelled) return;
      setUserCoverUrls((prev) => {
        // Revoke URLs from the previous render that are no longer used.
        for (const key of Object.keys(prev)) {
          if (!next[key] && prev[key]?.revoke) prev[key].revoke();
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [userSongs]);

  useEffect(() => {
    document.documentElement.classList.toggle("viewLyrics", viewMode === "lyrics");
  }, [viewMode]);

  // User-added song playback state. For user songs we resolve audio/cover
  // from IndexedDB via assetStorage.coverKey/audioKey and create object
  // URLs; for bundled songs we use the URL field as-is. We always revoke
  // any object URL we created when the song changes or the component
  // unmounts to avoid leaking blob memory.

  // ── Mood Quote typing animation for ".nowPlayingBottom" ─────────────────────
  // State machine (single useEffect, single timer ref, no leaks):
  //
  //   "idle"      → no quote yet, show blank
  //   "loading"   → getMoodQuote() is pending; show blank
  //   "typing"    → incrementally append one character per tick
  //   "hold"      → full text visible for 1.7 s, then jump to "clear"
  //   "clear"     → text already empty; wait 5 s, then "loading"
  //
  // Timings (per spec):
  //   character  → (58 + rand(34)) ms  × 1.25  →  72-115 ms
  //   punctuation ,.!?:; → 360 ms  × 1.25  →  450 ms
  //   space → 45 ms  × 1.25  →  56 ms
  //   hold → 1700 ms
  //   gap before next quote → 5000 ms  (was 500)
  //
  // The 1.25× factor slows the typing speed by 20% (display still feels
  // organic thanks to the per-char jitter, but reads more deliberately).

  const TYPING_SPEED_FACTOR = 1.25;
  const QUOTE_RESUME_DELAY_MS = 5000;

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    function getCharDelay(ch) {
      let base;
      if (ch === " ") base = 45;
      else if (/[,.\-!?;:\u2018\u2019\u201c\u201d]/.test(ch)) base = 360;
      else base = 58 + Math.random() * 34;
      return base * TYPING_SPEED_FACTOR;
    }

    function advance(phase, data) {
      if (cancelled) return;
      switch (phase) {
        case "typing": {
          const { quote, index } = data;
          if (index < quote.length) {
            const ch = quote[index];
            setTypingDisplay(quote.slice(0, index + 1));
            timer = setTimeout(() => advance("typing", { quote, index: index + 1 }), getCharDelay(ch));
          } else {
            // Done — hold full text.
            timer = setTimeout(() => advance("clear", {}), 1700);
          }
          break;
        }
        case "clear": {
          setTypingDisplay("");
          timer = setTimeout(() => advance("load", {}), QUOTE_RESUME_DELAY_MS);
          break;
        }
        case "load": {
          timer = setTimeout(async () => {
            if (cancelled) return;
            try {
              const quote = await getMoodQuote();
              if (!cancelled) advance("typing", { quote, index: 0 });
            } catch {
              if (!cancelled) advance("load", {});
            }
          }, 0);
          break;
        }
        default:
          break;
      }
    }

    // Kick off the first quote after a brief delay.
    timer = setTimeout(() => advance("load", {}), 400);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const filteredSongs = useMemo(() => {
    return allSongs
      .map((song, index) => ({ ...song, index }))
      .filter((song) => matchSongQuery(query, song));
  }, [query, allSongs]);

  const liveSearchResults = query.trim() ? filteredSongs.slice(0, 5) : [];
  const shouldShowLiveSearch = isSearchFocused && Boolean(query.trim());

  const activeLyricText =
    activeLyricIndex >= 0 ? lyrics[activeLyricIndex]?.text : "SVD Music";
  const repeatLabel =
    repeatMode === "one"
      ? "Repeat một bài"
      : repeatMode === "all"
        ? "Repeat tuần tự"
        : "Không repeat";
  const repeatBadge = repeatMode === "one" ? "1" : repeatMode === "all" ? "All" : "";
  const seekDisplayTime = isSeeking ? seekPreviewTime : currentTime;
  const seekValue = clampTime(seekDisplayTime, duration);
  const seekProgress = duration ? (seekValue / duration) * 100 : 0;

  useEffect(() => {
    lyricsRef.current = lyrics;
  }, [lyrics]);

  useEffect(() => {
    activeLyricIndexRef.current = activeLyricIndex;
  }, [activeLyricIndex]);

  useEffect(() => {
    isSeekingRef.current = false;
    pendingSeekTimeRef.current = 0;
    setIsSeeking(false);
    setSeekPreviewTime(0);
  }, [resolvedAudioUrl, currentSong?.id]);

  useEffect(() => {
    let isCancelled = false;
    if (!currentSong) {
      setLyrics([]);
      lyricsRef.current = [];
      activeLyricIndexRef.current = -1;
      setActiveLyricIndex(-1);
      currentTimeRef.current = 0;
      setCurrentTime(0);
      setDuration(0);
      setLyricStatus("Chưa có bài hát nào trong danh sách.");
      return;
    }
    resetLyricAutoFollow();
    lyricLineRefs.current = [];
    setLyrics([]);
    lyricsRef.current = [];
    activeLyricIndexRef.current = -1;
    setActiveLyricIndex(-1);
    currentTimeRef.current = 0;
    setCurrentTime(0);
    setDuration(0);
    if (lyricsBoxRef.current) {
      lyricsBoxRef.current.scrollTop = 0;
    }
    setLyricStatus("Đang tải lời bài hát...");

    // Lyrics loading priority:
    //   1) IndexedDB lookup via the song's `lyricsKey` /
    //      `lyricsTextKey` composite key (e.g. `lrc:OmqWQ-W0mjI`). This is
    //      the runtime source of truth for user-added songs.
    //   2) `fetch(song.lyrics)` for bundled songs (lyrics file shipped in
    //      public/uploads/lrc/{videoId}.lrc).
    const lyricsKey = currentSong.lyricsKey || currentSong.lyricsTextKey || null;

    const applyText = (text) => {
      if (isCancelled) return;
      const parsedLyrics = parseLrc(text);
      lyricsRef.current = parsedLyrics;
      // Catch up to wherever the audio actually is. Without this, lyrics
      // snap back to line 0 even if the user has been listening for a
      // while — which is what makes the lyrics look "stuck" until the user
      // clicks/seeks.
      const audio = audioRef.current;
      const now = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const nextIndex = parsedLyrics.length ? findActiveLyricIndex(parsedLyrics, now) : -1;
      activeLyricIndexRef.current = nextIndex;
      setLyrics(parsedLyrics);
      setActiveLyricIndex(nextIndex);
      setLyricStatus(parsedLyrics.length ? "" : "Bài hát này chưa có lyric.");
      // If audio is already playing, kick the RAF loop so the next tick
      // sees the freshly populated lyricsRef.
      if (audio && !audio.paused && !audio.ended) {
        startLyricSyncLoop();
      }
    };

    const fallbackToFetch = () => {
      if (!currentSong.lyrics) {
        if (!isCancelled) {
          setLyrics([]);
          setLyricStatus("Bài hát này chưa có lyric.");
        }
        return;
      }
      fetch(currentSong.lyrics)
        .then((response) => {
          if (!response.ok) throw new Error("Không tìm thấy file lyric.");
          return response.text();
        })
        .then(applyText)
        .catch(() => {
          if (!isCancelled) {
            setLyrics([]);
            setLyricStatus("Bài hát này chưa có lyric.");
          }
        });
    };

    if (lyricsKey) {
      loadLrcByKey(lyricsKey)
        .then((text) => {
          if (isCancelled) return;
          if (text) {
            applyText(text);
          } else {
            fallbackToFetch();
          }
        })
        .catch(() => {
          if (!isCancelled) fallbackToFetch();
        });
    } else {
      fallbackToFetch();
    }

    return () => {
      isCancelled = true;
    };
  }, [currentSong?.lyrics, currentSong?.lyricsKey, currentSong?.lyricsTextKey, currentSong?.id]);

  useEffect(() => {
    return () => {
      if (lyricAutoScrollTimerRef.current) clearTimeout(lyricAutoScrollTimerRef.current);
      if (lyricFollowResumeTimerRef.current) clearTimeout(lyricFollowResumeTimerRef.current);
      stopLyricSyncLoop();
    };
  }, []);

  // Resolve audio + cover URLs for the current song.
  //
  // For bundled songs (no audioKey / coverKey), the URL fields on the song
  // object are kept as-is and we do NOT revoke them on swap.
  //
  // For user-added songs we look the blobs up in IndexedDB via assetStorage
  // (keyed `audio:{videoId}` and `cover:{videoId}`) and create object URLs.
  // Whenever the song changes we revoke any object URL we created for the
  // previous song so we don't leak blob memory.
  useEffect(() => {
    let cancelled = false;

    // Revoke the previous song's object URLs (if any).
    revokeAudioUrlRef.current();
    revokeCoverUrlRef.current();
    revokeBannerUrlRef.current();
    revokeAudioUrlRef.current = () => {};
    revokeCoverUrlRef.current = () => {};
    revokeBannerUrlRef.current = () => {};

    setResolvedAudioUrl("");
    setResolvedCoverUrl("");
    setResolvedBannerUrl("");
    setAudioMissing(false);
    setAudioLoadError("");

    if (!currentSong) return;

    // Resolve assets by their composite storage key (e.g. `audio:OmqWQ-W0mjI`).
    // We do NOT slice the user- prefix off `currentSong.id`; the spec says
    // metadata carries the keys explicitly. For bundled songs the keys are
    // not set and we fall back to the URL fields on the song object.
    const audioKey = currentSong.audioKey || null;
    const coverKey = currentSong.coverKey || null;
    const isUserSong = !!audioKey || !!coverKey || !!currentSong.audioMissing;

    // ── Audio ─────────────────────────────────────────────────────────────
    if (isUserSong) {
      if (audioKey) {
        loadAssetByKeyAsObjectURL(audioKey).then(({ url, revoke }) => {
          if (cancelled) {
            revoke();
            return;
          }
          revokeAudioUrlRef.current = revoke;
          if (url) {
            setResolvedAudioUrl(url);
          } else {
            setAudioMissing(true);
            setAudioLoadError("Chưa có file MP3.");
          }
        });
      } else if (!currentSong.audioMissing) {
        setAudioMissing(true);
        setAudioLoadError("Chưa có file MP3.");
      }
    } else {
      // Bundled song: use the URL field directly.
      setResolvedAudioUrl(currentSong.audio || "");
    }

    // ── Cover ─────────────────────────────────────────────────────────────
    if (isUserSong && coverKey) {
      loadAssetByKeyAsObjectURL(coverKey).then(({ url, revoke }) => {
        if (cancelled) {
          revoke();
          return;
        }
        revokeCoverUrlRef.current = revoke;
        setResolvedCoverUrl(url || "");
      });
    } else {
      setResolvedCoverUrl(currentSong.cover || "");
    }

    // ── Banner (reuse the cover blob for user songs; bundled songs keep
    // their own banner URL) ──────────────────────────────────────────────
    if (isUserSong && coverKey) {
      loadAssetByKeyAsObjectURL(coverKey).then(({ url, revoke }) => {
        if (cancelled) {
          revoke();
          return;
        }
        revokeBannerUrlRef.current = revoke;
        setResolvedBannerUrl(url || "");
      });
    } else {
      setResolvedBannerUrl(currentSong.banner || currentSong.cover || "");
    }

    return () => {
      cancelled = true;
    };
  }, [
    currentSong?.id,
    currentSong?.audioKey,
    currentSong?.coverKey,
    currentSong?.audioMissing,
    currentSong?.audio,
    currentSong?.cover,
    currentSong?.banner,
  ]);

  // Final revoke pass on unmount.
  useEffect(() => {
    return () => {
      revokeAudioUrlRef.current();
      revokeCoverUrlRef.current();
      revokeBannerUrlRef.current();
    };
  }, []);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume / 100;
  }, [volume]);

  // Tear down the bass analyser graph when the App unmounts. The module
  // caches AudioContext + MediaElementSource per element via a WeakMap,
  // so closing the context here also lets the next mount start fresh.
  useEffect(() => {
    return () => {
      disposeBassReactiveCover();
    };
  }, []);

  // When the current song changes (and the cover blob is swapped),
  // re-attach the bass analyser to the new <audio> src. The audio element
  // itself is reused across songs, so createMediaElementSource only ever
  // runs once thanks to the WeakMap guard in bassReactiveCover.js — but
  // calling start() again ensures the loop is alive after a long pause
  // and re-grabs the .discWrap ref if React rebuilt it.
  useEffect(() => {
    if (!audioRef.current) return undefined;
    if (!isPlaying) return undefined;
    try {
      startBassReactiveCover(audioRef.current);
    } catch (_) { /* already covered by handlePlayEvent try/catch */ }
    return undefined;
  }, [currentSong?.id, isPlaying]);

  function toggleMute() {
    if (isMutedRef.current) {
      const restored = previousVolumeRef.current > 0 ? previousVolumeRef.current : 78;
      isMutedRef.current = false;
      setVolume(restored);
      return;
    }

    if (volume > 0) {
      previousVolumeRef.current = volume;
    }
    isMutedRef.current = true;
    setVolume(0);
  }

  useEffect(() => {
    if (!pendingPlayRef.current) return;
    if (!audioRef.current) return;
    if (!resolvedAudioUrl) return;
    if (audioMissing) return;
    pendingPlayRef.current = false;
    playAudio();
  }, [resolvedAudioUrl, audioMissing]);

  function resetLyricAutoFollow(triggerTick = false) {
    isLyricUserScrollingRef.current = false;
    isLyricAutoScrollingRef.current = false;
    if (lyricAutoScrollTimerRef.current) clearTimeout(lyricAutoScrollTimerRef.current);
    if (lyricFollowResumeTimerRef.current) clearTimeout(lyricFollowResumeTimerRef.current);
    if (triggerTick) setLyricFollowResumeTick((value) => value + 1);
  }

  function setSyncedActiveLyricIndex(nextIndex, currentTimeValue, source) {
    if (nextIndex === activeLyricIndexRef.current) return;
    if (LRC_DEBUG) {
      console.log(
        `[LRC] activeIndex changed ${activeLyricIndexRef.current} -> ${nextIndex} currentTime=${currentTimeValue.toFixed(3)} source=${source}`
      );
    }
    activeLyricIndexRef.current = nextIndex;
    setActiveLyricIndex(nextIndex);
  }

  function syncLyricsFromAudio(source = "tick") {
    const audio = audioRef.current;
    if (!audio) return;

    const nextTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    // Avoid 60fps re-renders: only update currentTime state when it
    // changed enough to matter for the seek bar (≥80ms). Lyric line index
    // is recomputed every call regardless.
    if (Math.abs(nextTime - currentTimeRef.current) >= 0.08) {
      currentTimeRef.current = nextTime;
      setCurrentTime(nextTime);
    }
    setSyncedActiveLyricIndex(
      findActiveLyricIndex(lyricsRef.current, nextTime),
      nextTime,
      source
    );

// Diagnostic + recovery: catch "restore applied, then immediately reset
    // to 0" regressions. If we applied a restore > 5s but the next audio
    // tick comes in with a 0-ish currentTime, something clobbered the
    // seek. Two policies here:
    //   - log via `console.log` (NOT `console.warn`) so Chrome extensions
    //     error page doesn't surface this as a noisy warning
    //   - recover in-place: re-seek the audio to the restored timestamp
    //     AND sync all currentTime-related refs/state so subsequent
    //     polling ticks don't save a bogus 0
    if (
      lastAppliedRestoreTimeRef.current &&
      lastAppliedRestoreTimeRef.current > 5 &&
      nextTime < 1
    ) {
      const restoredTime = lastAppliedRestoreTimeRef.current;
      try {
        console.log(
          `[PlaybackSession] restore reset recovered in syncLyricsFromAudio { restoredTime: ${restoredTime}, previousAudioTime: ${nextTime}, source: ${source} }`
        );
        playbackDebugLog("restore reset recovered in syncLyricsFromAudio", {
          restoredTime,
          previousAudioTime: nextTime,
          source,
        });
        try {
          audio.currentTime = restoredTime;
        } catch (err) {
          playbackDebugWarn("restore recovery currentTime threw", err);
        }
        setCurrentTime(restoredTime);
        currentTimeRef.current = restoredTime;
        activeLyricIndexRef.current = findActiveLyricIndex(
          lyricsRef.current,
          restoredTime
        );
        setActiveLyricIndex(activeLyricIndexRef.current);
        // NOTE: do NOT reset lastAppliedRestoreTimeRef here — the user's
        // restored position is still valid; we're just patching a
        // transient reset.
      } catch (err) {
        playbackDebugWarn("restore recovery branch threw", err);
      }
    }
  }

  function stopLyricSyncLoop() {
    if (lyricSyncRafRef.current === null) return;
    cancelAnimationFrame(lyricSyncRafRef.current);
    lyricSyncRafRef.current = null;
    if (LRC_DEBUG) console.log("[LRC] sync loop stopped");
  }

  function startLyricSyncLoop() {
    if (lyricSyncRafRef.current !== null) return;
    if (LRC_DEBUG) console.log("[LRC] sync loop started");

    const tick = () => {
      syncLyricsFromAudio("raf");
      const audio = audioRef.current;
      if (audio && !audio.paused && !audio.ended) {
        lyricSyncRafRef.current = requestAnimationFrame(tick);
        return;
      }
      lyricSyncRafRef.current = null;
      if (LRC_DEBUG) console.log("[LRC] sync loop stopped");
    };

    lyricSyncRafRef.current = requestAnimationFrame(tick);
  }

  // Windowed lyrics no longer need a continuous auto-scroll effect — the
  // active line is always pinned in the middle via padding. We only need
  // to reset the container scroll on song change, plus jump to a specific
  // line when the user clicks a lyric.
  useEffect(() => {
    if (lyricsBoxRef.current) lyricsBoxRef.current.scrollTop = 0;
  }, [currentSong?.id]);

  function playAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioMissing) {
      appendMissingAudioNotice();
      return;
    }
    audio.play().then(() => setIsPlaying(true)).catch(() => {
      setIsPlaying(false);
    });
  }

  function appendMissingAudioNotice() {
    // Lightweight user feedback when a user-added song has no MP3. We
    // intentionally do NOT crash or set isPlaying=true.
    setAudioLoadError("Chưa có file MP3 cho bài này.");
  }

  function selectSong(index) {
    if (index === currentIndex) {
      togglePlay();
      return;
    }
    resetLyricAutoFollow();
    stopLyricSyncLoop();
    flushSync(() => {
      setCurrentIndex(index);
      setCurrentTime(0);
      activeLyricIndexRef.current = -1;
      setActiveLyricIndex(-1);
    });

    // Mark intent to auto-play; the actual play() happens once the audio
    // src has been resolved by the currentSong effect (sync for bundled
    // songs, async via loadAssetByKeyAsObjectURL for user-uploaded songs).
    const target = allSongs[index];
    if (target?.audioMissing) {
      return;
    }
    pendingPlayRef.current = true;
  }

  // Plays a song selected from the library popover. Looks up its index in the
  // current `allSongs` list and routes through `selectSong` so all the
  // existing reset/sync/play-intent logic applies. Falls back to no-op if the
  // song can't be found in the merged list (e.g. it was just deleted).
  //
  // Intentionally does NOT close the popover — users often want to queue up
  // several picks before dismissing the library manually.
  function playSongFromLibrary(song) {
    if (!song || !song.id) return;
    const idx = allSongs.findIndex((s) => s && s.id === song.id);
    if (idx < 0) return;
    selectSong(idx);
  }

  function selectSearchResult(index) {
    setQuery("");
    setIsSearchFocused(false);
    selectSong(index);
  }

  function togglePlay() {
    if (!audioRef.current) return;
    if (audioMissing) {
      appendMissingAudioNotice();
      return;
    }
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }
    playAudio();
  }

  function handlePlayControlPointerDown(event) {
    event.preventDefault();
    ignoreNextPlayClickRef.current = true;
    togglePlay();
  }

  function handlePlayControlClick() {
    if (ignoreNextPlayClickRef.current) {
      ignoreNextPlayClickRef.current = false;
      return;
    }
    togglePlay();
  }

  function handlePlayControlKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    togglePlay();
  }

  function getNextIndex(direction = 1) {
    if (isShuffle && direction > 0 && allSongs.length > 1) {
      let nextIndex = currentIndex;
      while (nextIndex === currentIndex) {
        nextIndex = Math.floor(Math.random() * allSongs.length);
      }
      return nextIndex;
    }
    return (currentIndex + direction + allSongs.length) % allSongs.length;
  }

  function playByDirection(direction) {
    resetLyricAutoFollow();
    stopLyricSyncLoop();
    // Compute target index + check audioMissing BEFORE mutating state so the
    // check uses the pre-Next/Prev currentIndex.
    const targetIndex = getNextIndex(direction);
    const target = allSongs[targetIndex];
    flushSync(() => {
      setCurrentIndex(targetIndex);
      setCurrentTime(0);
      activeLyricIndexRef.current = -1;
      setActiveLyricIndex(-1);
    });
    // Defer the actual play() until the new audio src is resolved by the
    // currentSong effect (sync for bundled songs, async via
    // loadAssetByKeyAsObjectURL for user-uploaded songs). Mirrors
    // selectSong's pendingPlayRef pattern so auto-play works regardless of
    // whether the new src is a direct URL or a freshly-resolved blob URL.
    if (target?.audioMissing) {
      appendMissingAudioNotice();
      return;
    }
    pendingPlayRef.current = true;
  }

  function cycleRepeatMode() {
    setRepeatMode((mode) => {
      if (mode === "off") return "one";
      if (mode === "one") return "all";
      return "off";
    });
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    syncLyricsFromAudio("timeupdate");
  }

  function getSeekValue(event) {
    const value = Number(event.currentTarget.value);
    return clampTime(value, duration);
  }

  function beginSeek(event) {
    const nextTime = getSeekValue(event);
    isSeekingRef.current = true;
    pendingSeekTimeRef.current = nextTime;
    setIsSeeking(true);
    setSeekPreviewTime(nextTime);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function previewSeek(event) {
    const nextTime = getSeekValue(event);
    pendingSeekTimeRef.current = nextTime;
    setSeekPreviewTime(nextTime);
  }

  function commitSeek() {
    if (!isSeekingRef.current) return;
    const nextTime = Math.max(0, Math.min(pendingSeekTimeRef.current, duration || 0));
    const audio = audioRef.current;
    isSeekingRef.current = false;
    setIsSeeking(false);
    resetLyricAutoFollow(true);
    if (audio) audio.currentTime = nextTime;
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
    setSyncedActiveLyricIndex(findActiveLyricIndex(lyricsRef.current, nextTime), nextTime, "seek");
    // Persist the new position immediately so a reload after seek lands
    // on the new timestamp, not whatever the throttle saved earlier.
    if (currentSong) {
      // force=true: a deliberate seek should always count, even if the
      // throttle guard above would have skipped the write.
      persistPlaybackSession("seek-commit", { force: true });
      lastPersistedTimeRef.current = nextTime;
      lastPersistedSongIdRef.current = currentSong.id;
    }
  }

  function cancelSeek() {
    isSeekingRef.current = false;
    setIsSeeking(false);
    setSeekPreviewTime(currentTime);
  }

  function beginKeyboardSeek(event) {
    if (!SEEK_KEYS.has(event.key)) return;
    if (isSeekingRef.current) return;
    isSeekingRef.current = true;
    pendingSeekTimeRef.current = currentTime;
    setIsSeeking(true);
    setSeekPreviewTime(currentTime);
  }

  function commitKeyboardSeek(event) {
    if (SEEK_KEYS.has(event.key)) commitSeek();
  }

  function pauseLyricAutoFollow(force = false) {
    if (isLyricAutoScrollingRef.current && !force) return;
    if (force) {
      isLyricAutoScrollingRef.current = false;
      if (lyricAutoScrollTimerRef.current) clearTimeout(lyricAutoScrollTimerRef.current);
    }
    isLyricUserScrollingRef.current = true;
    if (lyricFollowResumeTimerRef.current) clearTimeout(lyricFollowResumeTimerRef.current);
    lyricFollowResumeTimerRef.current = setTimeout(() => {
      isLyricUserScrollingRef.current = false;
      setLyricFollowResumeTick((v) => v + 1);
    }, 3000);
  }

  function handleLyricsUserInput() { pauseLyricAutoFollow(true); }
  function handleLyricsScroll() { pauseLyricAutoFollow(); }

  function handleLyricJump(line, index) {
    const audio = audioRef.current;
    if (!audio) return;
    const shouldResume = !audio.paused;
    const nextTime = Math.max(0, line.time);
    resetLyricAutoFollow(true);
    audio.currentTime = nextTime;
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
    setSyncedActiveLyricIndex(index, nextTime, "lyric-click");
    if (!shouldResume) {
      setIsPlaying(false);
      return;
    }
    audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
  }

  function handleEnded() {
    const audio = audioRef.current;
    if (repeatMode === "one" && audio) {
      audio.currentTime = 0;
      setCurrentTime(0);
      setSyncedActiveLyricIndex(findActiveLyricIndex(lyricsRef.current, 0), 0, "ended-repeat-one");
      playAudio();
      return;
    }

    // Both "repeat all" and natural end-of-playlist advance to the next
    // song. We CANNOT call playAudio() directly here: setCurrentIndex
    // changes the song, but for user-uploaded songs the new audio src is
    // resolved asynchronously inside the currentSong effect. Calling play()
    // on the old src would either replay the previous track or silently
    // fail (catching the rejection then flips isPlaying back to false).
    //
    // Use the same pendingPlayRef pattern that selectSong / playByDirection
    // rely on: the useEffect keyed on `resolvedAudioUrl` will invoke
    // playAudio() once the new src is actually wired into <audio src>.
    let nextIndex = null;
    if (repeatMode === "all") {
      nextIndex = (currentIndex + 1) % allSongs.length;
    } else if (currentIndex < allSongs.length - 1) {
      nextIndex = currentIndex + 1;
    }

    if (nextIndex === null) {
      // Genuine end of playlist with repeat off — nothing left to play.
      setIsPlaying(false);
      setCurrentTime(audio?.duration || duration);
      return;
    }

    const target = allSongs[nextIndex];
    if (target?.audioMissing) {
      resetLyricAutoFollow();
      stopLyricSyncLoop();
      flushSync(() => {
        setCurrentIndex(nextIndex);
        setCurrentTime(0);
        activeLyricIndexRef.current = -1;
        setActiveLyricIndex(-1);
      });
      appendMissingAudioNotice();
      return;
    }

    resetLyricAutoFollow();
    stopLyricSyncLoop();
    flushSync(() => {
      setCurrentIndex(nextIndex);
      setCurrentTime(0);
      activeLyricIndexRef.current = -1;
      setActiveLyricIndex(-1);
    });
    pendingPlayRef.current = true;
  }

  // ── Shared restore apply helper ─────────────────────────────────────────
  //
  // Single source of truth for "seek the audio back to the saved
  // timestamp". Called from three places:
  //   - `handleLoadedMetadata` (primary path — when the browser tells
  //     us metadata finished loading).
  //   - Two `setTimeout` retries scheduled from the restore effect
  //     (fallback for races where loadedmetadata fired before/after we
  //     stashed the pending record, or never fired at all because the
  //     listener re-attachment happened after the synchronous metadata
  //     dispatch).
  //   - `currentSong-ready` effect (fallback when the audio src
  //     resolution completes outside the loadedmetadata window).
  //
  // Idempotent: once `restoreAppliedRef` flips true, subsequent calls
  // bail. Clears `restoreInProgressRef` only on success.
  function applyPendingPlaybackRestore(reason = "") {
    const pending = pendingRestoreRef.current;
    const audio = audioRef.current;

    playbackDebugLog("applyPendingPlaybackRestore called", {
      reason,
      hasPending: Boolean(pending),
      pending: pending ? { ...pending } : null,
      hasAudio: Boolean(audio),
      audioReadyState: audio ? audio.readyState : null,
      audioDuration: audio ? audio.duration : null,
      audioCurrentTime: audio ? audio.currentTime : null,
      currentSongId: currentSong?.id,
      currentSongVideoId: currentSong?.videoId,
      restoreInProgress: restoreInProgressRef.current,
      restoreApplied: restoreAppliedRef.current,
    });

    if (!pending) {
      // No work to do. Don't disturb restoreApplied — only the success
      // path may flip it false.
      return false;
    }
    if (!audio) {
      playbackDebugLog("apply restore deferred: no audio element");
      return false;
    }
    if (restoreAppliedRef.current) {
      // Already applied. This shouldn't normally happen because we
      // null out `pendingRestoreRef` on success, but if a retry races
      // against the success path it should just no-op.
      return false;
    }

    // Match check — the saved record might point at a song that the
    // restore effect found at index `idx`, but the audio element's src
    // might still be the *previous* song's src if React hasn't
    // reconciled yet. Compare against currentSong; if it doesn't match,
    // bail and let the retry timeouts fire later.
    const pendingSongId = pending.songId || "";
    const pendingVideoId = pending.videoId || "";
    const currentId = currentSong?.id || "";
    const currentVideoId = currentSong?.videoId || "";
    const songIdMatches = pendingSongId && currentId && pendingSongId === currentId;
    const videoIdMatches = pendingVideoId && currentVideoId && pendingVideoId === currentVideoId;
    if (!songIdMatches && !videoIdMatches) {
      playbackDebugLog("apply restore deferred: song mismatch — audio src not yet swapped", {
        pending: { songId: pendingSongId, videoId: pendingVideoId },
        currentSong: { id: currentId, videoId: currentVideoId },
      });
      return false;
    }

    const requestedTime = Math.max(0, Number(pending.currentTime || 0));

    // Need a valid duration to clamp against. Without metadata the
    // browser will throw on `audio.currentTime = X` (or quietly
    // refuse to seek). We treat "duration not loaded yet" as "try
    // again later" rather than aborting the restore.
    const liveDuration = Number(audio.duration);
    const hasDuration = Number.isFinite(liveDuration) && liveDuration > 0;
    if (!hasDuration) {
      playbackDebugLog("apply restore deferred: duration not ready yet", {
        requestedTime,
        audioDuration: audio.duration,
        audioReadyState: audio.readyState,
      });
      return false;
    }

    const clampedTime = Math.min(requestedTime, Math.max(0, liveDuration - 0.5));

    if (!Number.isFinite(clampedTime) || clampedTime <= 0) {
      playbackDebugLog("apply restore aborted: invalid clamped time", {
        requestedTime,
        duration: liveDuration,
        clampedTime,
      });
      // Treat as fatal — clear pending so we don't loop forever on a
      // bogus session record.
      pendingRestoreRef.current = null;
      restoreInProgressRef.current = false;
      return false;
    }

    try {
      playbackDebugLog("applying restore time", {
        reason,
        requestedTime,
        clampedTime,
        duration: liveDuration,
      });
      audio.currentTime = clampedTime;
    } catch (err) {
      playbackDebugLog("restore time apply failed", {
        reason,
        err: String(err?.message || err),
        requestedTime,
        clampedTime,
      });
      // Don't clear pending — let the next retry try again.
      return false;
    }

    currentTimeRef.current = clampedTime;
    setCurrentTime(clampedTime);
    lastAppliedRestoreTimeRef.current = clampedTime;
    activeLyricIndexRef.current = findActiveLyricIndex(
      lyricsRef.current,
      clampedTime
    );
    setActiveLyricIndex(activeLyricIndexRef.current);

    // Mark restore as fully applied — only AFTER audio.currentTime
    // settled successfully. This is what unlocks the song-change save
    // effect and the polling tick.
    pendingRestoreRef.current = null;
    restoreInProgressRef.current = false;
    restoreAppliedRef.current = true;

    playbackDebugLog("restore time applied", {
      reason,
      requestedTime,
      clampedTime,
      audioCurrentTime: audio.currentTime,
      duration: liveDuration,
      lastAppliedRestoreTimeRef: lastAppliedRestoreTimeRef.current,
    });

    // Force-flush a save with the restored timestamp so we don't lose
    // the restore point if the user closes the sidepanel immediately
    // after. The meaningful-save gate in `persistPlaybackSession`
    // accepts this because we passed `force: true`.
    try {
      persistPlaybackSession("restore-applied", { force: true });
    } catch (err) {
      playbackDebugWarn("post-restore persist threw", err);
    }

    return true;
  }

  // ── Audio element React event handlers ────────────────────────────────────
  //
  // React attaches the on* props directly via synthetic events, so the
  // listeners survive re-renders without the cleanup/teardown races the
  // old `addEventListener`-inside-useEffect approach had (the effect used
  // to re-run on `duration` and `currentIndex` changes, briefly stopping
  // the RAF loop in between). We also keep the explicit `handleLoadedMetadata`
  // call on mount so the seek bar gets a duration even when the audio
  // metadata was already cached.
  function handleLoadedMetadata(event) {
    const audio = event?.currentTarget || audioRef.current;
    if (!audio) return;
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    syncLyricsFromAudio("loadedmetadata");

    playbackDebugLog("loadedmetadata", {
      currentSongId: currentSong?.id,
      videoId: currentSong?.videoId,
      audioDuration: audio.duration,
      audioCurrentTime: audio.currentTime,
      audioReadyState: audio.readyState,
      pendingRestore: pendingRestoreRef.current,
      restoreInProgress: restoreInProgressRef.current,
      restoreApplied: restoreAppliedRef.current,
      restoredOnce: restoredOnceRef.current,
    });

    // Delegate to the shared apply helper. This is the PRIMARY restore
    // path — the timeouts scheduled from the restore effect are
    // fallbacks for cases where `loadedmetadata` fired before we set the
    // pending record, or where it never fired at all (cached metadata
    // reattached listener too late).
    const applied = applyPendingPlaybackRestore("loadedmetadata");
    if (!applied) {
      // apply helper logs its own reasons; if it bailed we just leave
      // restore state alone and let the timeout fallbacks retry.
      return;
    }
  }

  function handlePlayEvent(event) {
    const audio = event?.currentTarget || audioRef.current;

    // Play guard: if we previously applied a restore > 5s but the audio
    // element's currentTime has been clobbered to ~0 (by a src swap,
    // bug, race, etc.), re-apply the restored timestamp BEFORE we kick
    // off sync / RAF / bass. Without this, the first syncLyrics tick
    // below would sync to 0, the seek bar would jump, AND the polling
    // save would overwrite the saved session with currentTime≈0.
    // Mirror the same recovery that `syncLyricsFromAudio` does at the
    // bottom — but here it happens synchronously before any state churn.
    if (
      audio &&
      restoreAppliedRef.current &&
      Number.isFinite(lastAppliedRestoreTimeRef.current) &&
      lastAppliedRestoreTimeRef.current > 5 &&
      audio.currentTime < 1
    ) {
      const restoredTime = lastAppliedRestoreTimeRef.current;
      playbackDebugLog("play guard: re-applying restored time before play", {
        restoredTime,
        audioCurrentTime: audio.currentTime,
        stateCurrentTime: currentTime,
        refCurrentTime: currentTimeRef.current,
      });
      try {
        audio.currentTime = restoredTime;
      } catch (err) {
        playbackDebugWarn("play guard currentTime threw", err);
      }
      setCurrentTime(restoredTime);
      currentTimeRef.current = restoredTime;
    }

    playbackDebugLog("play event after guard", {
      audioCurrentTime: audio ? audio.currentTime : null,
      restoreApplied: restoreAppliedRef.current,
      lastAppliedRestoreTime: lastAppliedRestoreTimeRef.current,
    });

    setIsPlaying(true);
    resetLyricAutoFollow(true);
    syncLyricsFromAudio("play");
    startLyricSyncLoop();
    // Kick off the bass-reactive cover. `onPlay` fires after a real
    // user gesture chain, so we can resume the AudioContext here without
    // tripping Chrome's autoplay policy. resume() falls back to a fresh
    // startBassReactiveCover() if the loop was never set up (e.g. first
    // play of this App mount).
    try {
      resumeBassReactiveCover(audio);
    } catch (err) {
      // Don't crash playback if Web Audio isn't available (e.g. very
      // old Chromium build or restricted iframe).
      console.warn("[SVD BassReactive] resume failed:", err?.message || err);
    }
  }

  function handlePauseEvent(event) {
    setIsPlaying(false);
    syncLyricsFromAudio("pause");
    stopLyricSyncLoop();
    // Halt the disc rotation + zoom pulse while the song is on hold. The
    // rotation angle is preserved so the cover freezes on its current
    // pose; the next resume() picks up from there. Without this, the
    // base 12°/s spin keeps the disc slowly rotating while audio is
    // paused, which looks like a stuck animation.
    try {
      pauseBassReactiveCover();
    } catch (err) {
      console.warn("[SVD BassReactive] pause failed:", err?.message || err);
    }
    // Snapshot the timestamp now so reloading the extension restores the
    // paused position exactly, even if the throttled save effect above
    // hadn't ticked since the last seek.
    if (currentSong) {
      // force=true: pause is an explicit user action and should always
      // be written, regardless of throttle.
      persistPlaybackSession("pause", { force: true });
      const audio = event?.currentTarget || audioRef.current;
      if (audio && Number.isFinite(audio.currentTime)) {
        lastPersistedTimeRef.current = audio.currentTime;
        lastPersistedSongIdRef.current = currentSong.id;
      }
    }
  }

  function handleSeekedEvent(event) {
    const audio = event?.currentTarget || audioRef.current;
    resetLyricAutoFollow(true);
    syncLyricsFromAudio("seeked");
    if (audio && !audio.paused && !audio.ended) startLyricSyncLoop();
    // User explicit seek — the audio.currentTime now reflects the user's
    // intent, not the auto-applied restore. Clear restore bookkeeping
    // so subsequent polling saves aren't blocked by the
    // "low time after restore applied" gate. Keep
    // `restoreAppliedRef.current` true until a fresh save writes the
    // new position; the guard only blocks saves whose currentTime < 1.
    // The moment a polling/song-change tick commits a position > 1 the
    // lastAppliedRestoreTimeRef becomes irrelevant and the song-change
    // guard eventually drops it.
    if (audio && Number.isFinite(audio.currentTime) && audio.currentTime > 1) {
      lastAppliedRestoreTimeRef.current = null;
      restoreAppliedRef.current = false;
      playbackDebugLog("restore refs cleared by user seek", {
        audioCurrentTime: audio.currentTime,
      });
    }
  }

  function handleEndedEvent(event) {
    syncLyricsFromAudio("ended");
    stopLyricSyncLoop();
    handleEnded();
  }

  // Mount-only: prime duration from already-cached metadata and resume RAF
  // if the audio somehow kept playing across remounts.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
    if (!audio.paused && !audio.ended) startLyricSyncLoop();
    return () => stopLyricSyncLoop();
  }, []);

  // 100 = ảnh rõ nhất => overlay mỏng nhất
  // 20 = ảnh mờ/tối nhất => overlay dày nhất
  // Custom image opacity stays 1; the slider drives the shade/gradient
  // overlay thickness instead. See styles.css .appShell.homeView.hasCustomBg rules.
  const bgStrength = backgroundOpacity / 100;
  const shadeOpacity = 0.75 - bgStrength * 0.55;
  const gradientTop = Math.max(0.08, shadeOpacity - 0.15);
  const gradientBottom = Math.min(0.65, shadeOpacity + 0.12);

  const appShellClass = [
    "appShell",
    viewMode === "lyrics" ? "viewLyrics lyricsView" : "homeView",
    activeBackgroundImage ? "hasCustomBg" : "",
    theme === "light" ? "theme-light" : "theme-dark",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Shared persist helper ─────────────────────────────────────────────
  //
  // All "save the playback session" call sites go through this one place.
  // Every skip path logs the reason so we can diagnose "why didn't my
  // session save?" without flipping through five different effect blocks.
  function persistPlaybackSession(reason, options) {
    const force = Boolean(options && options.force);
    const now = Date.now();
    const msSinceLastSave = now - lastPlaybackSaveRef.current;
    if (!force && msSinceLastSave < 250) {
      playbackDebugLog("save skip: throttled", { reason, msSinceLastSave });
      return;
    }
    // Hard gate: while a restore is being applied, no save path may run
    // — even the polling tick. The audio element briefly holds a
    // zero-ish `currentTime` between the src swap and the actual seek,
    // and letting any of those zero values hit storage would overwrite
    // the very session we're trying to restore. Only the explicit
    // post-restore flush (reason="restore-applied", force=true) gets a
    // pass because by then `restoreInProgressRef` is already false.
    if (restoreInProgressRef.current && !restoreAppliedRef.current) {
      playbackDebugLog("save skip: restore in progress", {
        reason,
        force,
        restoreInProgress: restoreInProgressRef.current,
        restoreApplied: restoreAppliedRef.current,
        pendingRestore: pendingRestoreRef.current
          ? { ...pendingRestoreRef.current }
          : null,
      });
      return;
    }
    // Second gate: after a restore was successfully applied, refuse to
    // save any "low time" snapshot from non-explicit reasons. The window
    // is short — it expires as soon as `lastAppliedRestoreTimeRef` gets
    // overwritten by either a user seek (point 6 below resets it) OR
    // another save that legitimately advanced past `restoredTime + 1`.
    // During that window, transient 0/1 reads from `audio.currentTime`
    // (e.g. while audio.src is being re-decoded) MUST NOT clobber the
    // saved session.
    const lastRestore = lastAppliedRestoreTimeRef.current;
    if (
      restoreAppliedRef.current &&
      Number.isFinite(lastRestore) &&
      lastRestore > 5
    ) {
      // Probe the current "would-be save" value to decide.
      const probeAudio = audioRef.current;
      const probeTime = probeAudio && Number.isFinite(probeAudio.currentTime)
        ? probeAudio.currentTime
        : currentTimeRef.current;
      const lowTimeReasons = new Set([
        "polling",
        "play",
        "timeupdate",
        "song-change",
      ]);
      if (
        Number.isFinite(probeTime) &&
        probeTime < 1 &&
        lowTimeReasons.has(reason)
      ) {
        playbackDebugLog("save skip: low time after restore applied", {
          reason,
          probeTime,
          lastRestore,
        });
        return;
      }
    }
    if (!currentSong) {
      playbackDebugLog("save skip: no currentSong", { reason });
      return;
    }
    const songId = currentSong.id || currentSong.videoId || "";
    if (!songId) {
      playbackDebugLog("save skip: no songId", { reason, currentSong: {
        id: currentSong.id,
        videoId: currentSong.videoId,
        title: currentSong.title || currentSong.name,
      } });
      return;
    }
    const audio = audioRef.current;
    const liveTime = audio && Number.isFinite(audio.currentTime)
      ? audio.currentTime
      : currentTimeRef.current;
    const liveDuration = audio && Number.isFinite(audio.duration)
      ? audio.duration
      : duration;
    if (!Number.isFinite(liveTime) || liveTime < 0) {
      playbackDebugLog("save skip: bad liveTime", { reason, liveTime });
      return;
    }
    const safeTime = Math.max(0, Number(liveTime));
    const safeDuration = Number.isFinite(liveDuration) ? Math.max(0, Number(liveDuration)) : 0;
    // Meaningful-save gate: refuse to overwrite a saved session with a
    // zero-state record unless the caller is explicitly force-flushing
    // (pagehide / beforeunload / unmount cleanup / seek / pause) OR the
    // audio has actually loaded metadata (duration > 0) OR playback is
    // running OR the currentTime is non-zero.
    //
    // Without this guard, the very first song-change effect after
    // initial mount fires with currentTime=0 duration=0 and clobbers the
    // previous session, even though the user hasn't done anything yet.
    const zeroState = safeTime === 0 && safeDuration === 0 && !isPlaying;
    const metadataReady = safeDuration > 0;
    const isExplicitForceReason =
      force &&
      (reason === "pagehide" ||
        reason === "beforeunload" ||
        reason === "pause" ||
        reason === "seek-commit" ||
        reason === "unmount");
    if (zeroState && !metadataReady && !isPlaying && !isExplicitForceReason) {
      playbackDebugLog("save skip: zero state before metadata", {
        reason,
        force,
        safeTime,
        safeDuration,
        isPlaying,
        currentSongId: currentSong.id,
      });
      return;
    }
    playbackDebugLog("save commit", {
      reason,
      force,
      songId,
      videoId: currentSong.videoId || "",
      currentTime: safeTime,
      duration: safeDuration,
      isPlaying,
      hasPendingRestore: Boolean(pendingRestoreRef.current),
    });
    try {
      savePlaybackSession({
        songId,
        videoId: currentSong.videoId || "",
        currentTime: safeTime,
        duration: safeDuration,
      });
      lastPlaybackSaveRef.current = now;
    } catch (err) {
      playbackDebugWarn("save threw", err);
    }
  }

  // ── Save session on visibilitychange / pagehide / beforeunload ───────
  //
  // The throttle'd "while playing" effect above misses the last few
  // seconds when the user closes the sidepanel mid-track. visibilitychange
  // + pagehide + beforeunload guarantee we always flush a final record
  // before the sidepanel goes away. These are force-flush paths: they
  // bypass the throttle guard because the next chance to save might not
  // exist (the tab is closing).
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        persistPlaybackSession("visibilitychange", { force: true });
      }
    }
    function onPageHide() { persistPlaybackSession("pagehide", { force: true }); }
    function onBeforeUnload() { persistPlaybackSession("beforeunload", { force: true }); }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [currentSong?.id, duration]);

  // ── Save session on song change ──────────────────────────────────────
  //
  // The polling effect already writes the new song's currentTime when the
  // audio ticks. But the very moment the user picks a different song the
  // audio element briefly holds the *old* src — if the user closes the
  // sidepanel during that window we'd save the wrong track. To avoid that,
  // we watch the resolved audio src (or song id) and write a fresh session
  // record on every transition. Re-using the throttle guard above keeps
  // this cheap.
  //
  // SAFETY: skip the save entirely while a `pendingRestoreRef` is in
  // flight. After restore the effect that loads `allSongs` calls
  // `setCurrentIndex(...)` which flips `currentSong`; if we ran this
  // effect right then we'd overwrite the freshly-restored `01:20` with
  // the brand-new `0` currentTime. Wait until `handleLoadedMetadata`
  // applies (and clears) the pending restore before letting any auto
  // save run.
  useEffect(() => {
    playbackDebugLog("currentSong changed", {
      currentSongId: currentSong?.id,
      currentSongVideoId: currentSong?.videoId,
      currentSongTitle: currentSong?.title || currentSong?.name,
      currentTime,
      duration,
      hasPendingRestore: Boolean(pendingRestoreRef.current),
      restoredOnce: restoredOnceRef.current,
      restoreApplied: restoreAppliedRef.current,
      lastAppliedRestoreTime: lastAppliedRestoreTimeRef.current,
    });
    // Song transitioned manually (user clicked a different song) — the
    // restore bookkeeping no longer applies to this new track. Clear it
    // BEFORE we evaluate save guards so the "low time after restore
    // applied" gate doesn't wrongly fire on the freshly-zeroed audio
    // position.
    lastAppliedRestoreTimeRef.current = null;
    restoreAppliedRef.current = false;
    if (!restoredOnceRef.current) {
      playbackDebugLog("song-change save skipped: restore not completed");
      return;
    }
    if (pendingRestoreRef.current) {
      playbackDebugLog("song-change save skipped: pending restore exists", pendingRestoreRef.current);
      return;
    }
    // Don't overwrite a saved session with a meaningless zero state —
    // this fires on initial mount when currentSong flips from undefined
    // to the first library entry, but audio metadata isn't loaded yet
    // (duration=0, currentTime=0). Without this guard the session would
    // be replaced with junk data and the previous restore point would be
    // lost.
    const probeAudio = audioRef.current;
    const metadataReady =
      probeAudio &&
      Number.isFinite(probeAudio.duration) &&
      probeAudio.duration > 0;
    if (!metadataReady && currentTime === 0 && duration === 0) {
      playbackDebugLog("song-change save skipped: metadata not ready zero state", {
        audioCurrentTime: probeAudio ? probeAudio.currentTime : null,
        audioDuration: probeAudio ? probeAudio.duration : null,
      });
      return;
    }
    persistPlaybackSession("song-change", { force: false });
  }, [currentSong?.id]);

  // Expose a tiny diagnostic helper on `window` so we can poke at the
  // session state from DevTools without rebuilding the sidepanel.
  // Always available — the helper does NOT log anything on its own
  // (no spam); it only reads state when the user calls it from the
  // console.
  if (typeof window !== "undefined") {
    try {
      window.__SVD_PLAYBACK_DEBUG__ = {
        loadSession: loadPlaybackSession,
        saveSession: savePlaybackSession,
        clearSession: () => clearPlaybackSession("manual-debug"),
        getCurrent: () => {
          const probeAudio = audioRef.current;
          return {
            currentSongId: currentSong?.id,
            currentSongVideoId: currentSong?.videoId,
            currentSongTitle: currentSong?.title || currentSong?.name,
            currentIndex,
            currentTime,
            duration,
            isPlaying,
            pendingRestore: pendingRestoreRef.current
              ? { ...pendingRestoreRef.current }
              : null,
            restoreInProgress: restoreInProgressRef.current,
            restoreApplied: restoreAppliedRef.current,
            restoredOnce: restoredOnceRef.current,
            lastPersistedSongId: lastPersistedSongIdRef.current,
            lastPersistedTime: lastPersistedTimeRef.current,
            lastAppliedRestoreTime: lastAppliedRestoreTimeRef.current,
            audioCurrentTime: probeAudio ? probeAudio.currentTime : null,
            audioDuration: probeAudio ? probeAudio.duration : null,
            audioReadyState: probeAudio ? probeAudio.readyState : null,
            playbackDebugEnabled: PLAYBACK_SESSION_DEBUG,
          };
        },
        applyRestoreNow: () =>
          applyPendingPlaybackRestore("manual-debug"),
        forceFlush: (reason = "manual-force") =>
          persistPlaybackSession(reason, { force: true }),
        setDebug: (enabled) => {
          // Runtime flip. Sets localStorage so the change survives
          // reload; the user must reload the sidepanel for the gate
          // to take effect (the const is read once at module load).
          if (typeof window === "undefined" || !window.localStorage) {
            console.log(
              "[PlaybackSession] setDebug: no localStorage available"
            );
            return;
          }
          if (enabled) {
            window.localStorage.setItem("svdmusic:debug:playback", "1");
            console.log(
              "[PlaybackSession] debug ENABLED — reload the sidepanel to apply"
            );
          } else {
            window.localStorage.removeItem("svdmusic:debug:playback");
            console.log(
              "[PlaybackSession] debug DISABLED — reload the sidepanel to apply"
            );
          }
        },
        isDebugEnabled: () => PLAYBACK_SESSION_DEBUG,
      };
    } catch (err) {
      // ignore — diagnostic-only feature.
      // Intentionally not a warn: we don't want the helper itself to
      // pollute the console.
    }
  }

  return (
    <div
      className={appShellClass}
      style={{
        // The custom image keeps opacity 1; the slider drives the
        // shade/gradient overlay thickness via these variables.
        // 100% -> thin overlay (image clearly visible).
        // 20%  -> thick overlay (image dim, foreground readable).
        "--custom-bg-shade-opacity": String(shadeOpacity),
        "--custom-bg-gradient-top": String(gradientTop),
        "--custom-bg-gradient-bottom": String(gradientBottom),
      }}
    >
      {/* Ambient background — default banner image + optional user-picked image
          + darkening overlay for legibility. */}
      <div className="ambientBg">
        <img
          src={resolvedBannerUrl || currentSong?.banner || currentSong?.cover}
          alt=""
          onError={(e) => setImageFallback(e.currentTarget, BANNER_FALLBACK)}
        />
        {activeBackgroundImage ? (
          <img className="ambientBgCustom" src={activeBackgroundImage} alt="" />
        ) : null}
        <div className="ambientBgShade" />
      </div>

      {/* Top bar */}
      <header className="topBar">
        <a className="brand" href="#" aria-label="SVD Music">
          <img
            src="/images/Logo.png"
            alt="SVD Music"
          />
        </a>

        <div
          className="searchWrap"
          onFocus={() => setIsSearchFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setIsSearchFocused(false);
            }
          }}
        >
          <label className={`searchBox ${isSearchFocused ? "isFocused" : ""}`}>
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && liveSearchResults[0]) {
                  event.preventDefault();
                  selectSearchResult(liveSearchResults[0].index);
                }
                if (event.key === "Escape") setIsSearchFocused(false);
              }}
              placeholder="Tìm bài hát, nghệ sĩ, mood..."
            />
            {query ? (
              <button
                type="button"
                className="searchClear"
                onClick={() => { setQuery(""); setIsSearchFocused(true); }}
                aria-label="Xóa tìm kiếm"
              >
                <X size={13} />
              </button>
            ) : null}
          </label>

          {shouldShowLiveSearch ? (
            <div className="searchResults" role="listbox" aria-label="Kết quả tìm kiếm">
              {liveSearchResults.length ? (
                liveSearchResults.map((song) => {
                  const userCover = song.coverKey ? userCoverUrls[song.id]?.url : null;
                  const coverSrc = userCover || song.cover;
                  return (
                    <button
                      type="button"
                      className={`searchResult ${song.index === currentIndex ? "isCurrent" : ""}`}
                      key={song.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectSearchResult(song.index)}
                      onContextMenu={(event) => handleSongContextMenu(event, song)}
                    >
                      <img
                        src={coverSrc}
                        alt=""
                        onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                      />
                      <span className="searchResultMeta">
                        <strong>{song.title}</strong>
                        <small>{song.artist}</small>
                      </span>
                      <span className="searchTag">{song.tags?.[0] ?? "Song"}</span>
                    </button>
                  );
                })
              ) : (
                <p className="searchEmpty">Không tìm thấy bài hát</p>
              )}
            </div>
          ) : null}
        </div>

        <div className="topBarActions">
          <AddSongButton onClick={() => setIsAddSongOpen(true)} />
          <SettingsButton onClick={() => setIsSettingsOpen(true)} />
          <button
            type="button"
            className="topBadge topBadgeButton"
            onClick={() => setIsLibraryOpen((prev) => !prev)}
            aria-expanded={isLibraryOpen}
            aria-haspopup="dialog"
          >
            <Headphones size={15} />
            <span>{allSongs.length} bài</span>
          </button>
          <SongLibraryPopover
            open={isLibraryOpen}
            onClose={() => setIsLibraryOpen(false)}
            songs={allSongs}
            favoritesMap={favoritesMap}
            currentSongId={currentSong?.id}
            onPlaySong={playSongFromLibrary}
          />
        </div>
      </header>

      {/* Main content */}
      <main className={`pageGrid view-${viewMode}`} style={{ minHeight: 0 }}>
        {/* Lyrics view */}
        {viewMode === "lyrics" ? (
          <>
            {/* Lyrics panel — disc + lyrics */}
            <section className={`lyricsPanel ${isPlaying ? "isPlaying" : ""}`}>
              <img
                className="lyricsBgImage"
                src={resolvedBannerUrl || currentSong?.banner || currentSong?.cover}
                alt=""
                onError={(e) => setImageFallback(e.currentTarget, BANNER_FALLBACK)}
              />
              <div className="lyricsBgShade" />

              <div className="lyricsStage">
                <div className="songAction">
                  <div className="discWrap">
                    <img
                      src={resolvedCoverUrl || currentSong.cover}
                      alt={currentSong.title}
                      onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                    />
                  </div>
                </div>

                <div className="lyricsColumn">
                  <div
                    className="lyricsBox fixedLyricsWindow"
                    ref={lyricsBoxRef}
                  >
                    {lyrics.length ? (
                      (() => {
                        // Fixed 5-slot window: always render exactly 5
                        // buttons, with the active lyric pinned to slot 2
                        // (zero-indexed). Missing lines at the very start
                        // or end of the song are rendered as empty
                        // placeholders so the active line never drifts.
                        const LYRIC_WINDOW_SIZE = 5;
                        const RADIUS = 2;
                        const centerIndex = activeLyricIndex >= 0
                          ? activeLyricIndex
                          : 0;
                        const total = lyrics.length;

                        const visibleLyrics = Array.from(
                          { length: LYRIC_WINDOW_SIZE },
                          (_, slotIndex) => {
                            const offset = slotIndex - RADIUS;
                            const originalIndex = centerIndex + offset;
                            const line = lyrics[originalIndex] || null;
                            const isActive =
                              offset === 0 && originalIndex >= 0 &&
                              originalIndex < total;
                            return { slotIndex, originalIndex, line, isActive };
                          }
                        );

                        // Log the actual rendered active index so we can
                        // verify the JSX is reading the right state.
                        const activeSlot = visibleLyrics.find((v) => v.isActive);
                        if (activeSlot && activeLyricIndexDebugRef.current !== activeSlot.originalIndex) {
                          activeLyricIndexDebugRef.current = activeSlot.originalIndex;
                          console.log(
                            `[LRC UI] render activeIndex=${activeSlot.originalIndex} text="${activeSlot.line ? activeSlot.line.text : ""}"`
                          );
                        }

                        return (
                          <div className="lyricsTrack">
                            {visibleLyrics.map((item) => (
                              <button
                                type="button"
                                key={`slot-${item.slotIndex}-idx-${item.originalIndex}`}
                                ref={(el) => {
                                  if (item.line) {
                                    lyricLineRefs.current[item.originalIndex] = el;
                                  }
                                }}
                                className={
                                  "lyricLine" +
                                  (item.isActive ? " activeLyric" : "") +
                                  (!item.line ? " empty" : "")
                                }
                                disabled={!item.line}
                                onClick={() => {
                                  if (!item.line) return;
                                  handleLyricJump(item.line, item.originalIndex);
                                }}
                                aria-label={item.line ? `Tua tới đoạn: ${item.line.text}` : undefined}
                                aria-current={item.isActive ? "true" : undefined}
                              >
                                {item.line ? item.line.text : "\u00A0"}
                              </button>
                            ))}
                          </div>
                        );
                      })()
                    ) : (
                      <p className="lyricNotice">{lyricStatus}</p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : (
          <>
            {/* Now Playing — left panel */}
            <section className="nowPlaying">
              <div className="nowPlayingTop">
                {currentSong ? (
                  <>
              <div className="coverStack">
                <img
                  className="coverGlow"
                  src={resolvedCoverUrl || currentSong.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <img
                  className="coverBase"
                  src={resolvedCoverUrl || currentSong.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <img
                  className="coverRed"
                  src={resolvedCoverUrl || currentSong.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <img
                  className="coverCyan"
                  src={resolvedCoverUrl || currentSong.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <div className="coverBands">
                  <div className="coverBand b1"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b2"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b3"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b4"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b5"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b6"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b7"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b8"><img src={resolvedCoverUrl || currentSong.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                </div>
                <div className="coverFrags">
                  <div className="coverFrag f1" />
                  <div className="coverFrag f2" />
                  <div className="coverFrag f3" />
                  <div className="coverFrag f4" />
                  <div className="coverFrag f5" />
                  <div className="coverFrag f6" />
                  <div className="coverFrag f7" />
                  <div className="coverFrag f8" />
                </div>
                <div className="coverScan" />
                <div className="coverNoise" />
              </div>

              <div className="songHero">
                <div className="eyebrow">
                  <Waves size={15} />
                  <span>Đang phát</span>
                </div>
                <h2>{currentSong.title}</h2>
<p className="artistName">{currentSong.artist}</p>

            {audioMissing ? (
              <p className="nowPlayingMissing" role="status">
                Chưa có file MP3.
              </p>
            ) : null}

            <div className="tagRow">
              {currentSong.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>

            <p className="liveLyric">{activeLyricText}</p>
              </div>

                </>
              ) : (
                <div className="emptyPlayer">
                  <div className="emptyPlayerIcon" aria-hidden="true">♪</div>
                  <h1>Chưa có bài hát nào</h1>
                  <p className="artistName">Bấm nút <strong>+</strong> để thêm bài hát đầu tiên của bạn.</p>
                </div>
              )}
              </div>

              {currentSong ? (
                <div className="weatherSlot">
                  <WeatherWidget />
                </div>
              ) : null}

              <div className="nowPlayingBottom" aria-live="polite">
                <span className="typingText">
                  {typingDisplay}
                  <span className="typingCursor" aria-hidden="true" />
                </span>
              </div>
            </section>

            {/* Song list — right panel */}
            <section className="songListPanel">
              <div className="sectionTitle">
                <ListMusic size={16} />
                <h2>Danh sách bài hát</h2>
              </div>

<div className="songList">
              {filteredSongs.map((song) => {
                const userCover = song.coverKey ? userCoverUrls[song.id]?.url : null;
                const coverSrc = userCover || song.cover;
                return (
                  <button
                    type="button"
                    key={song.id}
                    className={`songRow ${song.index === currentIndex ? "isActive" : ""} ${song.audioMissing ? "isMissingAudio" : ""}`}
                    onClick={() => selectSong(song.index)}
                    onContextMenu={(event) => handleSongContextMenu(event, song)}
                  >
                    <span className="rowIndex">{String(song.index + 1).padStart(2, "0")}</span>
                    <span className="rowCover">
                      <img
                        src={coverSrc}
                        alt={song.title}
                        onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                      />
                    </span>
                    <span className="songMeta">
                      <strong>{song.title}</strong>
                      <small>{song.artist}</small>
                    </span>
                    <span className="songTag">{song.tags?.[0] ?? "Song"}</span>
                  </button>
                );
              })}
            </div>
            </section>
          </>
        )}
      </main>

      {/* Player bar */}
      <footer className="playerBar">
        {/* MP3-related notices (missing file / load error) are surfaced
            exclusively inside the nowPlaying section above. The playerBar
            itself stays free of those banners so the controls stay calm. */}
        {currentSong ? (
          <audio
            ref={audioRef}
            src={audioMissing ? undefined : (resolvedAudioUrl || currentSong.audio)}
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={handlePlayEvent}
            onPause={handlePauseEvent}
            onSeeked={handleSeekedEvent}
            onEnded={handleEndedEvent}
            onError={() => {
              if (currentSong.audioKey || currentSong.audioMissing) {
                setAudioLoadError("Không phát được file MP3 từ bộ nhớ cục bộ.");
              }
            }}
          />
        ) : null}

        {currentSong ? (
          <div className="miniSong">
            <span className={`miniEqualizer ${isPlaying ? "isActive" : ""}`} aria-hidden="true">
              <span className="eq1" />
              <span className="eq2" />
              <span className="eq3" />
            </span>
            <span className="miniCover">
              <img
                src={resolvedCoverUrl || currentSong?.cover}
                alt={currentSong?.title || ""}
                onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
              />
            </span>
            <div>
              <strong>{currentSong.title}</strong>
              <span>{currentSong.artist}</span>
            </div>
          </div>
        ) : (
          <div className="miniSong miniSongEmpty">
            <span className={`miniEqualizer ${isPlaying ? "isActive" : ""}`} aria-hidden="true">
              <span className="eq1" />
              <span className="eq2" />
              <span className="eq3" />
            </span>
            <div className="miniSongPlaceholder" aria-hidden="true">♪</div>
            <div>
              <strong>Chưa phát</strong>
              <span>Thêm bài hát để bắt đầu</span>
            </div>
          </div>
        )}

        <div className="playerCenter">
          <div className="playerButtons">
            <button type="button" onClick={() => playByDirection(-1)} aria-label="Previous" disabled={!currentSong}>
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              className="miniPlayButton"
              onPointerDown={handlePlayControlPointerDown}
              onClick={handlePlayControlClick}
              onKeyDown={handlePlayControlKeyDown}
              aria-label={isPlaying ? "Pause" : "Play"}
              disabled={!currentSong}
            >
              {isPlaying ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
            </button>
            <button type="button" onClick={() => playByDirection(1)} aria-label="Next" disabled={!currentSong}>
              <SkipForward size={16} />
            </button>
          </div>

          <div className="seekRow">
            <span>{formatTime(seekValue)}</span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              step="0.1"
              value={seekValue}
              onPointerDown={beginSeek}
              onPointerUp={commitSeek}
              onPointerCancel={cancelSeek}
              onChange={previewSeek}
              onKeyDown={beginKeyboardSeek}
              onKeyUp={commitKeyboardSeek}
              onBlur={() => { if (isSeekingRef.current) commitSeek(); }}
              style={{ "--progress": `${seekProgress}%` }}
            />
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="playerRight">
          <button
            type="button"
            className={isShuffle ? "isToggled" : ""}
            onClick={() => setIsShuffle((v) => !v)}
            aria-label="Shuffle"
          >
            <Shuffle size={16} />
          </button>
          <button
            type="button"
            className={`repeatButton isRepeat-${repeatMode} ${repeatMode !== "off" ? "isToggled" : ""}`}
            onClick={cycleRepeatMode}
            aria-label={repeatLabel}
            title={repeatLabel}
          >
            <Repeat size={16} />
            {repeatBadge ? <span className="repeatBadge">{repeatBadge}</span> : null}
          </button>
          <button
            type="button"
            className={`micButton ${viewMode === "lyrics" ? "isActive" : ""}`}
            onClick={() => setViewMode((v) => v === "list" ? "lyrics" : "list")}
            aria-label="Chuyển chế độ xem lyrics"
            title="Lyrics / Danh sách"
          >
            {viewMode === "lyrics" ? <ListMusic size={16} /> : <Mic size={16} />}
          </button>
          <label className="volumeControl">
            <button
              type="button"
              className="volumeToggle"
              onClick={toggleMute}
              aria-label={volume === 0 ? "Bật tiếng" : "Tắt tiếng"}
              title={volume === 0 ? "Bật tiếng" : "Tắt tiếng"}
            >
              {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                if (nextValue > 0) {
                  previousVolumeRef.current = nextValue;
                  isMutedRef.current = false;
                }
                setVolume(nextValue);
              }}
              style={{ "--progress": `${volume}%` }}
            />
          </label>
        </div>
      </footer>

      <AddSongModal
        open={isAddSongOpen}
        onClose={() => setIsAddSongOpen(false)}
      />

      <SettingsModal
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        theme={theme}
        setTheme={setTheme}
        backgroundGallery={backgroundGallery}
        activeBackgroundId={activeBackgroundId}
        handleAddBackgroundImages={handleAddBackgroundImages}
        handleSelectBackgroundImage={handleSelectBackgroundImage}
        handleDeleteBackgroundImage={handleDeleteBackgroundImage}
        activeBackgroundImage={activeBackgroundImage}
        backgroundOpacity={backgroundOpacity}
        setBackgroundOpacity={setBackgroundOpacity}
        autoRotateBackground={autoRotateBackground}
        setAutoRotateBackground={setAutoRotateBackground}
      />

      <SongContextMenu
        open={!!contextMenu}
        song={contextMenu?.song ?? null}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        onClose={handleCloseContextMenu}
        onDeleted={handleSongDeleted}
      />
    </div>
  );
}

export default App;
