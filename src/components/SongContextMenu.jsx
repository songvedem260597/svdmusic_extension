import { useEffect, useRef, useState } from "react";
import { Heart, Trash2, Info } from "lucide-react";
import {
  loadFavorites,
  removeUserSong,
  subscribeFavorites,
  toggleFavorite,
  updateUserSong,
} from "../services/songStorage.js";
import {
  deleteAllAssetsForVideo,
  deleteAssetByKey,
} from "../services/assetStorage.ts";
import { deleteLrcText } from "../services/lrcStorage.ts";

const MENU_WIDTH_ESTIMATE = 240;
const MENU_HEIGHT_ESTIMATE = 180;

function isUserSong(song) {
  if (!song) return false;
  return !!(
    song.audioKey ||
    song.coverKey ||
    song.lyricsKey ||
    song.lyricsTextKey ||
    song.audioMissing
  );
}

function clampPosition(x, y) {
  if (typeof window === "undefined") return { x, y };
  const padding = 8;
  const maxX = Math.max(padding, window.innerWidth - MENU_WIDTH_ESTIMATE - padding);
  const maxY = Math.max(padding, window.innerHeight - MENU_HEIGHT_ESTIMATE - padding);
  return {
    x: Math.min(Math.max(x, padding), maxX),
    y: Math.min(Math.max(y, padding), maxY),
  };
}

function extractVideoId(song) {
  if (!song) return null;
  // The runtime ID for a user-added song is `user-<videoId>` (see AddSongModal).
  // Pull the suffix out so we can derive canonical IndexedDB keys.
  if (typeof song.id === "string" && song.id.startsWith("user-")) {
    return song.id.slice("user-".length);
  }
  if (typeof song.videoId === "string") return song.videoId;
  return null;
}

export default function SongContextMenu({
  open,
  song,
  x,
  y,
  onClose,
  onDeleted,
}) {
  const menuRef = useRef(null);
  const [favoriteMap, setFavoriteMap] = useState(() => loadFavorites());

  useEffect(() => {
    if (!open) return undefined;
    const unsubscribe = subscribeFavorites((next) => setFavoriteMap(next || {}));
    return unsubscribe;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      const root = menuRef.current;
      if (!root) return;
      if (root.contains(event.target)) return;
      onClose?.();
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
      }
    }
    function handleScroll() {
      // Closing on scroll avoids the menu detaching from its anchor visually.
      onClose?.();
    }

    // Defer the click-outside binding by one tick so the same right-click
    // that opened us doesn't immediately close us again.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDown);
      document.addEventListener("touchstart", handlePointerDown, { passive: true });
    }, 0);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open, onClose]);

  if (!open || !song) return null;

  const userSong = isUserSong(song);
  const videoId = extractVideoId(song);

  const isFav = favoriteMap[song.id] === true;

  const pos = clampPosition(x, y);

  function handleToggleFavorite() {
    if (!song) return;
    const next = toggleFavorite(song.id);
    console.log("[SongContextMenu] toggle favorite", song.id, "->", next);
    // For user songs we also mirror the state onto the metadata so the
    // playlist badge stays consistent without an extra read.
    if (userSong) {
      updateUserSong(song.id, { favorite: next }).catch((err) => {
        console.warn("[SongContextMenu] mirror favorite onto user song failed", err);
      });
    }
  }

  async function handleDelete() {
    if (!song) return;
    if (!userSong) return;
    const ok = window.confirm(
      "Xoá bài hát này khỏi SVDMusic? Hành động này sẽ xoá cả MP3/LRC/cover đã lưu."
    );
    if (!ok) return;

    console.log("[SongContextMenu] delete song", song.id, "videoId=", videoId);

    const keysToRemove = [];
    if (song.coverKey) keysToRemove.push(song.coverKey);
    if (song.audioKey) keysToRemove.push(song.audioKey);
    if (song.lyricsKey) keysToRemove.push(song.lyricsKey);
    if (song.lyricsTextKey) keysToRemove.push(song.lyricsTextKey);

    // Fallback: explicit deletion of the canonical per-videoId keys.
    if (videoId) {
      keysToRemove.push(`cover:${videoId}`);
      keysToRemove.push(`audio:${videoId}`);
      keysToRemove.push(`lrc:${videoId}`);
    }

    // De-dupe so we don't ask IndexedDB the same key twice.
    const uniqueKeys = Array.from(new Set(keysToRemove.filter(Boolean)));

    for (const key of uniqueKeys) {
      try {
        const ok = await deleteAssetByKey(key);
        console.log("[SongContextMenu] deleted asset key=", key, "ok=", ok);
      } catch (err) {
        console.warn("[SongContextMenu] delete asset failed key=", key, err);
      }
    }

    if (videoId) {
      try {
        await deleteLrcText(videoId);
      } catch (err) {
        console.warn("[SongContextMenu] deleteLrcText failed", err);
      }
      // Best-effort: catches any stragglers in the assets store for this video.
      try {
        await deleteAllAssetsForVideo(videoId);
      } catch (err) {
        console.warn("[SongContextMenu] deleteAllAssetsForVideo failed", err);
      }
    }

    try {
      await removeUserSong(song.id);
    } catch (err) {
      console.warn("[SongContextMenu] removeUserSong failed", err);
    }

    console.log("[SongContextMenu] delete done");
    onClose?.();
    onDeleted?.({ songId: song.id, videoId });
  }

  return (
    <div
      ref={menuRef}
      className="songContextMenu"
      role="menu"
      aria-label="Tuỳ chọn bài hát"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className="songContextMenuItem"
        onClick={handleToggleFavorite}
      >
        <Heart size={14} className={isFav ? "isFav" : ""} />
        <span>{isFav ? "Bỏ yêu thích" : "Thêm vào yêu thích"}</span>
      </button>

      {userSong ? (
        <button
          type="button"
          role="menuitem"
          className="songContextMenuItem isDanger"
          onClick={handleDelete}
        >
          <Trash2 size={14} />
          <span>Xoá bài hát</span>
        </button>
      ) : (
        <div className="songContextMenuNote" role="note">
          <Info size={14} />
          <span>Không thể xoá bài mặc định</span>
        </div>
      )}
    </div>
  );
}