import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  extractVideoId,
  isValidYouTubeUrl,
  parseYoutubeShareUrl,
  buildLrcPrompt,
} from "../services/youtube.js";
import {
  startLrcGeneration,
  continueAfterLogin,
  cancelLrcGeneration,
  inspectLrcLock,
  forceResetLrcLock,
} from "../services/geminiLrc.js";
import { appendUserSong } from "../services/songStorage.js";
import {
  extractLrcFromGeminiOutput,
  extractSongMetadata,
  DEFAULT_GENRE,
} from "../services/lrcParser.ts";
import { saveLrcText, deleteLrcText } from "../services/lrcStorage.ts";
import { saveAssetByKey, rollbackAddSongAssets } from "../services/assetStorage.ts";
import { startMp3Job } from "../services/mp3Bridge.js";

/**
 * Maps a numeric HTTP status from the MP3 provider to the user-facing
 * Vietnamese message the AddSong modal should display. Returned shape:
 *   { httpStatus, userMessage, technicalReason }
 *
 * Unknown statuses still get a generic-but-actionable message so the user
 * never sees the old "Bài sẽ được lưu nhưng phát nhạc sẽ báo 'Chưa có file
 * MP3.'" stub.
 */
function mapMp3ErrorToMessage(httpStatus, fallbackReason) {
  const status = typeof httpStatus === "number" ? httpStatus : null;
  switch (status) {
    case 401:
      return {
        httpStatus: 401,
        userMessage:
          "Dịch vụ MP3 từ chối quyền truy cập (HTTP 401). Đã hủy thêm bài.",
        technicalReason: "HTTP 401 Unauthorized",
      };
    case 403:
      return {
        httpStatus: 403,
        userMessage:
          "Dịch vụ MP3 bị chặn quyền truy cập (HTTP 403). Đã hủy thêm bài.",
        technicalReason: "HTTP 403 Forbidden",
      };
    case 404:
      return {
        httpStatus: 404,
        userMessage:
          "Dịch vụ MP3 không tìm thấy file (HTTP 404). Đã hủy thêm bài.",
        technicalReason: "HTTP 404 Not Found",
      };
    case 410:
      return {
        httpStatus: 410,
        userMessage:
          "Dịch vụ MP3 trả link đã hết hạn hoặc bị xoá (HTTP 410). Đã hủy thêm bài, vui lòng thử lại sau.",
        technicalReason: "HTTP 410 Gone",
      };
    case 429:
      return {
        httpStatus: 429,
        userMessage:
          "Dịch vụ MP3 đang giới hạn request (HTTP 429). Đã hủy thêm bài.",
        technicalReason: "HTTP 429 Too Many Requests",
      };
    default:
      return {
        httpStatus: status,
        userMessage:
          "Không thể tải MP3. Đã hủy thêm bài và xoá dữ liệu tạm." +
          (status
            ? " (HTTP " + status + ")"
            : fallbackReason
              ? " (" + fallbackReason + ")"
              : ""),
        technicalReason: fallbackReason || (status ? "HTTP " + status : "UNKNOWN"),
      };
  }
}

const STEPS = {
  IDLE: "idle",
  VALIDATE: "validate",
  COVER: "cover",
  GEMINI_OPEN: "gemini-open",
  GEMINI_PROMPT: "gemini-prompt",
  GEMINI_WAIT: "gemini-wait",
  GEMINI_RESUME: "gemini-resume",
  GEMINI_API: "gemini-api",
  LRC_SAVE: "lrc-save",
  ASSET_SAVE: "asset-save",
  AUDIO_FETCH: "audio-fetch",
  AUDIO_SAVE: "audio-save",
  AUDIO_PROMPT: "audio-prompt",
  PERSIST: "persist",
  DONE: "done",
  ERROR: "error",
  CANCELLED: "cancelled",
};

const STEP_MESSAGES = {
  [STEPS.IDLE]: "Sẵn sàng",
  [STEPS.VALIDATE]: "Đang kiểm tra liên kết YouTube...",
  [STEPS.COVER]: "Đang tải ảnh thumbnail...",
  [STEPS.GEMINI_OPEN]: "Đang mở Gemini...",
  [STEPS.GEMINI_PROMPT]: "Đang chèn prompt vào Gemini...",
  [STEPS.GEMINI_WAIT]: "Đã gửi prompt, đang chờ Gemini trả lời...",
  [STEPS.GEMINI_RESUME]: "Đang chờ bạn đăng nhập Gemini...",
  [STEPS.GEMINI_API]: "Đang gọi Gemini API...",
  [STEPS.LRC_SAVE]: "Đang lưu LRC vào IndexedDB...",
  [STEPS.ASSET_SAVE]: "Đang lưu ảnh bìa vào IndexedDB...",
  [STEPS.AUDIO_FETCH]: "Đang lấy file MP3 (yt2mp3-page-bridge)...",
  [STEPS.AUDIO_SAVE]: "Đang lưu MP3 vào IndexedDB...",
  [STEPS.AUDIO_PROMPT]: "Đang lưu bài hát...",
  [STEPS.PERSIST]: "Đang lưu vào danh sách...",
  [STEPS.DONE]: "Hoàn tất.",
  [STEPS.ERROR]: "",
  [STEPS.CANCELLED]: "Đã hủy.",
};

// Cụm từ AI từ chối / hallucination khi không truy cập được link.
// So khớp theo lower-case substring để bắt cả tiếng Việt có dấu.
const REFUSAL_PHRASES = [
  "không thể truy cập trực tiếp",
  "không thể truy cập vào liên kết",
  "không thể truy cập liên kết",
  "không thể xem video",
  "không thể nghe audio",
  "không thể tạo lời bài hát",
  "tôi không thể",
  "xin lỗi",
  "i can't access",
  "i cannot access",
  "i'm unable to access",
  "i am unable to access",
  "cannot view",
  "cannot listen",
  "unable to access youtube",
  "cannot_access_video",
  "cannot access video",
  "as an ai",
  "language model",
];

function detectRefusalOrHallucination(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { isRefusal: false, matched: "" };
  }
  const lower = text.toLowerCase();
  for (const phrase of REFUSAL_PHRASES) {
    if (lower.includes(phrase)) {
      return { isRefusal: true, matched: phrase };
    }
  }
  return { isRefusal: false, matched: "" };
}

const log = (message, extra) => {
  if (extra !== undefined) console.log("[AddSong]", message, extra);
  else console.log("[AddSong]", message);
};

export default function AddSongModal({ open, onClose, onSongAdded }) {
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [step, setStep] = useState(STEPS.IDLE);
  const [errorMessage, setErrorMessage] = useState("");
  const [progressLog, setProgressLog] = useState([]);
  const [needLogin, setNeedLogin] = useState(false);
  const [finalSong, setFinalSong] = useState(null);
  // When the background job lock rejects a new run, we remember the
  // jobId that holds it so the user can target the correct lock when
  // force-resetting.
  const [lockedByJobId, setLockedByJobId] = useState(null);
  const [lockInspectResult, setLockInspectResult] = useState(null);
  const [isResettingLock, setIsResettingLock] = useState(false);
  // True once the user has clicked "Tạo bài hát". Controls whether the
  // secondary action reads "Đóng" (no job to cancel) or "Hủy" (active job).
  const [hasStarted, setHasStarted] = useState(false);
  // True after Gemini API mode fails because the response contained a
  // refusal/hallucination phrase. Drives the "Chạy lại bằng Gemini Web UI"
  // shortcut button under the error message.
  const [refusalDetected, setRefusalDetected] = useState(false);
  // LRC provider: "gemini-ui" (default) or "gemini-api"
  const [lrcProvider, setLrcProvider] = useState("gemini-ui");
  // API key for Gemini API mode (persisted separately)
  const [apiKey, setApiKey] = useState("");
  // Whether the API key input field is visible (toggle via gear icon)
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const correlationIdRef = useRef(null);
  const jobIdRef = useRef(null);
  const abortRef = useRef(false);
  const stepRef = useRef(STEPS.IDLE);
  const onCloseRef = useRef(onClose);
  const cancelLrcGenerationRef = useRef(null);
  const linkRef = useRef("");
  // MP3 pipeline uses its own correlationId (separate from Gemini's).
  // Background owns the job; this id only filters incoming mp3/* events.
  const mp3CorrelationIdRef = useRef(null);
  // Holds the active mp3 listener cleanup fn so we can detach it on
  // modal unmount / cancel.
  const mp3CleanupRef = useRef(null);
  // Ref for cancelling the API mode job
  const apiCancelRef = useRef(false);
  // Metadata surfaced by the background on `mp3/result`. Sidepanel reads
  // this when building the song record so we persist `audioSource`,
  // `audioFilesize`, `duration` and (optionally) a fallback `title`.
  const audioMetaRef = useRef({ filesize: null, duration: null, title: "" });

  // True when the user has manually typed into the title/artist inputs.
  // Used so we don't clobber their input with auto-extracted values from
  // Gemini's response.
  const userTouchedMetaRef = useRef(false);
  // Mirror refs of `title`/`artist` state. `setState` schedules a re-render
  // but the closure variables `title`/`artist` inside the same async tick
  // are still the pre-update values — so when `tryAutoFillMeta` calls
  // `setTitle(meta.title)` and we then `await persistSong({title, ...})`
  // immediately, `title` is still "" and we'd persist the videoId. The
  // refs are updated synchronously alongside `setState` so callers can
  // read the latest value without waiting for the next render.
  const titleRef = useRef("");
  const artistRef = useRef("");
  // Snapshot of the metadata that Gemini's response auto-filled. Used as
  // a fallback when `titleRef.current` is empty (Gemini returned a title
  // but the user didn't touch the field AND state hasn't re-rendered
  // yet) so we never lose Gemini's answer to a stale closure. `genre`
  // is one of the canonical labels in services/lrcParser.ALLOWED_GENRES
  // and is what we persist as tags[0] for user-added songs.
  const geminiMetaRef = useRef({ title: "", artist: "", genre: "" });

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    cancelLrcGenerationRef.current = (correlationId, jobId) =>
      cancelLrcGeneration({ correlationId, jobId });
  });

  useEffect(() => {
    linkRef.current = link;
  }, [link]);

  // Keep the ref mirrors of `title`/`artist` in sync with state. This
  // makes them the single source of truth for any async path that
  // persists metadata immediately after a `setTitle`/`setArtist` call.
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    artistRef.current = artist;
  }, [artist]);

  useEffect(() => {
    if (!open) {
      setLink("");
      setTitle("");
      setArtist("");
      // Reset the ref mirrors and the Gemini snapshot too — otherwise the
      // next modal open would inherit auto-filled metadata from the
      // previous session (only the *state* resets via setState above, but
      // refs survive because they aren't tied to the controlled inputs).
      titleRef.current = "";
      artistRef.current = "";
      geminiMetaRef.current = { title: "", artist: "", genre: "" };
      userTouchedMetaRef.current = false;
      setStep(STEPS.IDLE);
      setErrorMessage("");
      setProgressLog([]);
      setNeedLogin(false);
      setFinalSong(null);
      setLockedByJobId(null);
      setLockInspectResult(null);
      setIsResettingLock(false);
      setHasStarted(false);
      correlationIdRef.current = null;
      jobIdRef.current = null;
      abortRef.current = false;
      // Drop the MP3 listener so we don't react to a previous job after
      // the modal closes. Background keeps running the conversion
      // regardless; we just stop listening.
      if (mp3CleanupRef.current) {
        try { mp3CleanupRef.current(); } catch (_) { /* noop */ }
        mp3CleanupRef.current = null;
      }
      mp3CorrelationIdRef.current = null;
      audioMetaRef.current = { filesize: null, duration: null, title: "" };
    } else {
      // When the modal opens, proactively clear any stale background lock so the
      // "Phiên Gemini cũ vẫn đang được giữ" banner never shows up.
      (async () => {
        try {
          const inspect = await inspectLrcLock();
          if (inspect && inspect.jobId) {
            await forceResetLrcLock();
          }
        } catch (_) { /* best-effort */ }
      })();
      // Also restore provider / API key preferences from storage.
      loadProviderSettings();
    }
  }, [open]);

  // Force the provider to Gemini Web UI. Legacy users who had previously
  // persisted "gemini-api" are coerced back to "gemini-ui", and the storage
  // record is also reset so the next open does not flicker.
  async function loadProviderSettings() {
    setLrcProvider("gemini-ui");
    setApiKey("");
    try {
      chrome.runtime.sendMessage(
        { type: "svdmusic:set-lrc-provider", provider: "gemini-ui" },
        () => {
          if (chrome.runtime.lastError) {
            // localStorage fallback so even environments without chrome.runtime
            // keep the same default on next open.
            try { window.localStorage.setItem("svdmusic:lrcProvider", "gemini-ui"); } catch (_) { /* noop */ }
          }
        }
      );
    } catch (_) { /* noop */ }
  }

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      const currentStep = stepRef.current;
      if (
        currentStep === STEPS.DONE ||
        currentStep === STEPS.ERROR ||
        currentStep === STEPS.CANCELLED
      ) {
        if (correlationIdRef.current && cancelLrcGenerationRef.current) {
          cancelLrcGenerationRef.current(correlationIdRef.current, jobIdRef.current).catch(() => null);
          correlationIdRef.current = null;
          jobIdRef.current = null;
        }
        onCloseRef.current?.();
      } else {
        const btn = document.querySelector("[data-add-song-cancel]");
        if (btn) btn.click();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // On full component unmount, drop the MP3 listener. Background job
  // continues independently — the sidepanel just stops listening.
  useEffect(() => {
    return () => {
      if (mp3CleanupRef.current) {
        try { mp3CleanupRef.current(); } catch (_) { /* noop */ }
        mp3CleanupRef.current = null;
      }
    };
  }, []);

  if (!open) return null;

  const appendLog = (line) => {
    if (!line) return;
    // De-duplicate identical adjacent lines. Symptom: every "Đang chèn
    // prompt" / "Đang chọn model" / "Đang chọn cấp độ tư duy" was being
    // logged twice with the same second timestamp, because the content
    // script could be injected twice on extension reload (TOCTOU race on
    // the `window.__svdmusicGeminiContentInited` guard) and each instance
    // would push the same progress message. The window-level guard plus
    // the `MY_TAB_LOCK_ID` lock already prevent two `startJob`s from
    // running, but two listeners can still both subscribe to the same
    // broadcast message. Skipping an entry whose raw text matches the
    // last entry kills the visible duplication without touching the
    // underlying race — which would only re-surface if the user
    // actually needed both jobs at once (they don't).
    setProgressLog((prev) => {
      const last = prev[prev.length - 1] || "";
      const lastText = last.replace(/^\d{1,2}:\d{2}:\d{2}(\s?[AP]M)?\s+/i, "").trim();
      if (lastText === line.trim()) return prev;
      return [
        ...prev,
        new Date().toLocaleTimeString() + "  " + line,
      ];
    });
  };

  const setBusyStep = (nextStep, message) => {
    setStep(nextStep);
    if (message) appendLog(message);
  };

  const fail = (message, detail) => {
    if (abortRef.current) return;
    abortRef.current = true;
    setStep(STEPS.ERROR);
    setErrorMessage(message);
    if (detail) console.warn("[AddSong]", detail);
    appendLog("Lỗi: " + message);
  };

  /**
   * Force-resets the background job lock and re-inspects the result. We
   * require the user to have closed every Gemini tab first because the lock
   * is shared with whoever is still running — clearing while another tab
   * is alive would cause duplicate-log spam on the next run.
   */
  async function handleForceResetLock() {
    if (isResettingLock) return;
    setIsResettingLock(true);
    appendLog("Đang hủy lock phiên Gemini cũ (jobId=" + (lockedByJobId || "?") + ")...");
    try {
      const resp = await forceResetLrcLock();
      const cleared = !!resp?.cleared;
      appendLog(cleared
        ? "Đã hủy lock phiên Gemini cũ."
        : "Không tìm thấy lock nào đang được giữ.");
      const inspect = await inspectLrcLock();
      setLockInspectResult(inspect || null);
      setLockedByJobId(null);
      setErrorMessage("");
      // Reset abort flag so the user can hit "Tạo bài hát" again right
      // away without having to close and reopen the modal.
      abortRef.current = false;
      setStep(STEPS.IDLE);
      setFinalSong(null);
    } catch (error) {
      appendLog("Hủy lock thất bại: " + (error?.message || String(error)));
    } finally {
      setIsResettingLock(false);
    }
  }

  /**
   * On modal open: inspect the background lock and silently clear it if it
   * exists. We no longer surface a banner for stale locks — we just
   * force-reset and proceed so the user never has to manually intervene.
   */
  async function refreshLockState() {
    try {
      const inspect = await inspectLrcLock();
      if (inspect && inspect.jobId) {
        await forceResetLrcLock();
        setLockInspectResult(null);
        setLockedByJobId(null);
      } else {
        setLockInspectResult(inspect || null);
      }
    } catch (_) {
      setLockInspectResult(null);
    }
  }

  /**
   * Auto-fills the title/artist inputs from Gemini's response metadata.
   * Called once the LRC is verified so the user sees "Tên bài hát" /
   * "Tên các ca sỹ" populated before they hit Add. Never overwrites a
   * field the user has manually edited (tracked via userTouchedMetaRef).
   *
   * `sourceText` should be the raw Gemini response — extractSongMetadata
   * handles preamble text, markdown, code fences, and LRC ID3 tags.
   */
  function tryAutoFillMeta(sourceText) {
    if (!sourceText) return;
    let meta;
    try {
      meta = extractSongMetadata(sourceText);
    } catch (_) {
      return;
    }
    if (
      !meta ||
      (!meta.title &&
        (!meta.artists || meta.artists.length === 0) &&
        !meta.genre)
    ) {
      return;
    }
    let filledTitle = false;
    let filledArtist = false;
    let filledGenre = false;
    let filledTitleValue = "";
    let filledArtistValue = "";
    let filledGenreValue = "";
    if (meta.title && !userTouchedMetaRef.current && !title.trim()) {
      setTitle(meta.title);
      // Sync the ref mirror synchronously — `setState` only schedules a
      // re-render and the next `persistSong({title, ...})` call in the
      // same async tick would otherwise see the stale closure value.
      titleRef.current = meta.title;
      filledTitle = true;
      filledTitleValue = meta.title;
    }
    if (
      meta.artists &&
      meta.artists.length > 0 &&
      !userTouchedMetaRef.current &&
      !artist.trim()
    ) {
      const joined = meta.artists.join(", ");
      setArtist(joined);
      artistRef.current = joined;
      filledArtist = true;
      filledArtistValue = joined;
    }
    // Genre is auto-resolved by the parser (whitelist + DEFAULT_GENRE
    // fallback) so we just propagate whatever it returned. We store it
    // on the geminiMetaRef snapshot so persistSong can pick it up as
    // tags[0] even if the user never sees it in the UI.
    if (meta.genre) {
      filledGenre = true;
      filledGenreValue = meta.genre;
    }
    if (filledTitle || filledArtist || filledGenre) {
      // Persist the Gemini snapshot so `persistSong` can fall back to it
      // even if it runs in a tick where the controlled input hasn't
      // re-rendered yet. We ONLY overwrite the snapshot fields we
      // actually filled — preserving any earlier values from this
      // session (e.g. Gemini returned a title in one batch and an artist
      // list in a later batch).
      if (filledTitleValue) geminiMetaRef.current.title = filledTitleValue;
      if (filledArtistValue) geminiMetaRef.current.artist = filledArtistValue;
      if (filledGenreValue) geminiMetaRef.current.genre = filledGenreValue;
      const parts = [];
      if (filledTitle && meta.title) parts.push(`tên bài hát: ${meta.title}`);
      if (filledArtist && meta.artists) parts.push(`ca sĩ: ${meta.artists.join(", ")}`);
      if (filledGenre && meta.genre) parts.push(`thể loại: ${meta.genre}`);
      appendLog("Đã tự điền " + parts.join(", ") + " từ phản hồi Gemini.");
    }
  }

  /**
   * Parses + validates the raw Gemini LRC response. Returns a normalised
   * `{ lrcText, fileName, downloadPath }` object, or null if the response
   * isn't usable.
   *
   * Does NOT write to IndexedDB — the LRC text is held in memory and
   * committed by `persistSong` once the MP3 is also validated and saved.
   * This is what makes the add-song flow atomic: if MP3 fails, the LRC
   * text is dropped together with the cover + audio via
   * `rollbackAddSongAssets`.
   */
  function prepareLrcInfo(videoId, lrcRaw) {
    if (!lrcRaw) {
      appendLog("Không tìm thấy nội dung LRC từ Gemini.");
      return null;
    }
    // Run the text through the LRC parser so a Python wrapper
    // (`lrc_content = """..."""`) or a markdown code fence becomes raw LRC.
    const parsed = extractLrcFromGeminiOutput(lrcRaw);
    if (!parsed.ok) {
      appendLog(
        "Gemini trả file nhưng không phải LRC hợp lệ: " +
          (parsed.reason || "UNKNOWN") +
          "."
      );
      return null;
    }

    if (parsed.sourceType === "python_wrapper") {
      appendLog("Đã phát hiện LRC dạng Python wrapper.");
    } else if (parsed.sourceType === "markdown_fence") {
      appendLog("Đã phát hiện LRC dạng markdown code block.");
    }

    const lineCount = parsed.lrcText.split("\n").filter((l) => l.trim()).length;
    appendLog(`Đã trích xuất ${lineCount} dòng LRC.`);
    appendLog(
      "LRC đã sẵn sàng — sẽ commit vào IndexedDB sau khi MP3 OK."
    );

    return {
      lrcText: parsed.lrcText,
      fileName: videoId + ".lrc",
      downloadPath: "svdmusic/lrc/" + videoId + ".lrc",
    };
  }

  /**
   * Downloads the YouTube thumbnail for `videoId` and returns the Blob.
   * Does NOT write to IndexedDB — the blob is handed to `persistSong`
   * which commits it atomically alongside the rest of the add-song flow.
   *
   * Returns null when every variant fails so the caller can log a
   * warning without aborting.
   */
  async function fetchCoverBlob(videoId) {
    setBusyStep(STEPS.ASSET_SAVE, STEP_MESSAGES[STEPS.ASSET_SAVE]);
    try {
      const thumbs = getThumbnailUrls(videoId);
      const blob = await fetchFirstThumbnailBlob(thumbs);
      if (!blob) {
        appendLog("Cảnh báo: không tải được thumbnail để lưu vào IndexedDB.");
        return null;
      }
      return blob;
    } catch (error) {
      appendLog(
        "Cảnh báo: không tải được thumbnail (" +
          (error.message || error) +
          "). Vẫn tiếp tục tạo bài."
      );
      return null;
    }
  }

  /**
   * Run the MP3 pipeline end-to-end and return the validated blob + metadata.
   *
   * IMPORTANT: This function does NOT write to IndexedDB. That write is
   * deferred to `persistSong` so the whole add-song flow can stay atomic:
   * if the user closes the modal, or any later step fails, we can call
   * `rollbackAddSongAssets(videoId)` and IndexedDB stays clean.
   *
   * Returns one of:
   *   { ok: true,  blob, mimeType, size, title, filesize, duration, audioSource }
   *   { ok: false, code: 'http'|'size'|'type'|'header'|'idb'|'timeout'|'network'|'unknown', httpStatus?, message }
   *
   * The `code` is consumed by the runGemini/runGeminiApi catch-block to
   * build a user-facing message via `mapMp3ErrorToMessage`.
   */
  async function fetchAndValidateAudio(videoId, youtubeUrl) {
    setBusyStep(STEPS.AUDIO_FETCH, STEP_MESSAGES[STEPS.AUDIO_FETCH]);

    // Background owns the job; the sidepanel just kicks it off and
    // subscribes to broadcasts. We never await a Port that might be
    // closed mid-conversion.
    const correlationId =
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "svdmusic-mp3-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    mp3CorrelationIdRef.current = correlationId;

    return new Promise((resolve) => {
      const stageText = {
        queued: "Đang gửi yêu cầu tới yt2mp3-page-bridge...",
        auth: "Đang xác thực dịch vụ...",
        init: "Đang khởi tạo phiên chuyển đổi...",
        convert: "Đang yêu cầu chuyển đổi MP3...",
        polling: "Đang chờ server chuyển đổi xong...",
        download: "Đang tải file MP3 về...",
        received: "Đã nhận file MP3 từ dịch vụ.",
        ready: "Đã sẵn sàng file MP3.",
        "bridge/open-tab": "Đang mở tab bridge...",
        "bridge/api-ok": "Đã nhận link MP3 từ dịch vụ...",
        "bridge/mp3-fetch": "Đang tải file MP3 về...",
        "bridge/mp3-fallback": "Đang tải MP3 qua page context...",
        "bridge/mp3-fetch-invalid":
          "File MP3 trả về không hợp lệ, đang thử lại qua page context...",
        "bridge/mp3-ready": "Đã tải xong dữ liệu MP3, đang kiểm tra...",
      };

      const finalize = (result) => {
        if (mp3CleanupRef.current === cleanup) mp3CleanupRef.current = null;
        cleanup();
        resolve(result);
      };

      const cleanup = () => {
        try { chrome.runtime.onMessage.removeListener(listener); } catch (_) { /* noop */ }
      };

      // base64 → Uint8Array. Chrome's structured-clone drops ArrayBuffer
      // across chrome.runtime.sendMessage (it becomes {} on the receiver,
      // which a `new Blob([{}])` would silently turn into the 15-byte string
      // "[object Object]"). The background therefore encodes the MP3 bytes
      // as base64 first; we decode here and validate byteLength === size
      // before doing anything else with the body.
      function base64ToUint8Array(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      const listener = async (message) => {
        if (!message || typeof message !== "object") return;
        if (message.correlationId !== correlationId) return;

        if (message.type === "mp3/progress") {
          const stage = message.stage || "progress";
          const baseText = stageText[stage] || `(${stage})`;
          if (stage === "bridge/mp3-fetch-invalid" && message && typeof message === "object") {
            const diag = [];
            if (message.status != null) diag.push(`status=${message.status}`);
            if (message.size != null) diag.push(`size=${message.size}`);
            if (message.type) diag.push(`type=${message.type}`);
            if (message.reason) diag.push(`reason=${message.reason}`);
            appendLog(
              diag.length
                ? `${baseText} [${diag.join(", ")}]`
                : baseText
            );
            return;
          }
          appendLog(baseText);
          return;
        }

        if (message.type === "mp3/result") {
          let blob = null;
          let decodedBytes = null;
          if (message.audioBase64) {
            decodedBytes = base64ToUint8Array(message.audioBase64);

            if (
              typeof message.size === "number" &&
              message.size > 0 &&
              decodedBytes.byteLength !== message.size
            ) {
              appendLog(
                "Cảnh báo: size MP3 lệch sau decode base64 (" +
                  decodedBytes.byteLength + "/" + message.size + ")."
              );
              finalize({
                ok: false,
                code: "size",
                httpStatus: null,
                message: "Size MP3 lệch sau decode base64 (" +
                  decodedBytes.byteLength + "/" + message.size + ").",
              });
              return;
            }

            blob = new Blob([decodedBytes], {
              type: message.mimeType || "audio/mpeg",
            });
          }
          audioMetaRef.current = {
            filesize:
              typeof message.filesize === "number" && message.filesize > 0
                ? message.filesize
                : blob
                  ? blob.size
                  : null,
            duration:
              typeof message.duration === "number" ? message.duration : null,
            title:
              typeof message.title === "string" && message.title.trim()
                ? message.title.trim()
                : "",
          };
          // Strict validation. We do NOT trust the background's "ready"
          // label alone. If anything looks wrong we reject the payload
          // and let the runGemini/runGeminiApi caller decide what to do
          // (per the new atomic flow, that's "rollback and fail").
          const blobSize = blob ? blob.size : 0;
          const blobType = (blob?.type || message.mimeType || "").toLowerCase();
          const goodType =
            blobType.indexOf("audio/") === 0 ||
            blobType.indexOf("application/octet-stream") === 0;
          if (!blob || blobSize < 100000 || !goodType) {
            appendLog(
              "Cảnh báo: dịch vụ trả về file MP3 không hợp lệ (" +
                (blob ? `${blobSize} bytes, type=${blobType}` : "không có audioBase64") +
                ")."
            );
            finalize({
              ok: false,
              code: blobSize < 100000 ? "size" : "type",
              httpStatus: null,
              message: "Dịch vụ trả về file MP3 không hợp lệ (" +
                (blob ? `${blobSize} bytes, type=${blobType}` : "không có audioBase64") +
                ").",
            });
            return;
          }
          // Header check. A real MP3 starts with "ID3" or 0xFFFB sync.
          let headerOk = false;
          let headerSummary = "";
          try {
            const headBytes = decodedBytes.subarray
              ? decodedBytes.subarray(0, Math.min(4, decodedBytes.byteLength))
              : decodedBytes.slice(0, 4);
            headerSummary = Array.from(headBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ");
            if (
              headBytes[0] === 0x49 &&
              headBytes[1] === 0x44 &&
              headBytes[2] === 0x33
            ) {
              headerOk = true; // "ID3"
            } else if (
              headBytes[0] === 0xff &&
              (headBytes[1] & 0xe0) === 0xe0
            ) {
              headerOk = true; // MPEG sync
            }
          } catch (_) { /* noop */ }
          if (!headerOk) {
            appendLog(
              "Cảnh báo: payload MP3 thiếu header hợp lệ (first4bytes=[" +
                headerSummary +
                "], size=" + blobSize +
                " bytes) — không phải MP3 thật."
            );
            finalize({
              ok: false,
              code: "header",
              httpStatus: null,
              message: "Payload MP3 thiếu header hợp lệ (first4bytes=[" +
                headerSummary + "]).",
            });
            return;
          }
          // All checks passed. Return blob — caller will IndexedDB-save it
          // after the rest of the add-song pipeline commits.
          setBusyStep(STEPS.AUDIO_SAVE, STEP_MESSAGES[STEPS.AUDIO_SAVE]);
          appendLog(
            "File MP3 đã hợp lệ (" +
              blobSize + " bytes, type=" + blobType +
              ", first4bytes=[" + headerSummary + "])."
          );
          finalize({
            ok: true,
            blob,
            mimeType: blobType || "audio/mpeg",
            size: blob.size,
            title: message.title || videoId,
            filesize:
              typeof message.filesize === "number" && message.filesize > 0
                ? message.filesize
                : blob.size,
            duration:
              typeof message.duration === "number" ? message.duration : null,
            audioSource:
              typeof message.audioSource === "string"
                ? message.audioSource
                : "yt2mp3-page-bridge",
          });
          return;
        }

        if (message.type === "mp3/result-invalid") {
          appendLog(
            "Cảnh báo: payload MP3 không hợp lệ (" +
              (message.size != null ? `${message.size} bytes` : "không rõ size") +
              ", " +
              (message.mimeType || "không rõ type") +
              ")."
          );
          finalize({
            ok: false,
            code: message.size && message.size < 100000 ? "size" : "type",
            httpStatus: null,
            message: message.reason || "Payload MP3 không hợp lệ.",
          });
          return;
        }

        if (message.type === "mp3/ready") {
          // Bookkeeping event. IndexedDB write happens later in persistSong.
          return;
        }

        if (message.type === "mp3/error") {
          const reason = message.error || "không rõ";
          // The background now includes `status` when the failure was an
          // HTTP non-2xx. Map it to the user-facing message immediately
          // so the modal can show the exact spec-mandated copy.
          const httpStatus = typeof message.status === "number" ? message.status : null;
          const mapped = mapMp3ErrorToMessage(httpStatus, reason);
          appendLog("Lỗi MP3: " + mapped.technicalReason + " — " + reason);
          finalize({
            ok: false,
            code: httpStatus ? "http" : "unknown",
            httpStatus,
            message: reason,
          });
          return;
        }
      };

      mp3CleanupRef.current = cleanup;
      chrome.runtime.onMessage.addListener(listener);

      startMp3Job({
        correlationId,
        videoId,
        youtubeUrl,
      }).catch((error) => {
        appendLog(
          "Lỗi: không khởi động được MP3 pipeline (" +
            (error?.message || error) +
            ")."
        );
        finalize({
          ok: false,
          code: "network",
          httpStatus: null,
          message: (error?.message || error || "Không khởi động được MP3 pipeline."),
        });
      });
    });
  }

  /**
   * Atomically commits the add-song result:
   *   1. save coverBlob to IndexedDB (`cover:{videoId}`)
   *   2. save lrcText   to IndexedDB (`lrc:{videoId}`)
   *   3. save audioBlob to IndexedDB (`audio:{videoId}`)
   *   4. appendUserSong(song) → localStorage
   *
   * If ANY of these steps throws, we call `rollbackAddSongAssets(videoId)`
   * to undo the partial writes and re-throw. The caller (`runGemini` /
   * `runGeminiApi` / `handleResumeAfterLogin`) is expected to catch and
   * surface a user-facing error.
   *
   * `audioBlob` is REQUIRED. Passing `{ ok: false, ... }` (the failure
   * shape from `fetchAndValidateAudio`) throws immediately — no song is
   * persisted with `audioMissing: true` under the new atomic flow.
   *
   * `coverBlob` is OPTIONAL but strongly recommended. We commit without
   * a cover (and just log a warning) so a flaky thumbnail fetch doesn't
   * cancel the whole add.
   */
  async function persistSong({
    videoId,
    sourceUrl,
    title,
    artist,
    genre,
    lrcText,
    lrcFileName,
    lrcDownloadPath,
    coverBlob,
    audioResult,
  }) {
    if (!videoId) throw new Error("persistSong: thiếu videoId.");
    if (!audioResult || audioResult.ok !== true || !audioResult.blob) {
      // Defence-in-depth — callers are expected to short-circuit on
      // MP3 failure before reaching here, but if anyone forgets we want
      // a clear throw instead of a half-written song.
      throw new Error(
        "persistSong: audioResult không hợp lệ — không thể commit bài hát không có MP3."
      );
    }

    setBusyStep(STEPS.PERSIST, STEP_MESSAGES[STEPS.PERSIST]);

    // Pre-compute metadata using the validated audio blob.
    const audioBlob = audioResult.blob;
    const providerTitle = (audioResult.title || "").trim();
    const trimmedTitle = (title || "").trim();
    const songTitle =
      providerTitle && (!trimmedTitle || trimmedTitle.toLowerCase() === "không rõ")
        ? providerTitle
        : trimmedTitle || videoId;
    const songArtist = (artist || "").trim() || "Không rõ";
    // Genre comes from the Gemini auto-fill (whitelist already enforced
    // by the parser). If for any reason it's empty we fall back to the
    // canonical default rather than persist the literal "User" tag —
    // built-in songs use real genre labels (V-Pop, Remix, ...) and we
    // want user-added songs to look consistent in the playlist UI.
    const trimmedGenre = (genre || "").trim();
    const songTags = trimmedGenre ? [trimmedGenre] : [DEFAULT_GENRE];

    const audioFilesize =
      typeof audioResult.filesize === "number" && audioResult.filesize > 0
        ? audioResult.filesize
        : audioBlob.size;
    const duration =
      typeof audioResult.duration === "number" ? audioResult.duration : null;

    const coverKey = `cover:${videoId}`;
    const lrcKey = `lrc:${videoId}`;
    const audioKey = `audio:${videoId}`;

    let coverWritten = false;
    let lrcWritten = false;
    let audioWritten = false;

    try {
      // ── Step 1: cover (best-effort) ─────────────────────────────────
      if (coverBlob instanceof Blob) {
        try {
          await saveAssetByKey(coverKey, coverBlob);
          coverWritten = true;
          appendLog("Đã lưu ảnh bìa vào IndexedDB (key: " + coverKey + ").");
        } catch (err) {
          appendLog(
            "Cảnh báo: không lưu được ảnh bìa vào IndexedDB (" +
              (err?.message || err) +
              "). Vẫn tiếp tục commit bài hát."
          );
          // not fatal — see note above
        }
      } else {
        appendLog("Cảnh báo: không có cover blob — bài hát sẽ dùng placeholder.");
      }

      // ── Step 2: LRC text (required for the song to be useful) ───────
      if (!lrcText) {
        throw new Error(
          "persistSong: thiếu lrcText — không thể commit bài hát không có lời."
        );
      }
      await saveLrcText(videoId, lrcText);
      lrcWritten = true;
      appendLog("Đã lưu LRC vào IndexedDB (key: " + lrcKey + ").");

      // ── Step 3: MP3 audio blob (REQUIRED) ───────────────────────────
      await saveAssetByKey(audioKey, audioBlob);
      audioWritten = true;
      const mb = (audioBlob.size / (1024 * 1024)).toFixed(2);
      appendLog(
        `Đã lưu MP3 vào IndexedDB (key: ${audioKey}, ${mb} MB).`
      );

      // ── Step 4: persist song metadata ───────────────────────────────
      const song = {
        id: "user-" + videoId,
        title: songTitle,
        artist: songArtist,
        tags: songTags,
        sourceUrl,
        coverKey,
        audioKey,
        lyricsKey: lrcKey,
        lyricsTextKey: lrcKey,
        cover: "",
        banner: "",
        audio: "",
        coverSaved: coverWritten,
        audioMissing: false,
        audioSource: audioResult.audioSource || "yt2mp3-page-bridge",
        audioFilesize,
        duration: duration ?? undefined,
        addedAt: Date.now(),
        isUserSong: true,
      };
      if (lrcFileName) song.lyricsFileName = lrcFileName;
      if (lrcDownloadPath) song.lyricsDownloadPath = lrcDownloadPath;
      song.lyricsDownloaded = true;

      await appendUserSong(song);
      setFinalSong(song);
      setStep(STEPS.DONE);
      appendLog("Đã thêm bài: " + song.title + " - " + song.artist);
      if (typeof onSongAdded === "function") onSongAdded(song);
      // Quick visual cue that audio actually landed.
      appendLog("Đã cập nhật bài hát: audioMissing=false");
    } catch (err) {
      // Anything that threw past the validation gate is fatal — undo
      // every IndexedDB write we already did in this attempt.
      appendLog("Lỗi khi commit bài hát: " + (err?.message || err));
      appendLog("Đang xoá dữ liệu tạm do commit thất bại...");
      try {
        const removed = await rollbackAddSongAssets(videoId, [
          // Defensive: pass any key we know we *tried* to write so a
          // mid-step throw doesn't leave a stale row the helper might
          // miss. rollbackAddSongAssets also re-derives these from
          // videoId, but the explicit list is a belt-and-suspenders
          // guarantee.
          coverWritten ? coverKey : null,
          lrcWritten ? lrcKey : null,
          audioWritten ? audioKey : null,
        ].filter(Boolean));
        if (removed.removed.length) {
          appendLog(
            "[AddSongRollback] đã xoá: " + removed.removed.join(", ")
          );
        }
        if (removed.failed.length) {
          appendLog(
            "[AddSongRollback] một số key không xoá được: " +
              removed.failed.map((f) => f.key).join(", ")
          );
        }
        appendLog("Đã xoá dữ liệu tạm. Bài hát chưa được thêm.");
      } catch (rollbackErr) {
        appendLog(
          "Cảnh báo: rollback thất bại (" +
            (rollbackErr?.message || rollbackErr) +
            "). Vui lòng xoá thủ công trong DevTools."
        );
      }
      // Re-throw so the caller (runGemini / runGeminiApi /
      // handleResumeAfterLogin) can apply its own user-facing message.
      throw err;
    }
  }

  async function runGemini({ videoId }) {
    const sourceUrl = linkRef.current.trim();
    const prompt = buildLrcPrompt(sourceUrl, videoId);
    setBusyStep(STEPS.GEMINI_OPEN, STEP_MESSAGES[STEPS.GEMINI_OPEN]);

    // Fetch the cover into memory (no IndexedDB write yet). persistSong
    // commits it atomically alongside the LRC and MP3.
    const coverBlob = await fetchCoverBlob(videoId);

    const handleProgress = (payload) => {
      if (!payload) return;
      if (payload.message) appendLog(payload.message);
      if (payload.needLogin) {
        setNeedLogin(true);
        setBusyStep(STEPS.GEMINI_RESUME, STEP_MESSAGES[STEPS.GEMINI_RESUME]);
      }
      if (payload.step) {
        if (payload.step === "insert-prompt") {
          setStep(STEPS.GEMINI_PROMPT);
        } else if (payload.step === "waiting-for-result") {
          setStep(STEPS.GEMINI_WAIT);
        } else if (payload.step === "thinking-warning") {
          appendLog("⚠ " + (payload.message || ""));
        }
      }
    };

    let handle;
    try {
      handle = await startLrcGeneration(
        { youtubeLink: sourceUrl, prompt },
        handleProgress
      );
    } catch (error) {
      // Lock-conflict path: surface a clear error and expose a button that
      // lets the user force-clear the lock after closing every Gemini tab.
      if (error?.lockedBy || /đã có một phiên gemini đang chạy/i.test(error?.message || "")) {
        setStep(STEPS.IDLE);
        setFinalSong(null);
        setErrorMessage(error.message || "Phiên Gemini trước vẫn đang được giữ.");
        setLockedByJobId(error?.lockedBy || null);
        appendLog("Phiên Gemini trước vẫn được giữ — hãy đóng hết tab Gemini rồi bấm 'Hủy lock cũ' để tiếp tục.");
        return;
      }
      fail(error.message || "Lỗi khi chạy Gemini.", error);
      return;
    }

    const { correlationId, jobId, result } = handle;
    correlationIdRef.current = correlationId;
    jobIdRef.current = jobId;

    const lrcRaw = result?.lrcText || "";
    if (!lrcRaw) {
      fail(
        "Gemini đã hoàn tất phản hồi nhưng không có nội dung LRC. " +
          "Bài hát chưa được thêm vào danh sách để tránh lưu sai.",
        null
      );
      return;
    }

    appendLog("Đã nhận file attachment từ Gemini.");

    // LRC is now parsed in-memory only — we wait for the MP3 result before
    // committing anything to IndexedDB. If MP3 fails the helper at the
    // end of this function will call `rollbackAddSongAssets(videoId)`.
    const lrcInfo = prepareLrcInfo(videoId, lrcRaw);
    if (!lrcInfo) {
      fail(
        "Không trích xuất được LRC hợp lệ từ phản hồi của Gemini. " +
          "Bài hát chưa được thêm vào danh sách để tránh lưu sai.",
        null
      );
      return;
    }

    // Auto-fill Tên bài hát / Tên các ca sỹ từ phản hồi Gemini (nếu có).
    // Không ghi đè nếu user đã nhập tay.
    tryAutoFillMeta(lrcRaw);

    // Run the MP3 pipeline. Atomic flow: if this fails (HTTP 410, bad
    // header, IndexedDB error, etc.) we abort and rollback. No song is
    // ever persisted with `audioMissing: true` under the new contract.
    const audioResult = await fetchAndValidateAudio(videoId, sourceUrl);

    if (!audioResult.ok) {
      // Map the failure to a user-facing message and trigger rollback
      // for any assets that may have leaked in earlier steps (cover is
      // the most likely — we fetched it at the top of this function).
      appendLog("Đã hủy thêm bài: MP3 không tải được.");
      const mapped = mapMp3ErrorToMessage(
        audioResult.httpStatus,
        audioResult.message
      );
      try {
        const removed = await rollbackAddSongAssets(videoId);
        if (removed.removed.length) {
          appendLog(
            "[AddSongRollback] đã xoá: " + removed.removed.join(", ")
          );
        }
        appendLog("Đã rollback cover/LRC/MP3 vì thêm bài thất bại.");
      } catch (rbErr) {
        appendLog(
          "Cảnh báo: rollback sau lỗi MP3 thất bại (" +
            (rbErr?.message || rbErr) +
            ")."
        );
      }
      fail(mapped.userMessage, new Error(mapped.technicalReason));
      return;
    }

    setBusyStep(STEPS.AUDIO_PROMPT, STEP_MESSAGES[STEPS.AUDIO_PROMPT]);
    appendLog("MP3 đã sẵn sàng — đang commit bài hát.");

    try {
      await persistSong({
        videoId,
        sourceUrl,
        title: titleRef.current || geminiMetaRef.current.title || "",
        artist: artistRef.current || geminiMetaRef.current.artist || "",
        genre: geminiMetaRef.current.genre || "",
        lrcText: lrcInfo.lrcText,
        lrcFileName: lrcInfo.fileName,
        lrcDownloadPath: lrcInfo.downloadPath,
        coverBlob,
        audioResult,
      });
    } catch (err) {
      // persistSong already rolled back its own partial writes; we just
      // need a user-facing message. The error from persistSong is
      // typically the IndexedDB write failure itself.
      fail(
        "Không lưu được bài hát: " + (err?.message || err) +
          ". Đã xoá dữ liệu tạm.",
        err
      );
    }
  }

  /**
   * Runs LRC generation via the Gemini API (no browser tab opened).
   * Shares the same post-LRC flow as runGemini after the LRC text is ready:
   *   saveLrcAuto → tryAutoFillMeta → fetchAndSaveAudio → persistSong
   */
  async function runGeminiApi({ videoId }) {
    const sourceUrl = linkRef.current.trim();

    setBusyStep(STEPS.GEMINI_API, STEP_MESSAGES[STEPS.GEMINI_API]);
    appendLog("Khởi động Gemini API mode...");

    // Fetch the cover into memory. IndexedDB write is deferred to
    // persistSong (atomic commit with LRC + MP3).
    const coverBlob = await fetchCoverBlob(videoId);
    appendLog("Cover image đã xử lý xong.");

    // Reset correlationId so handleCancel can cancel this job too.
    if (!correlationIdRef.current) {
      correlationIdRef.current =
        "svdmusic-api-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    }

    appendLog("Đang gửi yêu cầu tới Gemini API (correlationId=" + correlationIdRef.current + ")...");

    let rawText = "";
    try {
      // Save API key FIRST (await), so background reads a fresh value.
      if (apiKey.trim()) {
        appendLog("Đang lưu API key vào storage...");
        const saveResp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: "svdmusic:set-gemini-api-key", key: apiKey.trim() },
            (resp) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || "sendMessage failed"));
              } else {
                resolve(resp);
              }
            }
          );
        });
        appendLog(
          "✓ Đã lưu API key: ok=" +
            (saveResp && saveResp.ok ? "true" : "false")
        );
      }

      const result = await new Promise((resolve, reject) => {
        const TIMEOUT_MS = 5 * 60 * 1000;
        const timer = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          appendLog("✗ Timeout sau 5 phút chờ Gemini API.");
          reject(new Error("Timeout chờ phản hồi Gemini API (5 phút)."));
        }, TIMEOUT_MS);

        function listener(message) {
          if (!message || typeof message !== "object") return;
          if (message.correlationId !== correlationIdRef.current) return;
          appendLog("  → Nhận message từ background: " + message.type);
          if (message.type === "gemini-api/result") {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            appendLog("✓ Đã nhận phản hồi từ background (" + (message.lrcText?.length || 0) + " ký tự).");
            resolve(message);
          }
          if (message.type === "gemini-api/error") {
            const errText =
              (typeof message.error === "string" && message.error) ||
              (typeof message.message === "string" && message.message) ||
              (message.payload && (message.payload.error || message.payload.message)) ||
              "Lỗi không xác định từ Gemini API.";
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            appendLog("✗ Background báo lỗi: " + errText);
            reject(new Error(errText));
          }
          // Build/runtime debug snapshot from background.
          if (message.type === "gemini-api/debug") {
            const fp = message.keyFingerprint || {};
            appendLog("[API DEBUG] buildId=" + (message.buildId || "?"));
            appendLog(
              "[API DEBUG] modelChain=" +
                (Array.isArray(message.modelChain) ? message.modelChain.join(", ") : "?")
            );
            appendLog(
              "[API DEBUG] key length=" + (fp.length ?? "?") +
                " first4=" + (fp.first4 || "?") +
                " last4=" + (fp.last4 || "?") +
                " hasMask=" + !!fp.hasMask +
                " hasBearerPrefix=" + !!fp.hasBearerPrefix
            );
          }
          // Progress events — surface in the modal log so the user sees
          // exactly what step the API call is at, instead of "stuck".
          if (message.type === "gemini-api/calling-model") {
            appendLog("→ Đang gọi model: " + (message.model || "?"));
          }
          if (message.type === "gemini-api/http-status") {
            appendLog("← HTTP " + message.status + " từ " + (message.model || "?"));
          }
          if (message.type === "gemini-api/parse") {
            appendLog("→ Đang parse JSON response...");
            appendLog("→ Đang trích xuất LRC từ phản hồi API...");
          }
          if (message.type === "gemini-api/model-fallback") {
            appendLog(
              "↪ Model " + (message.from || "?") + " không khả dụng ("
                + (message.reason || "?")
                + (message.status ? ", HTTP " + message.status : "")
                + "), thử model tiếp theo..."
            );
          }
          if (message.type === "gemini-api/done") {
            appendLog("✓ Background đã hoàn tất, length=" + (message.length || 0));
            // If the done event carries the lrcText, resolve immediately.
            // Otherwise, fall through and wait for sendResponse.
            if (typeof message.lrcText === "string" && message.lrcText.length > 0) {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              appendLog(
                "✓ Đã nhận phản hồi từ background qua event, lrcText length=" +
                  message.lrcText.length + " ký tự."
              );
              resolve({ ok: true, lrcText: message.lrcText });
            }
          }
        }

        chrome.runtime.onMessage.addListener(listener);
        appendLog("Đã đăng ký listener, chờ phản hồi từ background...");

        // Trigger background to call the API.
        appendLog("Đang gọi background: gemini-api/generate-lrc (videoId=" + videoId + ")");
        chrome.runtime.sendMessage(
          {
            type: "gemini-api/generate-lrc",
            correlationId: correlationIdRef.current,
            videoId,
            youtubeUrl: sourceUrl,
          },
          (ack) => {
            if (chrome.runtime.lastError) {
              // Connection error — report immediately.
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              appendLog("✗ sendMessage tới background thất bại: " + (chrome.runtime.lastError?.message || ""));
              reject(new Error(chrome.runtime.lastError.message || "sendMessage failed"));
              return;
            }
            // sendResponse also carries the lrcText; resolve here as a
            // fallback in case the gemini-api/done event arrived before
            // the listener was fully wired, or vice versa.
            const ackLrc = ack && (ack.lrcText || ack.text);
            if (ack && ack.ok && typeof ackLrc === "string" && ackLrc.length > 0) {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              appendLog(
                "✓ Đã nhận phản hồi từ background, lrcText length=" +
                  ackLrc.length + " ký tự."
              );
              resolve({ ok: true, lrcText: ackLrc });
            }
          }
        );
      });

      rawText = result?.lrcText || "";
      appendLog("Response length từ API: " + rawText.length + " ký tự.");
      if (rawText) {
        appendLog(
          "Preview response: " +
            JSON.stringify(rawText.slice(0, 200))
        );
        appendLog("Đang trích xuất LRC từ Gemini API response...");
      }
} catch (error) {
    appendLog("Lỗi gọi Gemini API: " + (error.message || String(error)));
    fail(error.message || "Lỗi gọi Gemini API.", error);
    return;
  }

  if (!rawText) {
      fail(
        "Gemini API đã trả phản hồi nhưng không có nội dung LRC. Bài hát chưa được thêm.",
        null
      );
      return;
    }

    appendLog("Đã nhận phản hồi từ Gemini API (" + rawText.length + " ký tự).");

    // Reject Gemini responses that contain refusal / hallucination phrases
    // BEFORE we extract or save anything. Even if the response has LRC-like
    // timestamps, a refusal means the model did not access the YouTube link
    // and would hallucinate lyrics — we must not persist those.
    const refusal = detectRefusalOrHallucination(rawText);
    if (refusal.isRefusal) {
      appendLog("✗ Phát hiện câu từ chối của AI: \"" + refusal.matched + "\"");
      appendLog("Gemini API không truy cập được YouTube link, đã hủy để tránh lưu LRC bịa.");
      appendLog("Hãy đổi sang Gemini Web UI mode hoặc cung cấp transcript/lyrics thật.");
      setRefusalDetected(true);
      fail(
        "Gemini API từ chối truy cập YouTube link và không tạo được LRC thật. " +
          "Đã hủy để tránh lưu LRC bịa. Hãy chuyển sang Gemini Web UI hoặc cung cấp lyrics thật.",
        null
      );
      return;
    }

    // Run extractSongMetadata so we can log parsed fields early.
    try {
      const meta = typeof extractSongMetadata === "function" ? extractSongMetadata(rawText) : null;
      appendLog(
        "extractSongMetadata: title=" + (meta?.title ? JSON.stringify(meta.title) : "<empty>") +
          ", artists=" + (meta?.artists ? JSON.stringify(meta.artists) : "<empty>") +
          ", genre=" + (meta?.genre ? JSON.stringify(meta.genre) : "<empty>")
      );
    } catch (parseErr) {
      appendLog("extractSongMetadata lỗi: " + (parseErr?.message || parseErr));
    }

    // Run extractLrcFromGeminiOutput and log parsed.ok / reason.
    let parsedLrc = null;
    try {
      const parsed = typeof extractLrcFromGeminiOutput === "function" ? extractLrcFromGeminiOutput(rawText) : null;
      parsedLrc = parsed || null;
      if (parsed && parsed.ok === false) {
        appendLog("extractLrcFromGeminiOutput: parsed.ok=false, reason=" + (parsed.reason || "<no-reason>"));
      } else if (parsed) {
        appendLog(
          "extractLrcFromGeminiOutput: parsed.ok=true, timestamps=" +
            (parsed.timestamps?.length ?? parsed.lines?.length ?? 0)
        );
      } else {
        appendLog("extractLrcFromGeminiOutput: parser không tồn tại hoặc trả null.");
      }
    } catch (parseErr) {
      appendLog("extractLrcFromGeminiOutput lỗi: " + (parseErr?.message || parseErr));
    }

    // Hard validation gate: parsed.ok must be true, line count must be >= 10,
    // and the extracted lyric text must NOT contain any refusal phrase.
    // Title / artist mismatch with the YouTube title (when available) is also
    // a strong hallucination signal.
    {
      const lineCount = parsedLrc?.timestamps?.length
        ?? parsedLrc?.lines?.length
        ?? 0;
      const refusalCheck = detectRefusalOrHallucination(rawText);
      const ytTitle = (titleRef.current || geminiMetaRef.current.title || "").trim();
      let titleMismatch = false;
      if (ytTitle) {
        const meta = (() => {
          try {
            return typeof extractSongMetadata === "function"
              ? extractSongMetadata(rawText)
              : null;
          } catch (_) {
            return null;
          }
        })();
        const apiTitle = (meta?.title || "").trim().toLowerCase();
        if (apiTitle) {
          const ytLower = ytTitle.toLowerCase();
          // Soft match: at least 40% of characters in apiTitle appear in ytLower,
          // or one title is a substring of the other.
          const longer = Math.max(apiTitle.length, ytLower.length, 1);
          const minLen = Math.min(apiTitle.length, ytLower.length);
          const substringHit =
            minLen >= 4 && (ytLower.includes(apiTitle) || apiTitle.includes(ytLower));
          let charHits = 0;
          for (const ch of apiTitle) if (ytLower.includes(ch)) charHits++;
          const charRatio = charHits / longer;
          if (!substringHit && charRatio < 0.4) {
            titleMismatch = true;
          }
        }
      }

      const reasons = [];
      if (!parsedLrc || parsedLrc.ok !== true) reasons.push("parsed.ok != true");
      if (lineCount < 10) reasons.push("line count < 10 (" + lineCount + ")");
      if (refusalCheck.isRefusal) reasons.push("refusal phrase: " + refusalCheck.matched);
      if (titleMismatch) reasons.push("title mismatch vs YouTube title");

      if (reasons.length > 0) {
        appendLog("✗ Validation fail: " + reasons.join("; "));
        // If the rejection was caused by a refusal phrase, surface the
        // "Chạy lại bằng Gemini Web UI" shortcut.
        if (refusalCheck.isRefusal) setRefusalDetected(true);
        const err = new Error("Gemini API trả LRC không hợp lệ hoặc bịa nội dung.");
        fail(err.message, err);
        return;
      }
    }

    // Parse LRC in memory only. We wait for the MP3 result before writing
    // anything to IndexedDB so the atomic-flow contract holds.
    const lrcInfo = prepareLrcInfo(videoId, rawText);
    if (!lrcInfo) {
      fail(
        "Không trích xuất được LRC hợp lệ từ phản hồi API. Bài hát chưa được thêm.",
        null
      );
      return;
    }

    tryAutoFillMeta(rawText);

    // MP3 pipeline. Atomic: any failure here triggers rollback and the
    // song is NOT persisted.
    const audioResult = await fetchAndValidateAudio(videoId, sourceUrl);

    if (!audioResult.ok) {
      appendLog("Đã hủy thêm bài: MP3 không tải được.");
      const mapped = mapMp3ErrorToMessage(
        audioResult.httpStatus,
        audioResult.message
      );
      try {
        const removed = await rollbackAddSongAssets(videoId);
        if (removed.removed.length) {
          appendLog(
            "[AddSongRollback] đã xoá: " + removed.removed.join(", ")
          );
        }
        appendLog("Đã rollback cover/LRC/MP3 vì thêm bài thất bại.");
      } catch (rbErr) {
        appendLog(
          "Cảnh báo: rollback sau lỗi MP3 thất bại (" +
            (rbErr?.message || rbErr) +
            ")."
        );
      }
      fail(mapped.userMessage, new Error(mapped.technicalReason));
      return;
    }

    setBusyStep(STEPS.AUDIO_PROMPT, STEP_MESSAGES[STEPS.AUDIO_PROMPT]);
    appendLog("MP3 đã sẵn sàng — đang commit bài hát.");

    try {
      await persistSong({
        videoId,
        sourceUrl,
        title: titleRef.current || geminiMetaRef.current.title || "",
        artist: artistRef.current || geminiMetaRef.current.artist || "",
        genre: geminiMetaRef.current.genre || "",
        lrcText: lrcInfo.lrcText,
        lrcFileName: lrcInfo.fileName,
        lrcDownloadPath: lrcInfo.downloadPath,
        coverBlob,
        audioResult,
      });
    } catch (err) {
      fail(
        "Không lưu được bài hát: " + (err?.message || err) +
          ". Đã xoá dữ liệu tạm.",
        err
      );
    }
  }

  async function handleCreate() {
    if (abortRef.current) return;
    const value = link.trim();
    if (!value) {
      fail("Vui lòng nhập liên kết YouTube.");
      return;
    }
    const share = parseYoutubeShareUrl(value);
    if (!share.ok) {
      fail(share.error);
      return;
    }
    const videoId = share.videoId;
    abortRef.current = false;
    setErrorMessage("");
    setProgressLog([]);
    setNeedLogin(false);
    setHasStarted(true);
    setRefusalDetected(false);

    setBusyStep(STEPS.VALIDATE, STEP_MESSAGES[STEPS.VALIDATE]);

    // Auto-reset any stale Gemini lock before starting a new job. This
    // prevents the "Phiên Gemini cũ vẫn đang được giữ" banner from ever
    // showing up to the user — we silently clear it and carry on.
    try {
      const inspectBefore = await inspectLrcLock();
      if (inspectBefore && inspectBefore.jobId) {
        appendLog("Phát hiện lock cũ (jobId=" + inspectBefore.jobId + "), tự động hủy...");
        const resetResult = await forceResetLrcLock();
        appendLog(resetResult?.cleared
          ? "Đã hủy lock cũ."
          : "Không tìm thấy lock nào (có thể đã tự hết hạn).");
        // Re-inspect to confirm the lock is cleared.
        const inspectAfter = await inspectLrcLock();
        if (inspectAfter && inspectAfter.jobId) {
          // Lock still there — surface the banner as a last resort.
          setLockedByJobId(inspectAfter.jobId);
          setErrorMessage("Lock vẫn chưa hủy được. Đóng hết tab gemini.google.com rồi bấm 'Hủy lock cũ'.");
          setStep(STEPS.IDLE);
          setHasStarted(false);
          return;
        }
      }
    } catch (_) { /* best-effort: proceed anyway */ }

    // Route to the selected LRC provider.
    if (lrcProvider === "gemini-api") {
      // Save provider preference for next session.
      chrome.runtime.sendMessage(
        { type: "svdmusic:set-lrc-provider", provider: "gemini-api" },
        () => {}
      );
      await runGeminiApi({ videoId });
    } else {
      // Save provider preference.
      chrome.runtime.sendMessage(
        { type: "svdmusic:set-lrc-provider", provider: "gemini-ui" },
        () => {}
      );
      await runGemini({ videoId });
    }
  }

  async function handleResumeAfterLogin() {
    if (!correlationIdRef.current || !jobIdRef.current) {
      fail("Không có phiên Gemini nào đang chờ.");
      return;
    }
    setNeedLogin(false);
    setBusyStep(STEPS.GEMINI_PROMPT, STEP_MESSAGES[STEPS.GEMINI_PROMPT]);
    try {
      const { result } = await continueAfterLogin(
        { correlationId: correlationIdRef.current, jobId: jobIdRef.current },
        (payload) => {
          if (payload?.needLogin) {
            setNeedLogin(true);
            setBusyStep(STEPS.GEMINI_RESUME, STEP_MESSAGES[STEPS.GEMINI_RESUME]);
          }
          if (payload?.message) appendLog(payload.message);
        }
      );
      const lrcRaw = result?.lrcText || "";
      const videoId = extractVideoId(linkRef.current.trim());
      const sourceUrl = linkRef.current.trim();

      if (!lrcRaw) {
        fail(
          "Gemini đã hoàn tất phản hồi nhưng không có nội dung LRC. " +
            "Bài hát chưa được thêm vào danh sách để tránh lưu sai.",
          null
        );
        return;
      }

      appendLog("Đã nhận file attachment từ Gemini.");
      const lrcInfo = prepareLrcInfo(videoId, lrcRaw);
      if (!lrcInfo) {
        fail(
          "Không trích xuất được LRC hợp lệ từ phản hồi của Gemini. " +
            "Bài hát chưa được thêm vào danh sách để tránh lưu sai.",
          null
        );
        return;
      }

      tryAutoFillMeta(lrcRaw);

      // Atomic MP3 step. Failure here triggers rollback and never persists
      // a half-written song.
      const audioResult = await fetchAndValidateAudio(videoId, sourceUrl);

      if (!audioResult.ok) {
        appendLog("Đã hủy thêm bài: MP3 không tải được.");
        const mapped = mapMp3ErrorToMessage(
          audioResult.httpStatus,
          audioResult.message
        );
        try {
          const removed = await rollbackAddSongAssets(videoId);
          if (removed.removed.length) {
            appendLog(
              "[AddSongRollback] đã xoá: " + removed.removed.join(", ")
            );
          }
          appendLog("Đã rollback cover/LRC/MP3 vì thêm bài thất bại.");
        } catch (rbErr) {
          appendLog(
            "Cảnh báo: rollback sau lỗi MP3 thất bại (" +
              (rbErr?.message || rbErr) +
              ")."
          );
        }
        fail(mapped.userMessage, new Error(mapped.technicalReason));
        return;
      }

      setBusyStep(STEPS.AUDIO_PROMPT, STEP_MESSAGES[STEPS.AUDIO_PROMPT]);
      appendLog("MP3 đã sẵn sàng — đang commit bài hát.");

      // Cover wasn't refetched on resume (it was already shown to the
      // user during the first part of the run). The modal doesn't keep a
      // reference to the cover blob across the resume hop, so we re-fetch
      // it here. If the thumbnail can't be re-fetched (network glitch,
      // YT now returns 404, ...) we still commit the song — the runtime
      // will fall back to the YouTube placeholder.
      let coverBlob = null;
      try {
        const thumbs = getThumbnailUrls(videoId);
        coverBlob = await fetchFirstThumbnailBlob(thumbs);
      } catch (_) { /* best-effort */ }

      try {
        await persistSong({
          videoId,
          sourceUrl,
          title: titleRef.current || geminiMetaRef.current.title || "",
          artist: artistRef.current || geminiMetaRef.current.artist || "",
          genre: geminiMetaRef.current.genre || "",
          lrcText: lrcInfo.lrcText,
          lrcFileName: lrcInfo.fileName,
          lrcDownloadPath: lrcInfo.downloadPath,
          coverBlob,
          audioResult,
        });
      } catch (err) {
        fail(
          "Không lưu được bài hát: " + (err?.message || err) +
            ". Đã xoá dữ liệu tạm.",
          err
        );
      }
    } catch (error) {
      fail(error.message || "Không thể tiếp tục Gemini.", error);
    }
  }

  async function handleCancel() {
    if (abortRef.current) {
      onClose?.();
      return;
    }
    abortRef.current = true;
    if (correlationIdRef.current || jobIdRef.current) {
      try {
        await cancelLrcGeneration({
          correlationId: correlationIdRef.current,
          jobId: jobIdRef.current,
        });
      } catch (error) {
        log("cancelLrcGeneration failed", error);
      }
      correlationIdRef.current = null;
      jobIdRef.current = null;
    }
    setStep(STEPS.CANCELLED);
    appendLog("Đã hủy thao tác.");
  }

  function handleClose() {
    if (correlationIdRef.current || jobIdRef.current) {
      cancelLrcGeneration({
        correlationId: correlationIdRef.current,
        jobId: jobIdRef.current,
      }).catch(() => null);
      correlationIdRef.current = null;
      jobIdRef.current = null;
    }
    onClose?.();
  }

  function handleBackdropClick(event) {
    if (event.target !== event.currentTarget) return;
    if (
      step === STEPS.DONE ||
      step === STEPS.ERROR ||
      step === STEPS.CANCELLED ||
      !hasStarted
    ) {
      handleClose();
    } else {
      handleCancel();
    }
  }

  const inProgress = [
    STEPS.VALIDATE,
    STEPS.COVER,
    STEPS.GEMINI_OPEN,
    STEPS.GEMINI_PROMPT,
    STEPS.GEMINI_WAIT,
    STEPS.GEMINI_RESUME,
    STEPS.GEMINI_API,
    STEPS.LRC_SAVE,
    STEPS.ASSET_SAVE,
    STEPS.AUDIO_FETCH,
    STEPS.AUDIO_SAVE,
    STEPS.AUDIO_PROMPT,
    STEPS.PERSIST,
  ].includes(step);

  // Live validation: enable the "Tạo bài hát" button only when the input
  // is parseable. We check YouTube validity AND (for Gemini API mode) that
  // the user has provided an API key. Without this, the user can click
  // the button, hit `fail("...")`, and then can't figure out why the
  // button is greyed out / modal won't progress.
  const trimmedLink = link.trim();
  const share = trimmedLink.length > 0 ? parseYoutubeShareUrl(trimmedLink) : { ok: false };
  const linkIsValid = trimmedLink.length > 0 ? isValidYouTubeUrl(trimmedLink) : false;
  const canCreate = share.ok;
  const apiKeyMissing = lrcProvider === "gemini-api" && apiKey.trim().length === 0;

  const currentStatus =
    step === STEPS.ERROR
      ? errorMessage
      : step === STEPS.CANCELLED
        ? STEP_MESSAGES[STEPS.CANCELLED]
        : step === STEPS.DONE
          ? STEP_MESSAGES[STEPS.DONE]
          : STEP_MESSAGES[step] || "Sẵn sàng";

  return (
    <div
      className="modalOverlay"
      onMouseDown={handleBackdropClick}
      role="presentation"
    >
      <div
        className="modalCard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-song-title"
      >
        <header className="modalHeader">
          <h2 id="add-song-title">Thêm bài hát từ YouTube</h2>
          <button
            type="button"
            className="modalClose"
            onClick={handleClose}
            aria-label="Đóng"
          >
            <X size={16} />
          </button>
        </header>

        <div className="modalBody">
          <label className="modalField">
            <span>Liên kết YouTube</span>
            <input
              type="url"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={inProgress && !needLogin}
              autoFocus
            />
            {trimmedLink.length > 0 && !linkIsValid ? (
              <span className="modalFieldHint" style={{ color: "#f87171", fontSize: "11px", marginTop: "4px" }}>
                Liên kết YouTube không hợp lệ. Ví dụ: https://www.youtube.com/watch?v=...
              </span>
            ) : null}
          </label>

          {false ? (
            <div className="modalField">
              <span>Nguồn tạo LRC</span>
              <div className="modalFieldRow" style={{ marginTop: "4px" }}>
                <button
                  type="button"
                  className={"modalButton " + (lrcProvider === "gemini-ui" ? "primary" : "ghost")}
                  style={{ flex: 1, fontSize: "12px" }}
                  onClick={() => {
                    setLrcProvider("gemini-ui");
                    chrome.runtime.sendMessage(
                      { type: "svdmusic:set-lrc-provider", provider: "gemini-ui" },
                      () => {}
                    );
                  }}
                  disabled={inProgress && !needLogin}
                >
                  Gemini Web UI
                </button>
                <button
                  type="button"
                  className={"modalButton " + (lrcProvider === "gemini-api" ? "primary" : "ghost")}
                  style={{ flex: 1, fontSize: "12px" }}
                  onClick={() => {
                    setLrcProvider("gemini-api");
                    chrome.runtime.sendMessage(
                      { type: "svdmusic:set-lrc-provider", provider: "gemini-api" },
                      () => {}
                    );
                  }}
                  disabled={inProgress && !needLogin}
                >
                  Gemini API
                </button>
              </div>
            </div>
          ) : null}

          {false ? (
            <div className="modalField">
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                <span style={{ fontSize: "13px", color: "var(--text-secondary, #aaa)" }}>
                  API Key (ShopAIKey)
                </span>
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (event.target.value.trim()) {
                    chrome.runtime.sendMessage(
                      { type: "svdmusic:set-gemini-api-key", key: event.target.value.trim() },
                      () => {}
                    );
                  }
                }}
                placeholder="Nhập API key để sử dụng Gemini API"
                disabled={inProgress && !needLogin}
                style={{ fontSize: "12px" }}
              />
              {apiKeyMissing ? (
                <span className="modalFieldHint" style={{ color: "#f87171", fontSize: "11px", marginTop: "4px" }}>
                  Vui lòng nhập API key ShopAIKey, hoặc chuyển sang "Gemini Web UI".
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="modalFieldRow">
            <label className="modalField">
              <span>Tiêu đề (tùy chọn)</span>
              <input
                type="text"
                value={title}
                onChange={(event) => {
                  userTouchedMetaRef.current = true;
                  setTitle(event.target.value);
                }}
                placeholder="Mặc định dùng videoId"
                disabled={inProgress && !needLogin}
              />
            </label>
            <label className="modalField">
              <span>Nghệ sĩ (tùy chọn)</span>
              <input
                type="text"
                value={artist}
                onChange={(event) => {
                  userTouchedMetaRef.current = true;
                  setArtist(event.target.value);
                }}
                placeholder="Không rõ"
                disabled={inProgress && !needLogin}
              />
            </label>
          </div>

          <div
            className={"modalStatus " + (step === STEPS.ERROR ? "isError" : "")}
          >
            {inProgress ? (
              <Loader2 className="modalSpinner" size={14} />
            ) : null}
            <span>{currentStatus}</span>
          </div>

          {step === STEPS.ERROR && refusalDetected ? (
            <button
              type="button"
              className="modalButton primary"
              style={{ marginTop: "4px" }}
              onClick={() => {
                // Switch provider to Gemini Web UI and re-run create().
                setLrcProvider("gemini-ui");
                chrome.runtime.sendMessage(
                  { type: "svdmusic:set-lrc-provider", provider: "gemini-ui" },
                  () => {}
                );
                setRefusalDetected(false);
                setErrorMessage("");
                setProgressLog([]);
                setStep(STEPS.IDLE);
                // Re-enter handleCreate on next tick so state updates settle.
                setTimeout(() => handleCreate(), 50);
              }}
              disabled={inProgress && !needLogin}
            >
              Chạy lại bằng Gemini Web UI
            </button>
          ) : null}

          {lockedByJobId ? (
            <div className="modalLockBanner" role="alert">
              <div className="modalLockBannerText">
                <strong>Phiên Gemini cũ vẫn đang được giữ.</strong>
                <p>{errorMessage}</p>
                <p className="modalLockHint">
                  Đóng hết tab gemini.google.com rồi bấm nút bên dưới để hủy lock.
                </p>
              </div>
              <button
                type="button"
                className="modalButton primary"
                onClick={handleForceResetLock}
                disabled={isResettingLock}
                data-add-song-reset-lock
              >
                {isResettingLock ? "Đang hủy lock..." : "Hủy lock cũ"}
              </button>
            </div>
          ) : null}

          {progressLog.length ? (
            <pre className="modalLog" aria-live="polite">
              {progressLog.join("\n")}
            </pre>
          ) : null}
        </div>

        <footer className="modalFooter">
          {needLogin ? (
            <button
              type="button"
              className="modalButton primary"
              onClick={handleResumeAfterLogin}
            >
              Tiếp tục
            </button>
          ) : null}

          {step === STEPS.DONE ? (
            <button
              type="button"
              className="modalButton primary"
              onClick={handleClose}
            >
              Đóng
            </button>
          ) : null}

          {!needLogin && step !== STEPS.DONE ? (
            <>
              <button
                type="button"
                className="modalButton ghost"
                onClick={hasStarted ? handleCancel : handleClose}
                disabled={false}
                data-add-song-cancel={hasStarted ? true : undefined}
              >
                {hasStarted ? "Hủy" : "Đóng"}
              </button>
              <button
                type="button"
                className="modalButton primary"
                onClick={handleCreate}
                disabled={inProgress || !canCreate}
                title={
                  !linkIsValid
                    ? "Vui lòng nhập liên kết YouTube hợp lệ."
                    : apiKeyMissing
                      ? "Vui lòng nhập API key cho Gemini API."
                      : ""
                }
              >
                {inProgress ? "Đang xử lý..." : "Tạo bài hát"}
              </button>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export { STEPS as ADD_SONG_STEPS };

// Local helper: avoids circular import from geminiLrc by re-implementing the
// YouTube thumbnail URL builder here. Kept tiny and pure.
function getThumbnailUrls(videoId) {
  if (!videoId) return [];
  return [
    "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg",
    "https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg",
    "https://i.ytimg.com/vi/" + videoId + "/sddefault.jpg",
  ];
}

// Fetches the first reachable YouTube thumbnail as a Blob. Returns null when
// every variant 404s / errors out. We verify via HEAD first to skip the
// 120x90 placeholder that hqdefault returns for missing videos.
async function fetchFirstThumbnailBlob(thumbUrls) {
  if (!Array.isArray(thumbUrls) || thumbUrls.length === 0) return null;
  let lastError = null;
  for (const url of thumbUrls) {
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) {
        lastError = new Error(`Thumbnail ${url} responded ${head.status}`);
        continue;
      }
      const response = await fetch(url);
      if (!response.ok) {
        lastError = new Error(`Thumbnail ${url} responded ${response.status}`);
        continue;
      }
      const blob = await response.blob();
      if (blob && blob.size > 0) return blob;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) console.warn("[AddSong] fetchFirstThumbnailBlob failed", lastError);
  return null;
}