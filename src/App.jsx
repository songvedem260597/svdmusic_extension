import {
  Headphones,
  ListMusic,
  Maximize2,
  Mic,
  Pause,
  Pin,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ViewModeButton from "./components/ViewModeButton.jsx";
import ViewModeToast from "./components/ViewModeToast.jsx";
import WeatherWidget from "./components/WeatherWidget.jsx";
import { getMoodQuote } from "./services/moodQuoteApi.js";
import {
  startBassReactiveCover,
  pauseBassReactiveCover,
  resumeBassReactiveCover,
  disposeBassReactiveCover,
} from "./utils/bassReactiveCover.js";
import {
  detectViewMode,
  detectPopupSurface,
  getTransferIdFromUrl,
  getStandaloneUrl,
  createViewTransfer,
  readActiveViewTransfer,
  writeActiveViewTransfer,
  updateActiveViewTransfer,
  upsertActiveViewTransfer,
  clearActiveViewTransfer,
  readSessionValue,
  writeSessionValue,
  removeSessionValue,
  ACTIVE_VIEW_TRANSFER_KEY,
  VIEW_OWNER_KEY,
  STANDALONE_TAB_ID_KEY,
  STANDALONE_WINDOW_ID_KEY,
  ORIGIN_WINDOW_ID_KEY,
  STANDALONE,
  SIDEPANEL,
  VIEW_TRANSFER_TIMEOUT_MS,
  isMeaningfulSnapshot,
  postViewMessage,
  subscribeViewMessages,
  buildPlaybackSnapshot,
  viewModeLog,
  viewModeWarn,
} from "./utils/viewMode.js";

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

// ── View-transfer helpers (used inside App component) ──────────────────────

async function readViewOwner() {
  return readSessionValue(VIEW_OWNER_KEY);
}

async function writeViewOwner(mode, instanceId, tabId) {
  return writeSessionValue(VIEW_OWNER_KEY, {
    mode,
    instanceId,
    tabId: tabId ?? null,
    updatedAt: Date.now(),
  });
}

async function clearViewOwnerIfMatches(instanceId) {
  try {
    const owner = await readViewOwner();
    if (owner && owner.instanceId === instanceId) {
      await removeSessionValue(VIEW_OWNER_KEY);
    }
  } catch (_) { /* noop */ }
}

function App() {
  // Stable per-instance identifier. Used to arbitrate audio ownership
  // between the sidepanel and standalone tab contexts — a UUID created once
  // at mount so the same instance is recognisable even across page reloads.
  const instanceIdRef = useRef(typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Math.random()) + String(Date.now())
  );

  // Audio-ownership gate ref — checked synchronously inside audio.play() calls.
  // Set to true only when this instance holds the chrome.storage.session owner
  // record. Unlike `ownsAudio` React state, this ref is immune to stale-closure
  // races inside RAF / event handlers that run after the owning view unmounts.
  const ownsAudioRef = useRef(false);

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

  // Holds the incoming playback snapshot while a transfer target is
  // restoring playback. Cleared only after the snapshot has been fully
  // applied (song matched + metadata loaded + seek succeeded).
  // This prevents the pre-mount restore effect from clobbering the
  // incoming handoff with a stale zero-state.
  const pendingViewSnapshotRef = useRef(null);

  // True while a transfer is mid-flight and the source might need to rollback.
  // Used to suppress pause-persist saves during transfer rollback.
  const isTransferringRef = useRef(false);

  // Tracks pending async cleanup (e.g. close-tab after READY received)
  // so it can be cancelled if a rollback races in.
  const viewTransferCleanupRef = useRef(null);

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

  // Sidepanel ↔ standalone view-mode bookkeeping.
  // `surfaceMode` is derived once from `location.search` and never flips
  // for the lifetime of this App instance — a reload is the only way
  // to switch contexts, which is exactly what we want.
  // NOTE: this variable intentionally avoids the name `viewMode` because
  // that name is already used by the existing React state for the
  // "list | lyrics" toggle. Renaming the existing state would touch
  // dozens of unrelated call sites; the new surface-mode value lives
  // alongside it under a different name.
  const surfaceMode = detectViewMode();
  const isStandalone = surfaceMode === "standalone";
  // True when the standalone surface is a popup window (not a regular tab).
  const isPopupSurface = detectPopupSurface();
  try {
    console.log("[VIEW_BOOT]", {
      href: typeof window !== "undefined" ? window.location.href : null,
      surfaceMode,
      isStandalone,
      search: typeof window !== "undefined" ? window.location.search : null,
    });
  } catch (_) { /* noop */ }
  // True while a detach/pin click is mid-flight. Disables the
  // view-mode button so the user can't double-click.
  const [isViewTransitioning, setIsViewTransitioning] = useState(false);
  // Short user-visible toast for errors that aren't already surfaced
  // (open tab failed, sidePanel.open failed, restore failed, etc).
  const [viewModeToast, setViewModeToast] = useState("");
  // Local audio-ownership flag — mirrors what the BroadcastChannel
  // handshake established. Only the owner may call `audio.play()`.
  // We start as the owner because:
  //   - there's at most one view alive on mount (user can't open two
  //     simultaneously).
  //   - if the other view comes alive later, it sends REQUEST_OWNERSHIP
  //     and we drop to non-owner.
  const [ownsAudio, setOwnsAudio] = useState(true);

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
  //   "hold"      → full text remains visible for 2 min, then "loading"
  //
  // Timings (per spec):
  //   character  → (58 + rand(34)) ms  × 1.25  →  72-115 ms
  //   punctuation ,.!?:; → 360 ms  × 1.25  →  450 ms
  //   space → 45 ms  × 1.25  →  56 ms
  //   hold before next API request → 120000 ms
  //
  // The 1.25× factor slows the typing speed by 20% (display still feels
  // organic thanks to the per-char jitter, but reads more deliberately).

  const TYPING_SPEED_FACTOR = 1.25;
  const QUOTE_RESUME_DELAY_MS = 2 * 60 * 1000;

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
            // Keep the completed quote on screen until the next API refresh.
            timer = setTimeout(() => advance("load", {}), QUOTE_RESUME_DELAY_MS);
          }
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
    // Audio ownership gate. Only the active view (sidepanel or
    // standalone) may call play(). The non-owner keeps its <audio>
    // paused and its UI responsive so a subsequent swap is instant.
    if (!ownsAudio) {
      viewModeLog("playAudio blocked: not the audio owner");
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
    // Route through playAudio() so the ownership gate applies
    // uniformly — a lyric click in the non-owner view should not
    // start audio playback.
    playAudio();
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
    // Skip if a view transfer is mid-flight — the source side is about to
    // lose ownership and a snapshot from the rolling-back instance would
    // clobber the session with a post-pause time.
    if (currentSong && !isTransferringRef.current) {
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
    `svdmusic-view-${surfaceMode}`,
    isPopupSurface ? "svdmusic-surface-popup" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Sidepanel ↔ standalone: snapshot + ownership helpers ──────────────
  //
  // These helpers are defined here (after `currentSong` / `currentIndex`
  // are stable for this render) so the click handlers below can capture
  // the live state via refs. We never call `persistPlaybackSession`
  // directly — the existing throttle / restore guards in
  // `persistPlaybackSession` already cover all the awkward
  // "during-restore" timing windows, and we route every transition
  // through the same helper so the on-disk record stays canonical.
  function capturePlaybackSnapshot() {
    const audio = audioRef.current;
    const liveTime =
      audio && Number.isFinite(audio.currentTime)
        ? audio.currentTime
        : currentTimeRef.current;
    const liveDuration =
      audio && Number.isFinite(audio.duration) ? audio.duration : duration;
    return buildPlaybackSnapshot({
      activeSong: currentSong,
      currentTime: liveTime,
      duration: liveDuration,
      isPlaying,
      volume,
      repeatMode,
      isShuffle,
      isMuted: isMutedRef.current,
    });
  }

  // Force-pause and forget ownership. Used by the current owner right
  // before a handoff (sidepanel detaches, standalone pins back). Safe
  // to call when we don't currently own the audio — it no-ops.
  function releaseAudioOwnershipLocal() {
    if (!ownsAudio) return;
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch (_) {
        /* noop */
      }
    }
    setIsPlaying(false);
    setOwnsAudio(false);
  }

  // Async version — writes chrome.storage.session.owner first, then updates
  // refs. Use this for structured transfer handoffs where the session record
  // must be in place before any BroadcastChannel message fires.
  async function acquireAudioOwnership(tabId) {
    const mode = surfaceMode;
    const instanceId = instanceIdRef.current;
    await writeViewOwner(mode, instanceId, tabId ?? null);
    ownsAudioRef.current = true;
    setOwnsAudio(true);
  }

  // Async version — clears ownsAudioRef IMMEDIATELY so no concurrent play()
  // call races in, then clears the session owner only if it still belongs
  // to us (another view might have already overwritten it).
  async function releaseAudioOwnership() {
    ownsAudioRef.current = false;
    setOwnsAudio(false);
    await clearViewOwnerIfMatches(instanceIdRef.current);
  }

  // Apply a pending view transfer snapshot to live React state.
  // Called from the storage-change listener when this instance is the
  // intended target. Blocks normal session restore so the incoming
  // handoff snapshot takes priority.
  function applyPendingViewSnapshot(snapshot) {
    if (!snapshot || !isMeaningfulSnapshot(snapshot)) return;
    viewModeLog("applying pending view snapshot", snapshot);
    if (typeof snapshot.volume === "number" && Number.isFinite(snapshot.volume)) {
      setVolume(Math.max(0, Math.min(100, snapshot.volume)));
    }
    if (snapshot.muted === true) {
      isMutedRef.current = true;
      if (audioRef.current) audioRef.current.muted = true;
    }
    if (snapshot.repeat === "off" || snapshot.repeat === "one" || snapshot.repeat === "all") {
      setRepeatMode(snapshot.repeat);
    }
    if (typeof snapshot.shuffle === "boolean") setIsShuffle(snapshot.shuffle);

    // Mark this so the normal session restore effect does not clobber the
    // incoming handoff with a stale zero-state.
    pendingViewSnapshotRef.current = snapshot;
    restoreInProgressRef.current = true;
    restoreAppliedRef.current = false;
  }

  // Async seek after loadedmetadata — driven by the normal playback restore
  // machinery. The pending snapshot carries the target song + time.
  // Returns a Promise that resolves when the restore is confirmed.
  // IMPORTANT: checks transferId at every step to bail out if the transfer
  // was cancelled while we were polling.
  async function restorePendingSnapshotAfterMetadata() {
    const snap = pendingViewSnapshotRef.current;
    if (!snap) return;

    // Capture the transferId so we can abort if the transfer became stale.
    const snapTransferId = snap.transferId || "";
    viewModeLog("restoring pending snapshot after metadata", { snap, snapTransferId });

    // Guard: verify the transfer is still active before doing any work.
    // Self-heals session storage when Chrome dropped our entry mid-restore
    // (e.g. extension reload, SW crash, or another tab.onRemoved race).
    // We still bail if the active transfer belongs to a DIFFERENT
    // transferId — that means a brand-new detach/pin started and we
    // must not steal it.
    async function checkActiveTransfer() {
      if (!snapTransferId) return true;
      try {
        const active = await readActiveViewTransfer();
        if (!active || active.transferId !== snapTransferId) {
          // Try to self-heal: re-stamp this transferId as target-restoring.
          // Uses upsert so an empty session is refilled without clobbering
          // a newer transfer that has taken the slot.
          try {
            const healed = await upsertActiveViewTransfer(
              snapTransferId,
              {
                transferId: snapTransferId,
                status: "target-restoring",
                updatedAt: Date.now(),
              },
              { status: "target-restoring" },
            );
            if (healed && healed.transferId === snapTransferId) {
              viewModeLog("self-healed stale transfer during restore", snapTransferId);
              return true;
            }
          } catch (_) { /* fall through to abort */ }
          viewModeWarn("transfer no longer active, aborting restore", snapTransferId);
          return false;
        }
        if (active.status !== "target-restoring") {
          viewModeWarn("transfer status changed, aborting restore", active.status);
          return false;
        }
      } catch (_) {
        return false;
      }
      return true;
    }

    try {
      // Step 1: Spin until the audio src matches the snapshot's song.
      const songId = snap.songId || "";
      const videoId = snap.videoId || "";
      const maxWait = 8000;
      const pollStart = Date.now();
      let songMatched = false;
      while (Date.now() - pollStart < maxWait) {
        if (!(await checkActiveTransfer())) return;
        const cur = currentSong;
        if (cur && (cur.id === songId || cur.videoId === videoId)) {
          songMatched = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!songMatched) {
        viewModeWarn("snapshot song match timeout");
        return;
      }

      // Step 2: Wait for Blob URL to resolve.
      if (!resolvedAudioUrl) {
        if (!(await checkActiveTransfer())) return;
        await new Promise((r) => setTimeout(r, 500));
        if (!(await checkActiveTransfer())) return;
      }

      // Step 3: Now the audio element has the correct src. Wait loadedmetadata.
      const audio = audioRef.current;
      if (!audio) return;
      if (!(await checkActiveTransfer())) return;
      if (audio.readyState < 2) {
        await new Promise((resolve) => {
          const handler = () => {
            audio.removeEventListener("loadedmetadata", handler);
            audio.removeEventListener("error", handler);
            resolve();
          };
          audio.addEventListener("loadedmetadata", handler);
          audio.addEventListener("error", handler);
          setTimeout(resolve, 8000); // fallback
        });
        if (!(await checkActiveTransfer())) return;
      }

      // Step 4: Validate duration and seek.
      const liveDuration = Number(audio.duration);
      const hasDuration = Number.isFinite(liveDuration) && liveDuration > 0;
      const requestedTime = Math.max(0, Number(snap.currentTime || 0));
      if (!hasDuration || !Number.isFinite(requestedTime)) {
        viewModeWarn("snapshot restore: invalid duration or time", { liveDuration, requestedTime });
        return;
      }

      const clampedTime = Math.min(requestedTime, Math.max(0, liveDuration - 0.5));
      if (!(await checkActiveTransfer())) return;
      try {
        audio.currentTime = clampedTime;
      } catch (err) {
        viewModeWarn("snapshot seek failed", err);
        return;
      }
      currentTimeRef.current = clampedTime;
      setCurrentTime(clampedTime);
      pendingViewSnapshotRef.current = null;
      restoreInProgressRef.current = false;
      restoreAppliedRef.current = true;
      lastAppliedRestoreTimeRef.current = clampedTime;
      viewModeLog("snapshot fully restored", {
        clampedTime,
        liveDuration,
        isPlaying: snap.isPlaying,
      });
    } finally {
      // Always clear the pending state so the UI doesn't stay stuck in
      // "restoring" if we exited early or hit an error.
      pendingViewSnapshotRef.current = null;
      restoreInProgressRef.current = false;
    }
  }

  // ── Transfer detection refs / shared handler ─────────────────────────────
  // Cùng một transfer có thể xuất hiện qua cả mount-reconciliation và
  // storage.session.onChanged (duplicate detection). Hai Set này gate
  // trước khi gọi processIncomingViewTransfer.
  const processingTransferIdsRef = useRef(new Set());
  const completedTransferIdsRef = useRef(new Set());

  // Stable refs for the helper functions so processIncomingViewTransfer
  // can stay a useCallback with [] deps and the storage-listener effect
  // does not tear down + re-register on every render.
  const acquireAudioOwnershipRef = useRef(null);
  const applyPendingViewSnapshotRef = useRef(null);
  const restorePendingSnapshotAfterMetadataRef = useRef(null);
  acquireAudioOwnershipRef.current = acquireAudioOwnership;
  applyPendingViewSnapshotRef.current = applyPendingViewSnapshot;
  restorePendingSnapshotAfterMetadataRef.current = restorePendingSnapshotAfterMetadata;

  // ── Hàm dùng chung: xử lý một transfer nhắm tới view hiện tại ───────
  // Phục vụ cả 3 entry path:
  //   (a) standalone popup mount bằng URL?transferId=… (target=standalone)
  //   (b) sidepanel mount-reconciliation (target=sidepanel)
  //   (c) sidepanel storage.session.onChanged (target=sidepanel)
  // READY chỉ gửi SAU KHI ownership/snapshot restore hoàn tất.
  const processIncomingViewTransfer = useCallback(async function processIncomingViewTransfer(transfer, trigger) {
    const transferId = transfer?.transferId;
    try {
      console.log("[TRANSFER] ENTER", {
        trigger,
        currentSurfaceMode: surfaceMode,
        transfer,
      });
    } catch (_) { /* noop */ }
    if (!transfer || typeof transferId !== "string" || !transferId) {
      try { console.debug("[TRANSFER] SKIP", { reason: "missing_transfer", trigger, surfaceMode }); } catch (_) {}
      return;
    }
    if (processingTransferIdsRef.current.has(transferId)) {
      try { console.debug("[TRANSFER] SKIP", { reason: "processing", trigger, transferId, surfaceMode }); } catch (_) {}
      return;
    }
    if (completedTransferIdsRef.current.has(transferId)) {
      try { console.debug("[TRANSFER] SKIP", { reason: "completed", trigger, transferId, surfaceMode }); } catch (_) {}
      return;
    }
    const expectedTarget = surfaceMode;
    if (transfer.targetMode !== expectedTarget) {
      try {
        console.warn("[TRANSFER] REJECT", {
          reason: "wrong_target",
          trigger,
          transferId,
          surfaceMode,
          expectedTarget,
          transferTargetMode: transfer.targetMode,
        });
      } catch (_) {}
      return;
    }
    if (
      transfer.status !== "waiting-target" &&
      transfer.status !== "target-restoring"
    ) {
      try {
        console.warn("[TRANSFER] REJECT", {
          reason: "bad_status",
          trigger,
          transferId,
          surfaceMode,
          status: transfer.status,
        });
      } catch (_) {}
      return;
    }
    // Pending snapshot phải cùng transferId (nếu tồn tại).
    let pendingSnap = null;
    try {
      pendingSnap = await readSessionValue("svdmusic.pendingViewSnapshot");
    } catch (_) { /* noop */ }
    if (
      pendingSnap &&
      typeof pendingSnap === "object" &&
      pendingSnap.transferId &&
      pendingSnap.transferId !== transferId
    ) {
      try {
        console.warn("[TRANSFER] REJECT", {
          reason: "snapshot_mismatch",
          trigger,
          transferId,
          surfaceMode,
          pendingTransferId: pendingSnap.transferId,
        });
      } catch (_) {}
      return;
    }
    // Sidepanel target → window phải khớp với transfer.originWindowId.
    if (surfaceMode === SIDEPANEL && typeof transfer.originWindowId === "number") {
      try {
        const w = await chrome.windows?.getCurrent?.();
        const currentWId = w?.id ?? null;
        if (currentWId != null && currentWId !== transfer.originWindowId) {
          try {
            console.warn("[TRANSFER] REJECT", {
              reason: "wrong_window",
              trigger,
              transferId,
              surfaceMode,
              currentWindowId: currentWId,
              originWindowId: transfer.originWindowId,
            });
          } catch (_) {}
          return;
        }
      } catch (_) { /* noop */ }
    }
    processingTransferIdsRef.current.add(transferId);
    let currentWindowId = null;
    if (surfaceMode === SIDEPANEL) {
      try {
        const w = await chrome.windows?.getCurrent?.();
        currentWindowId = w?.id ?? null;
      } catch (_) { /* noop */ }
    }
    let sentReady = false;
    try {
      try {
        console.log("[SIDEPANEL] TRANSFER_DETECTED", {
          trigger,
          transferId,
          status: transfer.status,
          target: transfer.targetMode,
          originWindowId: transfer.originWindowId ?? null,
          currentWindowId,
        });
      } catch (_) { /* noop */ }

      const updated = await updateActiveViewTransfer(transferId, {
        status: "target-restoring",
      });
      if (!updated) return; // transfer đã bị overwrite hoặc stale

      await acquireAudioOwnershipRef.current?.();
      try {
        console.log("[SIDEPANEL] OWNERSHIP_ACQUIRED", { trigger, transferId });
      } catch (_) { /* noop */ }

      const snapshotToApply =
        pendingSnap && pendingSnap.transferId === transferId
          ? pendingSnap
          : (transfer.snapshot || null);
      if (snapshotToApply && isMeaningfulSnapshot(snapshotToApply)) {
        applyPendingViewSnapshotRef.current?.(snapshotToApply);
        try {
          console.log("[SIDEPANEL] SNAPSHOT_APPLIED", {
            trigger,
            transferId,
            songId: snapshotToApply.songId,
            currentTime: snapshotToApply.currentTime,
            isPlaying: !!snapshotToApply.isPlaying,
          });
        } catch (_) { /* noop */ }
        await restorePendingSnapshotAfterMetadataRef.current?.();
      }

      const readyType =
        surfaceMode === STANDALONE
          ? "player/standalone-ready"
          : "player/sidepanel-ready";
      const readyPayload = {
        transferId,
        instanceId: instanceIdRef.current,
      };
      if (surfaceMode === STANDALONE) {
        const winState = await chrome.storage.session.get(STANDALONE_WINDOW_ID_KEY);
        readyPayload.standaloneWindowId =
          winState?.[STANDALONE_WINDOW_ID_KEY] ?? null;
      } else {
        readyPayload.originWindowId = transfer.originWindowId ?? null;
      }

      try {
        console.log("[SIDEPANEL] SENDING_READY", {
          trigger,
          transferId,
          readyType,
          payload: readyPayload,
        });
      } catch (_) { /* noop */ }

      await chrome.runtime.sendMessage({ type: readyType, ...readyPayload });
      sentReady = true;

      try {
        console.log("[SIDEPANEL] READY_SENT", {
          trigger,
          transferId,
          readyType,
        });
      } catch (_) { /* noop */ }

      await updateActiveViewTransfer(transferId, { status: "target-ready" });
      completedTransferIdsRef.current.add(transferId);
    } catch (err) {
      try {
        console.error("[SIDEPANEL] TRANSFER_ERROR", {
          trigger,
          transferId,
          step: sentReady ? "post_ready" : "during_restore_or_send",
          errorName: err?.name ?? null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } catch (_) { /* noop */ }
    } finally {
      processingTransferIdsRef.current.delete(transferId);
    }
  }, [surfaceMode]);

  // ── View-transfer storage session listener (sidepanel-only path C) ────
  // Chỉ sidepanel mới xử lý transfer qua kênh này.
  useEffect(() => {
    try {
      console.log("[SIDEPANEL] STORAGE_LISTENER_EFFECT", {
        surfaceMode,
        willRegister: surfaceMode === SIDEPANEL,
      });
    } catch (_) { /* noop */ }
    if (typeof chrome === "undefined" || !chrome.storage?.session) return undefined;
    if (surfaceMode !== SIDEPANEL) return undefined;
    const handler = (changes, area) => {
      if (area !== "session") return;
      const t = changes?.[ACTIVE_VIEW_TRANSFER_KEY];
      try {
        console.log("[SIDEPANEL] STORAGE_CHANGED", {
          keyPresent: Boolean(changes[ACTIVE_VIEW_TRANSFER_KEY]),
          oldValue: changes[ACTIVE_VIEW_TRANSFER_KEY]?.oldValue,
          newValue: changes[ACTIVE_VIEW_TRANSFER_KEY]?.newValue,
        });
      } catch (_) { /* noop */ }
      if (!t?.newValue) return;
      const transfer = t.newValue;
      if (!transfer || typeof transfer.transferId !== "string") return;
      if (transfer.targetMode !== SIDEPANEL) return;
      void processIncomingViewTransfer(transfer, "session-onchanged");
    };
    const ownerHandler = async (changes, area) => {
      if (area !== "session") return;
      const snapChange = changes["svdmusic.pendingViewSnapshot"];
      if (
        snapChange &&
        snapChange.newValue &&
        snapChange.newValue.targetMode === surfaceMode
      ) {
        applyPendingViewSnapshot(snapChange.newValue);
      }
      const ownerChange = changes[VIEW_OWNER_KEY];
      if (ownerChange && ownerChange.newValue) {
        const owner = ownerChange.newValue;
        if (
          owner.mode === surfaceMode &&
          owner.instanceId === instanceIdRef.current
        ) {
          if (!ownsAudioRef.current) {
            ownsAudioRef.current = true;
            setOwnsAudio(true);
          }
        }
      }
    };
    chrome.storage.session.onChanged.addListener(handler);
    chrome.storage.session.onChanged.addListener(ownerHandler);
    return () => {
      try {
        chrome.storage.session.onChanged.removeListener(handler);
      } catch (_) { /* noop */ }
      try {
        chrome.storage.session.onChanged.removeListener(ownerHandler);
      } catch (_) { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceMode, processIncomingViewTransfer]);

  // ── Mount reconciliation ────────────────────────────────────────────────
  // Sidepanel: không yêu cầu transferId trong URL. Đọc thẳng transfer
  // hiện có từ storage để xử lý (path B). Standalone popup giữ URL path A.
  useEffect(() => {
    try {
      console.log("[SIDEPANEL] MOUNT_RECONCILE_ENTER", {
        surfaceMode,
        expected: SIDEPANEL,
      });
    } catch (_) { /* noop */ }
    if (typeof window === "undefined") return undefined;
    if (surfaceMode === STANDALONE) {
      const urlTransferId = getTransferIdFromUrl();
      if (!urlTransferId) return undefined;
      (async () => {
        const transfer = await readActiveViewTransfer();
        if (!transfer || transfer.transferId !== urlTransferId) return;
        await processIncomingViewTransfer(transfer, "standalone-url-mount");
      })();
      return undefined;
    }
    (async () => {
      const transfer = await readActiveViewTransfer();
      try {
        console.log("[SIDEPANEL] MOUNT_TRANSFER_READ", {
          transfer,
          surfaceMode,
        });
      } catch (_) { /* noop */ }
      if (!transfer) {
        try { console.debug("[SIDEPANEL] MOUNT_SKIP", { reason: "no_transfer", surfaceMode }); } catch (_) {}
        return;
      }
      if (transfer.targetMode !== SIDEPANEL) {
        try {
          console.warn("[SIDEPANEL] MOUNT_REJECT", {
            reason: "wrong_target",
            surfaceMode,
            transferId: transfer?.transferId,
            targetMode: transfer?.targetMode,
          });
        } catch (_) {}
        return;
      }
      if (
        transfer.status !== "waiting-target" &&
        transfer.status !== "target-restoring"
      ) {
        try {
          console.warn("[SIDEPANEL] MOUNT_REJECT", {
            reason: "bad_status",
            surfaceMode,
            transferId: transfer?.transferId,
            status: transfer?.status,
          });
        } catch (_) {}
        return;
      }
      await processIncomingViewTransfer(transfer, "sidepanel-mount");
    })();
    return undefined;
  }, [surfaceMode, processIncomingViewTransfer]);

  // ── View-mode message bus ──────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    viewModeLog("view mounted", { surfaceMode });

    const unsubscribe = subscribeViewMessages((msg) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "view-ready": {
          break;
        }
        case "pending-snapshot": {
          if (msg.payload?.transferId && msg.payload?.snapshot) {
            writeSessionValue("svdmusic.pendingViewSnapshot", {
              ...msg.payload.snapshot,
              targetMode: msg.payload.targetMode,
              transferId: msg.payload.transferId,
            }).catch(() => {});
          }
          break;
        }
        case "transfer-ready": {
          const { transferId: msgTransferId } = msg.payload || {};
          if (!msgTransferId) break;
          viewModeLog("received transfer-ready", msgTransferId);
          (async () => {
            if (viewTransferCleanupRef.current) {
              clearTimeout(viewTransferCleanupRef.current);
              viewTransferCleanupRef.current = null;
            }
            if (surfaceMode === "sidepanel") {
              try {
                const currentWindow = await chrome.windows?.getCurrent?.();
                const winId = currentWindow?.id;
                if (winId != null) {
                  await chrome.runtime.sendMessage({
                    type: "player/sidepanel-close",
                    windowId: winId,
                  });
                }
              } catch (err) {
                viewModeWarn("sidepanel-close after transfer-ready failed", err);
              }
            } else {
              try {
                await chrome.runtime.sendMessage({ type: "player/close-standalone-tab" });
              } catch (_) { /* noop */ }
            }
          })();
          break;
        }
        default:
          break;
      }
    });

    function onPageHide() {
      postViewMessage("view-closing", { viewMode: surfaceMode });
    }
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      unsubscribe();
    };
  }, []);

  // ── View-mode button click handlers ───────────────────────────────────
  //
  // Both flows:
  //   1. Persist the latest snapshot to localStorage so the OTHER view
  //      can pick it up even if the BroadcastChannel handshake fails
  //      (e.g. one side crashed).
  //   2. Disable the button to prevent double-clicks.
  //   3. Hand off via the SW so it can manage chrome.tabs / sidePanel.
  //   4. On error, surface a toast and re-enable the button.
  //
  // We keep the user's click event live so we can pass `userGesture`
  // directly into chrome.sidePanel.open. chrome.sidePanel.open
  // requires a user gesture — bouncing through chrome.runtime will
  // fail silently if the SW tries to open from a non-gesture context.
  // ── Detach: sidepanel → standalone ─────────────────────────────────────────
  // Flow: capture → persist → create transfer metadata → release ownership →
  // post pending-snapshot to storage → create/focus standalone tab → wait
  // STANDALONE_READY with matching transferId → close sidepanel.
  // On error or 10s timeout: rollback ownership, restore state, keep sidepanel.
  async function handleDetachToStandalone() {
    if (isViewTransitioning) return;
    setIsViewTransitioning(true);
    isTransferringRef.current = true;

    // 1. Capture snapshot while audio is still ours.
    let snap;
    try {
      snap = capturePlaybackSnapshot();
    } catch (err) {
      viewModeWarn("capture snapshot failed", err);
    }

    // 2. Persist to localStorage as a fallback (BroadcastChannel may fail).
    try {
      persistPlaybackSession("view-detach", { force: true });
    } catch (err) {
      viewModeWarn("persist on detach failed", err);
    }

    // 3. Create structured transfer metadata.
    const transferId = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Math.random()) + "-" + String(Date.now());
    const originWindowId = await chrome.windows?.getCurrent?.().then(w => w?.id).catch(() => null);
    const transfer = createViewTransfer({
      transferId,
      sourceMode: surfaceMode,
      targetMode: "standalone",
      sourceInstanceId: instanceIdRef.current,
      originWindowId,
    });
    await writeActiveViewTransfer(transfer);

    // 4. Pause and release ownership.
    releaseAudioOwnershipLocal();
    await releaseAudioOwnership();

    // 5. Store pending snapshot in session so the target can read it.
    // Only write the snapshot if we are creating a NEW standalone tab.
    // If an existing tab is already open, it may already have its own
    // snapshot and we don't want to overwrite it with our stale one.
    const url = getStandaloneUrl(transferId);
    if (!url) {
      setViewModeToast("Không thể mở trình phát trong tab riêng.");
      setIsViewTransitioning(false);
      isTransferringRef.current = false;
      await clearActiveViewTransfer(transferId);
      await acquireAudioOwnership();
      if (snap?.isPlaying) {
        try {
          audioRef.current?.play()?.then(() => setIsPlaying(true)).catch(() => {});
        } catch (_) { /* noop */ }
      }
      return;
    }

    // 6. Update transfer to waiting-target.  MUST happen before any
    // tab operation so the target can read the transfer metadata.
    await updateActiveViewTransfer(transferId, { status: "waiting-target" });

    // 7. Set up readyPromise BEFORE we create or focus any tab.
    // This ensures the listener is active the moment the target mounts,
    // even on a fast CPU. The promise races a 10-second timeout against
    // the SW/BroadcastChannel READY signal.
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    const timerId = setTimeout(async () => {
      viewModeWarn("detach timeout: no READY");
      viewTransferCleanupRef.current = null;
      isTransferringRef.current = false;
      await clearActiveViewTransfer(transferId);
      await acquireAudioOwnership();
      setIsViewTransitioning(false);
      if (snap?.isPlaying) {
        try {
          audioRef.current?.play()?.then(() => setIsPlaying(true)).catch(() => {});
        } catch (_) { /* noop */ }
      }
      resolveReady({ timedOut: true });
    }, VIEW_TRANSFER_TIMEOUT_MS);
    viewTransferCleanupRef.current = timerId;

    const clearReadyListeners = () => {
      clearTimeout(timerId);
      viewTransferCleanupRef.current = null;
      if (unsubBc) { unsubBc(); unsubBc = null; }
      if (removeListener) { removeListener(); removeListener = null; }
    };

    // BroadcastChannel listener.
    let unsubBc = null;
    unsubBc = subscribeViewMessages((msg) => {
      if (msg.type === "transfer-ready" && msg.payload?.transferId === transferId) {
        clearReadyListeners();
        resolveReady({ timedOut: false });
      }
    });

    // SW runtime message listener.
    let removeListener = null;
    removeListener = (message) => {
      if (message?.type === "player/standalone-ready" && message?.transferId === transferId) {
        clearReadyListeners();
        resolveReady({ timedOut: false });
      }
    };
    chrome.runtime.onMessage.addListener(removeListener);

    // 8. Duplicate-popup guard: focus existing popup if one exists.
    let existingWindowId = null;
    try {
      const sw = await chrome.storage.session.get("svdmusic.standaloneWindowId");
      const storedId = sw?.["svdmusic.standaloneWindowId"];
      if (typeof storedId === "number") {
        await chrome.windows.get(storedId);
        existingWindowId = storedId; // window still exists
      }
    } catch (_) {
      existingWindowId = null; // window gone, clear path for new popup
    }

    if (existingWindowId != null) {
      viewModeLog("existing popup found, focusing");
      await chrome.windows.update(existingWindowId, { focused: true }).catch(() => {});
      await updateActiveViewTransfer(transferId, {
        status: "waiting-target",
        standaloneWindowId: existingWindowId,
      });
      if (snap) {
        await writeSessionValue("svdmusic.pendingViewSnapshot", {
          ...snap,
          targetMode: "standalone",
          transferId,
        }).catch(() => {});
        postViewMessage("pending-snapshot", {
          transferId,
          snapshot: snap,
          targetMode: "standalone",
        });
      }
      const result = await readyPromise;
      if (result.timedOut) return;
      if (originWindowId != null) {
        try {
          await chrome.runtime.sendMessage({
            type: "player/sidepanel-close",
            windowId: originWindowId,
          });
        } catch (err) {
          viewModeWarn("sidepanel-close after detach READY failed", err);
        }
      }
      return;
    }

    // 9. No existing popup — write pending snapshot and create new popup via SW.
    if (snap) {
      await writeSessionValue("svdmusic.pendingViewSnapshot", {
        ...snap,
        targetMode: "standalone",
        transferId,
      }).catch(() => {});
      postViewMessage("pending-snapshot", {
        transferId,
        snapshot: snap,
        targetMode: "standalone",
      });
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "player/standalone-opened",
        url,
        originWindowId,
      });
      if (!response || response.ok !== true) {
        throw new Error(response?.error || "Tạo cửa sổ thất bại.");
      }
      if (response.standaloneWindowId) {
        await updateActiveViewTransfer(transferId, { standaloneWindowId: response.standaloneWindowId });
      }
      if (response.standaloneTabId) {
        await updateActiveViewTransfer(transferId, { standaloneTabId: response.standaloneTabId });
      }
    } catch (err) {
      viewModeWarn("detach: create tab failed", err);
      setViewModeToast("Không thể mở trình phát trong tab riêng.");
      clearReadyListeners();
      isTransferringRef.current = false;
      await clearActiveViewTransfer(transferId);
      await acquireAudioOwnership();
      setIsViewTransitioning(false);
      if (snap?.isPlaying) {
        try {
          audioRef.current?.play()?.then(() => setIsPlaying(true)).catch(() => {});
        } catch (_) { /* noop */ }
      }
      return;
    }

    // 10. Await READY (or timeout).
    const result = await readyPromise;
    if (result.timedOut) return;

    // 11. Close sidepanel via SW.
    if (originWindowId != null) {
      try {
        await chrome.runtime.sendMessage({
          type: "player/sidepanel-close",
          windowId: originWindowId,
        });
      } catch (err) {
        viewModeWarn("sidepanel-close after detach READY failed", err);
      }
    }
    // Side panel will unmount — don't reset isViewTransitioning.
  }

  // ── Pin back: standalone → sidepanel ───────────────────────────────────────
  // Flow: capture → persist → create transfer → release ownership → open
  // sidepanel directly in user gesture → wait SIDEPANEL_READY with transferId →
  // close standalone tab.
  // On error or 10s timeout: rollback ownership, restore state, keep standalone.
  async function handlePinBackToSidePanel(event) {
    try {
      console.log("[PIN_BACK] ENTER", {
        isStandalone,
        surfaceMode,
        isViewTransitioning,
        isTransferring: isTransferringRef.current,
      });
    } catch (_) { /* noop */ }
    if (isViewTransitioning) {
      try {
        console.warn("[PIN_BACK] EARLY_RETURN", {
          reason: "isViewTransitioning",
          isViewTransitioning,
          isTransferring: isTransferringRef.current,
          surfaceMode,
        });
      } catch (_) { /* noop */ }
      return;
    }
    setIsViewTransitioning(true);
    isTransferringRef.current = true;

    // 1. Capture popupWindowId FIRST.
    // chrome.windows.getCurrent() inside a popup returns the popup's own ID.
    // Capturing it here means we never depend on session state that may
    // have been cleared (e.g. by a previous chrome.windows.onRemoved run)
    // or overwritten by another path.
    let popupWindowId = null;
    try {
      const currentWindow = await chrome.windows.getCurrent();
      popupWindowId = currentWindow?.id ?? null;
    } catch (_) {
      popupWindowId = null;
    }
    try {
      console.log("[PIN_BACK] POPUP_ID_CAPTURED", { popupWindowId });
    } catch (_) { /* noop */ }
    if (popupWindowId == null) {
      try {
        console.warn("[PIN_BACK] EARLY_RETURN", {
          reason: "no_popup_window_id",
          popupWindowId,
          transferId: null,
        });
      } catch (_) { /* noop */ }
      setIsViewTransitioning(false);
      isTransferringRef.current = false;
      return;
    }

    // 2. Capture snapshot while audio is still ours.
    let snap;
    try {
      snap = capturePlaybackSnapshot();
    } catch (err) {
      viewModeWarn("capture snapshot failed", err);
    }

    // 3. Persist to localStorage.
    try {
      persistPlaybackSession("view-pin", { force: true });
    } catch (err) {
      viewModeWarn("persist on pin failed", err);
    }

    // 4. Create structured transfer metadata.
    const transferId = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Math.random()) + "-" + String(Date.now());
    const transfer = createViewTransfer({
      transferId,
      sourceMode: surfaceMode,
      targetMode: "sidepanel",
      sourceInstanceId: instanceIdRef.current,
      standaloneWindowId: popupWindowId,
    });
    await writeActiveViewTransfer(transfer);

    // 5. Resolve target windowId from session.
    let targetWindowId = null;
    try {
      const session = await chrome.storage?.session?.get?.([
        ORIGIN_WINDOW_ID_KEY,
      ]);
      if (session?.[ORIGIN_WINDOW_ID_KEY] != null) {
        targetWindowId = session[ORIGIN_WINDOW_ID_KEY];
      }
    } catch (_) { /* noop */ }
    if (targetWindowId == null && event?.view?.windowId != null) {
      targetWindowId = event.view.windowId;
    }

    // 6. Update transfer to waiting-target BEFORE releasing ownership or
    // opening the sidepanel so the target can read it immediately on mount.
    await updateActiveViewTransfer(transferId, {
      status: "waiting-target",
      standaloneWindowId: popupWindowId,
    });

    if (targetWindowId == null) {
      try {
        console.warn("[PIN_BACK] EARLY_RETURN", {
          reason: "no_target_window",
          transferId,
          popupWindowId,
          originWindowId: null,
          originWindowIdFromSession: session?.[ORIGIN_WINDOW_ID_KEY],
          eventViewWindowId: event?.view?.windowId,
        });
      } catch (_) { /* noop */ }
      setViewModeToast("Không thể ghim lại Side Panel. Tab hiện tại vẫn được giữ.");
      setIsViewTransitioning(false);
      isTransferringRef.current = false;
      await clearActiveViewTransfer(transferId);
      await acquireAudioOwnership();
      if (snap?.isPlaying) {
        try {
          audioRef.current?.play()?.then(() => setIsPlaying(true)).catch(() => {});
        } catch (_) { /* noop */ }
      }
      return;
    }

    viewModeLog?.("[PIN_BACK] START", {
      transferId,
      popupWindowId,
      originWindowId: targetWindowId,
    });
    // Always-visible console log so manual debugging in DevTools confirms
    // capture without depending on the [SVDMusic][ViewMode] gate.
    try {
      console.log("[PIN_BACK] START", {
        transferId,
        popupWindowId,
        originWindowId: targetWindowId,
      });
    } catch (_) { /* noop */ }

    // 7. Pause and release ownership AFTER writing the snapshot. The snapshot
    // and the pendingViewSnapshot session entry must be in place before we
    // stop owning the audio so the sidepanel target can read them safely.
    releaseAudioOwnershipLocal();
    await releaseAudioOwnership();

    if (snap) {
      await writeSessionValue("svdmusic.pendingViewSnapshot", {
        ...snap,
        targetMode: "sidepanel",
        transferId,
      }).catch(() => {});
      postViewMessage("pending-snapshot", {
        transferId,
        snapshot: snap,
        targetMode: "sidepanel",
      });
    }
    await updateActiveViewTransfer(transferId, {
      status: "waiting-target",
      standaloneWindowId: popupWindowId,
    });

    // 8. Set up readyPromise BEFORE we open the sidepanel.
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    const timerId = setTimeout(async () => {
      viewModeWarn("pin timeout: no SIDEPANEL_READY");
      viewTransferCleanupRef.current = null;
      isTransferringRef.current = false;
      await clearActiveViewTransfer(transferId);
      await acquireAudioOwnership();
      setIsViewTransitioning(false);
      if (snap?.isPlaying) {
        try {
          audioRef.current?.play()?.then(() => setIsPlaying(true)).catch(() => {});
        } catch (_) { /* noop */ }
      }
      try {
        console.log("[PIN_BACK] TIMEOUT", { transferId, popupWindowId });
      } catch (_) { /* noop */ }
      resolveReady({ timedOut: true });
    }, VIEW_TRANSFER_TIMEOUT_MS);
    viewTransferCleanupRef.current = timerId;

    const clearReadyListeners = () => {
      clearTimeout(timerId);
      viewTransferCleanupRef.current = null;
      if (unsubBc) { unsubBc(); unsubBc = null; }
      if (removeListener) { removeListener(); removeListener = null; }
    };

    let unsubBc = null;
    unsubBc = subscribeViewMessages((msg) => {
      if (msg.type === "transfer-ready" && msg.payload?.transferId === transferId) {
        clearReadyListeners();
        resolveReady({ timedOut: false });
      }
    });

    let removeListener = null;
    removeListener = (message) => {
      try {
        console.log("[PIN_BACK] READY_MESSAGE_RECEIVED", {
          type: message?.type,
          messageTransferId: message?.transferId,
          expectedTransferId: transferId,
          match: message?.transferId === transferId,
          originWindowId: message?.originWindowId,
          instanceId: message?.instanceId,
        });
      } catch (_) { /* noop */ }
      // Only SIDEPANEL_READY counts here. Standalone uses its own READY name.
      if (message?.type !== "player/sidepanel-ready") return;
      if (message?.transferId !== transferId) return;
      clearReadyListeners();
      resolveReady({ timedOut: false });
    };
    chrome.runtime.onMessage.addListener(removeListener);

    // 9. Open sidepanel synchronously within the user gesture.
    let opened = false;
    try {
      if (chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: targetWindowId });
        opened = true;
      }
    } catch (err) {
      viewModeWarn("direct sidePanel.open failed", err);
    }
    if (opened) {
      try {
        console.log("[PIN_BACK] SIDEPANEL_OPENED", {
          transferId,
          popupWindowId,
          originWindowId: targetWindowId,
        });
      } catch (_) { /* noop */ }
    }
    if (!opened) {
      try {
        console.log("[PIN_BACK] SIDEPANEL_OPEN_FALLBACK", {
          transferId,
          popupWindowId,
          originWindowId: targetWindowId,
        });
      } catch (_) { /* noop */ }
      try {
        const response = await chrome.runtime.sendMessage({
          type: "player/sidepanel-open",
          windowId: targetWindowId,
        });
        try {
          console.log("[PIN_BACK] SIDEPANEL_OPEN_RESPONSE", {
            transferId,
            ok: response?.ok === true,
            response,
          });
        } catch (_) { /* noop */ }
        if (!response || response.ok !== true) {
          throw new Error(response?.error || "sidePanel.open thất bại.");
        }
        opened = true;
      } catch (err) {
        try {
          console.warn("[PIN_BACK] EARLY_RETURN", {
            reason: "sidepanel_open_failed",
            transferId,
            popupWindowId,
            originWindowId: targetWindowId,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch (_) { /* noop */ }
        viewModeWarn("pin: SW sidePanel.open failed", err);
        setViewModeToast("Không thể ghim lại Side Panel. Tab hiện tại vẫn được giữ.");
        clearReadyListeners();
        isTransferringRef.current = false;
        await clearActiveViewTransfer(transferId);
        await acquireAudioOwnership();
        setIsViewTransitioning(false);
        if (snap?.isPlaying) {
          try {
            audioRef.current?.play()?.then(() => setIsPlaying(true)).catch(() => {});
          } catch (_) { /* noop */ }
        }
        return;
      }
    }

    // 10. Await SIDEPANEL_READY (or timeout).
    try {
      console.log("[PIN_BACK] WAITING_READY", { transferId, popupWindowId });
    } catch (_) { /* noop */ }
    const result = await readyPromise;
    try {
      console.log("[PIN_BACK] SIDEPANEL_READY", {
        transferId,
        popupWindowId,
        timedOut: !!result.timedOut,
      });
    } catch (_) { /* noop */ }
    if (result.timedOut) {
      try {
        console.warn("[PIN_BACK] TIMEOUT", {
          transferId,
          popupWindowId,
          originWindowId: targetWindowId,
        });
      } catch (_) { /* noop */ }
      return;
    }

    // 11. Close the popup that is currently hosting this React tree. We use
    // popupWindowId captured at step 1 so we never depend on session state
    // (which may have been cleared if a previous removal fired). The SW
    // handler validates independently before calling chrome.windows.remove.
    if (popupWindowId == null) {
      try {
        console.warn("[PIN_BACK] EARLY_RETURN", {
          reason: "no_popup_window_id_after_ready",
          transferId,
          popupWindowId,
          originWindowId: targetWindowId,
        });
      } catch (_) { /* noop */ }
      viewModeWarn("pin: no popupWindowId captured, cannot close popup");
      return;
    }
    if (popupWindowId === targetWindowId) {
      try {
        console.warn("[PIN_BACK] EARLY_RETURN", {
          reason: "popup_equals_origin",
          transferId,
          popupWindowId,
          originWindowId: targetWindowId,
        });
      } catch (_) { /* noop */ }
      viewModeWarn("pin: popupWindowId equals originWindowId, refusing to close");
      return;
    }

    let closeResult;
    try {
      console.log("[PIN_BACK] BEFORE_CLOSE_MESSAGE", {
        transferId,
        popupWindowId,
        originWindowId: targetWindowId,
      });
    } catch (_) { /* noop */ }
    try {
      closeResult = await chrome.runtime.sendMessage({
        type: "player/close-standalone-popup",
        standaloneWindowId: popupWindowId,
        transferId,
      });
    } catch (err) {
      try {
        console.error("[PIN_BACK] CLOSE_MESSAGE_ERROR", {
          step: "sendMessage_close_standalone_popup",
          transferId,
          popupWindowId,
          originWindowId: targetWindowId,
          errorName: err?.name ?? null,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : null,
        });
      } catch (_) { /* noop */ }
      viewModeWarn("pin: sendMessage to close popup failed", err);
      closeResult = null;
    }
    if (closeResult == null || typeof closeResult !== "object") {
      try {
        console.warn("[PIN_BACK] CLOSE_NO_RESULT", {
          transferId,
          popupWindowId,
          closeResult,
        });
      } catch (_) { /* noop */ }
    }
    try {
      console.log("[PIN_BACK] CLOSE_RESULT", {
        transferId,
        popupWindowId,
        removedWindowId: closeResult?.removedWindowId ?? null,
        ok: closeResult?.ok === true,
        error: closeResult?.error ?? null,
      });
    } catch (_) { /* noop */ }

    // Popup close is best-effort after READY. If it failed we leave it open
    // — the user can close it manually. We do NOT undo the sidepanel restore
    // because that would re-introduce double-play risk.
    // Standalone will unmount shortly either way; don't reset isViewTransitioning
    // since this view is about to close.
  }

  function handleViewModeClick(event) {
    try {
      console.log("[PIN_BACK_BUTTON] CLICK", {
        isStandalone,
        surfaceMode,
        disabled: isViewTransitioning,
        type: event?.type,
      });
    } catch (_) { /* noop */ }
    if (isViewTransitioning) return;
    if (isStandalone) {
      handlePinBackToSidePanel(event);
    } else {
      handleDetachToStandalone();
    }
  }

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
          <ViewModeButton
            mode={surfaceMode}
            onClick={handleViewModeClick}
            disabled={isViewTransitioning}
          />
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
                      src={resolvedCoverUrl || currentSong?.cover}
                      alt={currentSong?.title}
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
                  src={resolvedCoverUrl || currentSong?.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <img
                  className="coverBase"
                  src={resolvedCoverUrl || currentSong?.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <img
                  className="coverRed"
                  src={resolvedCoverUrl || currentSong?.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <img
                  className="coverCyan"
                  src={resolvedCoverUrl || currentSong?.cover}
                  alt=""
                  onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)}
                />
                <div className="coverBands">
                  <div className="coverBand b1"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b2"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b3"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b4"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b5"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b6"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b7"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
                  <div className="coverBand b8"><img src={resolvedCoverUrl || currentSong?.cover} alt="" onError={(e) => setImageFallback(e.currentTarget, COVER_FALLBACK)} /></div>
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
<h3>{currentSong?.title}</h3>
                <p className="artistName">{currentSong?.artist}</p>

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
              <strong>{currentSong?.title}</strong>
              <span>{currentSong?.artist}</span>
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
            className={`shuffleButton ${isShuffle ? "isToggled" : ""}`}
            onClick={() => setIsShuffle((v) => !v)}
            aria-label="Shuffle"
            aria-pressed={isShuffle}
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

      <ViewModeToast message={viewModeToast} />
    </div>
  );
}

export default App;
