// SongLibraryPopover
//
// Popover anchored below the `.topBadge` in the top bar. Lets the user browse
// the full library grouped by genre (taken from each song's `tags[0]`) plus a
// pinned "Yêu thích" section at the top. A free-text search box filters both
// the favorites and the per-genre groups by title / artist / tags (using the
// shared `matchSongQuery` matcher from utils/textSearch.js). Clicking a row
// plays the song in the main player (via the `onPlaySong(song)` prop) and
// closes the popover.
//
// Favorites source:
//   - user-added songs: read directly from `song.favorite`.
//   - built-in songs: lookup via `isFavorite(songId)` from songStorage.
//
// This component is presentation + light data shaping only. The actual play
// intent (selectSong index resolution, lyric sync reset, pendingPlayRef, etc.)
// stays in App.jsx — we just hand back the song object.

import { useEffect, useMemo, useRef, useState } from "react";
import { Heart, Music2, Search, X } from "lucide-react";
import { isFavorite, subscribeFavorites } from "../services/songStorage.js";
import { matchSongQuery } from "../utils/textSearch.js";

const FALLBACK_TAG = "Khác";

function normalizeTag(tag) {
  if (!tag || typeof tag !== "string") return FALLBACK_TAG;
  const trimmed = tag.trim();
  return trimmed.length ? trimmed : FALLBACK_TAG;
}

function pickPrimaryTag(song) {
  if (!song || !Array.isArray(song.tags) || song.tags.length === 0) {
    return FALLBACK_TAG;
  }
  return normalizeTag(song.tags[0]);
}

function isSongFavorite(song, favoritesMap) {
  if (!song) return false;
  // User-added songs carry their own `favorite` boolean.
  if (song.favorite === true) return true;
  // Built-in / fallback path: consult the favorites map.
  return !!(favoritesMap && song.id && favoritesMap[song.id]);
}

function groupByTag(songs) {
  const groups = new Map();
  for (const song of songs) {
    const tag = pickPrimaryTag(song);
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(song);
  }
  // Sort songs inside each group by title for stable output.
  for (const [, list] of groups) {
    list.sort((a, b) =>
      String(a?.title || "").localeCompare(String(b?.title || ""), "vi")
    );
  }
  // Sort group keys alphabetically (Vietnamese-aware).
  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "vi"))
    .map(([tag, list]) => ({ tag, list }));
}

export default function SongLibraryPopover({
  open,
  onClose,
  songs,
  favoritesMap,
  onPlaySong,
  currentSongId,
}) {
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const [query, setQuery] = useState("");

  // Reset the local query whenever the popover re-opens so a stale keyword
  // from a previous session doesn't shadow the full library list.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Auto-focus the search field when the popover opens so users can type
  // immediately after clicking `.topBadge`.
  useEffect(() => {
    if (!open) return undefined;
    const node = searchInputRef.current;
    if (!node) return undefined;
    const id = window.setTimeout(() => {
      try {
        node.focus({ preventScroll: true });
      } catch (_) {
        node.focus();
      }
    }, 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event) {
      const node = containerRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      onClose?.();
    }
    function handleKey(event) {
      if (event.key === "Escape") onClose?.();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  const { favorites, groups, totals, hasQuery, filteredOut } = useMemo(() => {
    const favList = [];
    const rest = [];
    let total = 0;
    let matched = 0;
    for (const song of songs || []) {
      if (!song) continue;
      total += 1;
      if (!matchSongQuery(query, song)) continue;
      matched += 1;
      if (isSongFavorite(song, favoritesMap)) favList.push(song);
      else rest.push(song);
    }
    favList.sort((a, b) =>
      String(a?.title || "").localeCompare(String(b?.title || ""), "vi")
    );
    return {
      favorites: favList,
      groups: groupByTag(rest),
      totals: { total, favorites: favList.length },
      hasQuery: query.trim().length > 0,
      filteredOut: total - matched,
    };
  }, [songs, favoritesMap, query]);

  if (!open) return null;

  const noResults = favorites.length === 0 && groups.length === 0;

  return (
    <div
      ref={containerRef}
      className="songLibraryPopover"
      role="dialog"
      aria-label="Thư viện bài hát"
    >
      <header className="songLibraryHeader">
        <div className="songLibraryTitle">
          <Music2 size={16} />
          <span>Thư viện</span>
          <span className="songLibraryCount">
            {hasQuery
              ? `${favorites.length + groups.reduce(
                  (n, g) => n + g.list.length,
                  0
                )}/${totals.total} khớp`
              : `${totals.favorites}/${totals.total} yêu thích`}
          </span>
        </div>
        <button
          type="button"
          className="songLibraryClose"
          onClick={onClose}
          aria-label="Đóng"
        >
          <X size={16} />
        </button>
      </header>

      <div className="songLibrarySearch">
        <Search size={14} className="songLibrarySearchIcon" />
        <input
          ref={searchInputRef}
          type="search"
          className="songLibrarySearchInput"
          placeholder="Tìm bài hát, ca sĩ hoặc thể loại…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Tìm trong thư viện"
          spellCheck={false}
          autoComplete="off"
        />
        {query ? (
          <button
            type="button"
            className="songLibrarySearchClear"
            onClick={() => setQuery("")}
            aria-label="Xóa từ khóa"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="songLibraryScroll">
        {hasQuery && noResults ? (
          <p className="songLibraryEmpty">
            Không có bài hát nào khớp với "{query.trim()}".
          </p>
        ) : !hasQuery && totals.total === 0 ? (
          <p className="songLibraryEmpty">Chưa có bài hát nào.</p>
        ) : (
          <>
            {favorites.length > 0 ? (
              <section className="songLibraryGroup songLibraryGroupFavorites">
                <header className="songLibraryGroupHeader">
                  <Heart size={13} />
                  <span>Yêu thích</span>
                  <span className="songLibraryGroupCount">
                    {favorites.length}
                  </span>
                </header>
                <ul className="songLibraryList">
                  {favorites.map((song) => (
                    <SongRow
                      key={`fav-${song.id}`}
                      song={song}
                      active={song.id === currentSongId}
                      onClick={() => onPlaySong?.(song)}
                      query={query}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            {groups.length > 0
              ? groups.map(({ tag, list }) => (
                  <section
                    key={tag}
                    className="songLibraryGroup"
                    data-tag={tag}
                  >
                    <header className="songLibraryGroupHeader">
                      <span className="songLibraryTag">{tag}</span>
                      <span className="songLibraryGroupCount">
                        {list.length}
                      </span>
                    </header>
                    <ul className="songLibraryList">
                      {list.map((song) => (
                        <SongRow
                          key={song.id}
                          song={song}
                          active={song.id === currentSongId}
                          onClick={() => onPlaySong?.(song)}
                          query={query}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              : null}

            {hasQuery && filteredOut > 0 ? (
              <p className="songLibraryHint">
                Ẩn {filteredOut} bài không khớp từ khóa.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SongRow({ song, active, onClick, query }) {
  return (
    <li>
      <button
        type="button"
        className={`songLibraryRow${active ? " isActive" : ""}`}
        onClick={onClick}
      >
        <span className="songLibraryRowMain">
          <strong>
            <HighlightedText text={song?.title || "Không rõ tiêu đề"} query={query} />
          </strong>
          <small>
            <HighlightedText text={song?.artist || "—"} query={query} />
          </small>
        </span>
        <span className="songLibraryRowTag">
          <HighlightedText text={pickPrimaryTag(song)} query={query} />
        </span>
      </button>
    </li>
  );
}

// Lightweight inline highlighter: wraps every case-insensitive diacritic-
// insensitive occurrence of `query` in a <mark> span. Falls back to plain
// text when the query is empty.
function HighlightedText({ text, query }) {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  const trimmed = (query || "").trim();
  if (!trimmed) return safeText;

  // Mirror the matcher: lowercase + strip combining marks + đ → d so the
  // visible offsets line up with what matchSongQuery used to filter the row.
  const stripped = safeText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
  const needle = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");

  if (!needle) return safeText;

  // Safety: when NFD + diacritic stripping changes the code-unit length of
  // the needle (e.g. "ế" → "e\u0302" → "e" stays 1 char, but "đ" → "d"
  // changes for some inputs), a slice calibrated against the stripped form
  // may over-run on the original text. In that case we drop highlighting to
  // guarantee no garbled characters leak into the DOM.
  const originalNeedle = trimmed;
  const strippedNeedle = needle;
  if (originalNeedle.length !== strippedNeedle.length) return safeText;

  const parts = [];
  let cursor = 0;
  while (cursor < safeText.length) {
    const idx = stripped.indexOf(needle, cursor);
    if (idx === -1) {
      parts.push(safeText.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(safeText.slice(cursor, idx));
    parts.push(
      <mark key={`m-${cursor}`} className="songLibraryRowMark">
        {safeText.slice(idx, idx + needle.length)}
      </mark>
    );
    cursor = idx + needle.length;
  }

  return parts;
}

// Re-export the favorite helper for App.jsx tests / debugging if needed.
export { isFavorite, subscribeFavorites };