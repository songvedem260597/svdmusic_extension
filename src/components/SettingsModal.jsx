import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  X,
  Image as ImageIcon,
} from "lucide-react";
import {
  saveBackground,
  loadBackground,
  deleteBackground,
  fileToBlob,
} from "../services/backgroundStorage.js";

const THEME_STORAGE_KEY = "svdmusic:theme";
const BACKGROUND_STORAGE_KEY = "svdmusic:backgroundImage"; // legacy, migrated on first load
const BACKGROUND_GALLERY_STORAGE_KEY = "svdmusic:backgroundGallery";
const ACTIVE_BACKGROUND_ID_STORAGE_KEY = "svdmusic:activeBackgroundId";
const BACKGROUND_OPACITY_STORAGE_KEY = "svdmusic:backgroundOpacity";
const AUTO_ROTATE_STORAGE_KEY = "svdmusic:autoRotateBackground";
const BG_ROTATE_INTERVAL_MS = 120000;
const VALID_THEMES = new Set(["dark", "light"]);
const MIN_OPACITY = 10;
const MAX_OPACITY = 100;
const DEFAULT_OPACITY = 60;
const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;

function readStoredTheme() {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return VALID_THEMES.has(raw) ? raw : "dark";
  } catch (_) {
    return "dark";
  }
}

function readStoredBackgroundOpacity() {
  try {
    const raw = Number(window.localStorage.getItem(BACKGROUND_OPACITY_STORAGE_KEY));
    if (!Number.isFinite(raw)) return DEFAULT_OPACITY;
    return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(raw)));
  } catch (_) {
    return DEFAULT_OPACITY;
  }
}

function readStoredBackgroundGallery() {
  try {
    const raw = window.localStorage.getItem(BACKGROUND_GALLERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function readStoredActiveBackgroundId() {
  try {
    return window.localStorage.getItem(ACTIVE_BACKGROUND_ID_STORAGE_KEY) || "";
  } catch (_) {
    return "";
  }
}

function readStoredAutoRotate() {
  try {
    const raw = window.localStorage.getItem(AUTO_ROTATE_STORAGE_KEY);
    return raw === "true";
  } catch (_) {
    return false;
  }
}

function readLegacyBackgroundImage() {
  try {
    return window.localStorage.getItem(BACKGROUND_STORAGE_KEY) || "";
  } catch (_) {
    return "";
  }
}

function makeBackgroundId() {
  return `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    const bytes = atob(match[2]);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      buffer[i] = bytes.charCodeAt(i);
    }
    return new Blob([buffer], { type: match[1] });
  } catch (_) {
    return null;
  }
}

function persistGallery(gallery) {
  try {
    window.localStorage.setItem(
      BACKGROUND_GALLERY_STORAGE_KEY,
      JSON.stringify(gallery)
    );
  } catch (_) {
    /* noop */
  }
}

function persistActiveBackgroundId(id) {
  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_BACKGROUND_ID_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_BACKGROUND_ID_STORAGE_KEY);
    }
  } catch (_) {
    /* noop */
  }
}

function persistAutoRotate(value) {
  try {
    window.localStorage.setItem(AUTO_ROTATE_STORAGE_KEY, value ? "true" : "false");
  } catch (_) {
    /* noop */
  }
}

function revokeUrl(url) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch (_) {
    /* noop */
  }
}

export function useAppSettings({ isLyricsView = false } = {}) {
  const [theme, setTheme] = useState(() => readStoredTheme());
  const [backgroundGallery, setBackgroundGallery] = useState(() =>
    readStoredBackgroundGallery()
  );
  const [activeBackgroundId, setActiveBackgroundIdState] = useState(() =>
    readStoredActiveBackgroundId()
  );
  const [activeBackgroundImage, setActiveBackgroundImage] = useState("");
  const [backgroundOpacity, setBackgroundOpacity] = useState(() =>
    readStoredBackgroundOpacity()
  );
  const [autoRotateBackground, setAutoRotateBackground] = useState(
    () => readStoredAutoRotate()
  );
  const galleryIdsRef = useRef([]);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_) {
      /* noop */
    }
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    persistGallery(backgroundGallery);
  }, [backgroundGallery]);

  useEffect(() => {
    persistActiveBackgroundId(activeBackgroundId);
  }, [activeBackgroundId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(BACKGROUND_OPACITY_STORAGE_KEY, String(backgroundOpacity));
    } catch (_) {
      /* noop */
    }
  }, [backgroundOpacity]);

  useEffect(() => {
    persistAutoRotate(autoRotateBackground);
  }, [autoRotateBackground]);

  // Keep a stable ref of gallery ids so the interval callback always sees the
  // latest array without depending on `backgroundGallery` (which would restart
  // the interval on every gallery mutation).
  useEffect(() => {
    galleryIdsRef.current = backgroundGallery.map((item) => item.id);
  }, [backgroundGallery]);

  // Auto-rotate: advance to the next background every 2 minutes when the
  // toggle is on, the gallery has >= 2 images, and the user is in home view.
  // Pauses automatically while in lyrics view.
  useEffect(() => {
    if (!autoRotateBackground) return;
    if (galleryIdsRef.current.length < 2) return;
    if (!activeBackgroundId) return;
    if (isLyricsView) return;

    const timer = setInterval(() => {
      setActiveBackgroundIdState((currentId) => {
        const ids = galleryIdsRef.current;
        if (ids.length < 2) return currentId;
        const currentIndex = ids.indexOf(currentId);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = (safeIndex + 1) % ids.length;
        return ids[nextIndex] || currentId;
      });
    }, BG_ROTATE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [autoRotateBackground, activeBackgroundId, isLyricsView]);

  // Apply persisted theme on first mount so the very first paint is correct.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time migration from the legacy single-image storage into the new
  // gallery + IndexedDB layout. Runs once per app lifetime.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const legacy = readLegacyBackgroundImage();
      if (!legacy) return;
      const existingGallery = readStoredBackgroundGallery();
      const existingActive = readStoredActiveBackgroundId();
      if (existingGallery.length > 0 || existingActive) {
        try {
          window.localStorage.removeItem(BACKGROUND_STORAGE_KEY);
        } catch (_) {
          /* noop */
        }
        return;
      }
      const blob = await dataUrlToBlob(legacy);
      if (!blob || cancelled) return;
      const id = `bg-migrated-${Date.now().toString(36)}`;
      try {
        await saveBackground(id, blob);
      } catch (error) {
        console.warn("[useAppSettings] migration saveBackground failed", error);
        return;
      }
      if (cancelled) return;
      const item = {
        id,
        key: `background:${id}`,
        name: "Ảnh nền cũ",
        type: blob.type || "image/png",
        size: blob.size,
        createdAt: Date.now(),
      };
      persistGallery([item]);
      persistActiveBackgroundId(id);
      try {
        window.localStorage.removeItem(BACKGROUND_STORAGE_KEY);
      } catch (_) {
        /* noop */
      }
      setBackgroundGallery([item]);
      setActiveBackgroundIdState(id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the active background id into a runtime blob URL whenever the
  // id or the gallery changes. Revokes the previous URL to free memory.
  useEffect(() => {
    let cancelled = false;
    const id = activeBackgroundId;
    if (!id) {
      setActiveBackgroundImage((prev) => {
        revokeUrl(prev);
        return "";
      });
      return undefined;
    }
    (async () => {
      try {
        const blob = await loadBackground(id);
        if (cancelled) return;
        if (!blob) {
          setActiveBackgroundIdState((current) => (current === id ? "" : current));
          setActiveBackgroundImage((prev) => {
            revokeUrl(prev);
            return "";
          });
          return;
        }
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          revokeUrl(url);
          return;
        }
        setActiveBackgroundImage((prev) => {
          revokeUrl(prev);
          return url;
        });
      } catch (error) {
        console.warn("[useAppSettings] loadBackground failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBackgroundId, backgroundGallery]);

  // Revoke the active URL on unmount so we don't leak blob memory.
  useEffect(() => {
    return () => {
      setActiveBackgroundImage((prev) => {
        revokeUrl(prev);
        return "";
      });
    };
  }, []);

  const setActiveBackgroundId = useCallback((id) => {
    setActiveBackgroundIdState(id || "");
  }, []);

  const handleAddBackgroundImages = useCallback(async (files) => {
    const list = Array.from(files || []).filter(
      (file) => file && file.type && file.type.startsWith("image/")
    );
    if (list.length === 0) {
      window.alert("Vui lòng chọn file ảnh.");
      return;
    }
    const added = [];
    let firstNewId = null;
    for (const file of list) {
      if (typeof file.size === "number" && file.size > MAX_BACKGROUND_BYTES) {
        window.alert(
          `Ảnh "${file.name}" quá lớn (tối đa 8MB). Vui lòng chọn ảnh nhỏ hơn.`
        );
        continue;
      }
      const id = makeBackgroundId();
      try {
        await saveBackground(id, fileToBlob(file));
      } catch (error) {
        console.warn("[useAppSettings] saveBackground failed", error);
        window.alert(`Không thể lưu ảnh "${file.name}". Vui lòng thử lại.`);
        continue;
      }
      const item = {
        id,
        key: `background:${id}`,
        name: file.name || "background",
        type: file.type,
        size: file.size,
        createdAt: Date.now(),
      };
      added.push(item);
      if (!firstNewId) firstNewId = id;
    }
    if (added.length === 0) return;
    setBackgroundGallery((prev) => [...prev, ...added]);
    setActiveBackgroundIdState((prev) => (prev ? prev : firstNewId));
  }, []);

  const handleSelectBackgroundImage = useCallback((id) => {
    setActiveBackgroundIdState(id || "");
  }, []);

  const handleDeleteBackgroundImage = useCallback(async (id) => {
    if (!id) return;
    try {
      await deleteBackground(id);
    } catch (error) {
      console.warn("[useAppSettings] deleteBackground failed", error);
    }
    setBackgroundGallery((prev) => {
      const next = prev.filter((item) => item.id !== id);
      setActiveBackgroundIdState((current) => {
        if (current !== id) return current;
        return next[0]?.id || "";
      });
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      theme,
      setTheme,
      backgroundGallery,
      activeBackgroundId,
      setActiveBackgroundId,
      activeBackgroundImage,
      backgroundOpacity,
      setBackgroundOpacity,
      handleAddBackgroundImages,
      handleSelectBackgroundImage,
      handleDeleteBackgroundImage,
      autoRotateBackground,
      setAutoRotateBackground,
    }),
    [
      theme,
      backgroundGallery,
      activeBackgroundId,
      setActiveBackgroundId,
      activeBackgroundImage,
      backgroundOpacity,
      handleAddBackgroundImages,
      handleSelectBackgroundImage,
      handleDeleteBackgroundImage,
      autoRotateBackground,
    ]
  );
}

export function SettingsButton({ onClick }) {
  return (
    <button
      type="button"
      className="topBadgeButton settingsButton"
      onClick={onClick}
      aria-label="Mở cài đặt"
      title="Cài đặt"
    >
      <SettingsIcon size={15} />
      <span>Cài đặt</span>
    </button>
  );
}

// Renders one gallery thumbnail. Lazily loads its blob on first mount and
// exposes the resulting object URL through the `onLoaded(url, revoke)`
// callback so the parent can free the URL when the item unmounts. Click
// picks the item; the delete button is isolated from the click handler so
// it doesn't also trigger the select.
function BackgroundGalleryItem({ item, isActive, onSelect, onDelete }) {
  const urlRef = useRef(null);
  const revokeRef = useRef(() => {});
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const blob = await loadBackground(item.id);
        if (cancelled || !blob) return;
        const next = URL.createObjectURL(blob);
        if (cancelled) {
          revokeUrl(next);
          return;
        }
        urlRef.current = next;
        revokeRef.current = () => {
          URL.revokeObjectURL(next);
        };
        setUrl(next);
      } catch (error) {
        console.warn("[BackgroundGalleryItem] load failed", error);
      }
    })();
    return () => {
      cancelled = true;
      if (revokeRef.current) revokeRef.current();
      urlRef.current = null;
    };
  }, [item.id]);

  function handleDelete(event) {
    event.stopPropagation();
    event.preventDefault();
    onDelete(item.id);
  }

  return (
    <button
      type="button"
      className={`settingsBackgroundItem ${isActive ? "active" : ""}`}
      onClick={() => onSelect(item.id)}
      title={item.name}
      aria-label={`Chọn ảnh nền ${item.name}`}
      aria-pressed={isActive}
    >
      {url ? <img src={url} alt={item.name} /> : <span className="settingsBackgroundItemPlaceholder" />}
      <button
        type="button"
        className="settingsBackgroundDelete"
        onClick={handleDelete}
        aria-label={`Xóa ảnh ${item.name}`}
        title="Xóa ảnh này"
      >
        <X size={12} />
      </button>
    </button>
  );
}

export default function SettingsModal({
  open,
  onClose,
  theme,
  setTheme,
  backgroundGallery,
  activeBackgroundId,
  handleAddBackgroundImages,
  handleSelectBackgroundImage,
  handleDeleteBackgroundImage,
  activeBackgroundImage,
  backgroundOpacity,
  setBackgroundOpacity,
  autoRotateBackground,
  setAutoRotateBackground,
}) {
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleKey(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  function handleFileChange(event) {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleAddBackgroundImages(files);
    }
    // Reset the input so picking the same file again still triggers change.
    event.target.value = "";
  }

  if (!open) return null;

  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settingsModalTitle"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modalCard settingsModal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modalHeader">
          <h2 id="settingsModalTitle">
            <SettingsIcon size={16} />
            <span>Cài đặt</span>
          </h2>
          <button
            type="button"
            className="modalClose"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            title="Đóng"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modalBody">
          <section className="settingsSection">
            <h3 className="settingsSectionTitle">Giao diện</h3>
            <div className="settingsThemeRow" role="radiogroup" aria-label="Chế độ giao diện">
              <button
                type="button"
                role="radio"
                aria-checked={theme === "dark"}
                className={`settingsThemeOption ${theme === "dark" ? "isActive" : ""}`}
                onClick={() => setTheme("dark")}
              >
                <span className="settingsThemeSwatch settingsThemeSwatchDark" aria-hidden="true" />
                <span className="settingsThemeLabel">
                  <strong>Dark mode</strong>
                  <small>Nền tối</small>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={theme === "light"}
                className={`settingsThemeOption ${theme === "light" ? "isActive" : ""}`}
                onClick={() => setTheme("light")}
              >
                <span className="settingsThemeSwatch settingsThemeSwatchLight" aria-hidden="true" />
                <span className="settingsThemeLabel">
                  <strong>Light mode</strong>
                  <small>Nền sáng</small>
                </span>
              </button>
            </div>
          </section>

          <section className="settingsSection">
            <h3 className="settingsSectionTitle">Hình nền ứng dụng</h3>
            <p className="settingsHint">
              Upload nhiều ảnh, chọn một ảnh làm nền, hoặc xóa từng ảnh khỏi gallery.
            </p>
            <div className="settingsBackgroundControls">
              <button
                type="button"
                className="modalButton primary"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageIcon size={15} />
                <span>Thêm ảnh nền</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={handleFileChange}
              />
            </div>

            {backgroundGallery.length > 0 ? (
              <div className="settingsBackgroundGrid" role="list" aria-label="Danh sách ảnh nền">
                {backgroundGallery.map((item) => (
                  <BackgroundGalleryItem
                    key={item.id}
                    item={item}
                    isActive={item.id === activeBackgroundId}
                    onSelect={handleSelectBackgroundImage}
                    onDelete={handleDeleteBackgroundImage}
                  />
                ))}
              </div>
            ) : null}

            <div
              className={`settingsBackgroundPreview ${activeBackgroundImage ? "hasImage" : ""}`}
              aria-label="Ảnh nền đang chọn"
            >
              {activeBackgroundImage ? (
                <img src={activeBackgroundImage} alt="Ảnh nền đang chọn" />
              ) : (
                <span className="settingsBackgroundEmpty">
                  Đang dùng nền mặc định.
                </span>
              )}
            </div>

            {activeBackgroundImage ? (
              <div className="settingsRange">
                <div className="settingsRangeHeader">
                  <span>Độ rõ ảnh nền</span>
                  <span>{backgroundOpacity}%</span>
                </div>
                <input
                  type="range"
                  min={MIN_OPACITY}
                  max={MAX_OPACITY}
                  step={1}
                  value={backgroundOpacity}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) setBackgroundOpacity(next);
                  }}
                  aria-label="Độ rõ ảnh nền"
                />
                <p className="settingsHint">
                  Kéo để chỉnh độ rõ của ảnh nền (10% = mờ nhất, 100% = rõ nhất).
                </p>
              </div>
            ) : null}

            {backgroundGallery.length >= 2 ? (
              <div className="settingsToggleRow">
                <div className="settingsToggleLabel">
                  <span className="settingsToggleTitle">Tự đổi ảnh nền</span>
                  <span className="settingsHint" style={{ marginTop: 2 }}>
                    Tự chuyển ảnh nền sau mỗi 2 phút.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoRotateBackground}
                  aria-label="Tự đổi ảnh nền"
                  className={`settingsToggle ${autoRotateBackground ? "isOn" : ""}`}
                  onClick={() => setAutoRotateBackground(!autoRotateBackground)}
                >
                  <span className="settingsToggleThumb" />
                </button>
              </div>
            ) : (
              <p className="settingsHint" style={{ marginTop: 10 }}>
                Cần ít nhất 2 ảnh nền để tự động đổi.
              </p>
            )}
          </section>
        </div>

        <div className="modalFooter">
          <button type="button" className="modalButton ghost" onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
