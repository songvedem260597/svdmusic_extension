// Helpers for parsing YouTube URLs and building Gemini prompt.

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_SHARE_URL_REGEX =
  /^https:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})(?:\?si=[a-zA-Z0-9_-]+)?$/;

/**
 * Strict YouTube share-link validator.
 *
 * Only accepts the exact format produced by YouTube's Share button:
 *   https://youtu.be/VIDEO_ID
 *   https://youtu.be/VIDEO_ID?si=SHARE_ID
 *
 * Returns { ok, videoId, normalizedUrl, shareUrl, error }.
 * normalizedUrl is the canonical watch URL used for API calls.
 */
export function parseYoutubeShareUrl(input) {
  const value = String(input || "").trim();
  if (!value) {
    return { ok: false, videoId: "", normalizedUrl: "", shareUrl: "", error: "Link YouTube trống." };
  }
  const match = value.match(YOUTUBE_SHARE_URL_REGEX);
  if (!match) {
    return {
      ok: false,
      videoId: "",
      normalizedUrl: "",
      shareUrl: value,
      error:
        "Link YouTube không hợp lệ. Vui lòng bấm nút Share trên YouTube và dán link dạng https://youtu.be/VIDEO_ID?si=...",
    };
  }
  return {
    ok: true,
    videoId: match[1],
    normalizedUrl: `https://www.youtube.com/watch?v=${match[1]}`,
    shareUrl: value,
    error: "",
  };
}

export function extractVideoId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  if (VIDEO_ID_REGEX.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" && host !== "youtu.be") {
    return null;
  }

  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0];
    return VIDEO_ID_REGEX.test(id) ? id : null;
  }

  const v = url.searchParams.get("v");
  if (v && VIDEO_ID_REGEX.test(v)) return v;

  const pathSegments = url.pathname.split("/").filter(Boolean);
  const candidate = pathSegments[pathSegments.length - 1];
  if (candidate && VIDEO_ID_REGEX.test(candidate)) return candidate;

  return null;
}

export function isValidYouTubeUrl(input) {
  return parseYoutubeShareUrl(input).ok;
}

// Returns ordered list of thumbnail URLs from highest to lowest quality.
export function getThumbnailUrls(videoId) {
  if (!VIDEO_ID_REGEX.test(videoId)) return [];
  return [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/default.jpg`,
  ];
}

export function getBestThumbnailUrl(videoId) {
  const list = getThumbnailUrls(videoId);
  return list[0] || null;
}

// A track at or above this length is treated as "lyrics optional": DJ sets,
// mixes, live recordings and lo-fi streams either have no lyrics at all or are
// long enough that asking Gemini for a timed transcript is a waste of minutes.
export const LYRICS_OPTIONAL_MIN_SECONDS = 600; // 10 minutes

/**
 * Best-effort video length lookup, in seconds, BEFORE the MP3 pipeline runs.
 *
 * The MP3 provider reports a duration too, but only after the whole download
 * completes — far too late to decide whether the Gemini step is worth running.
 * The watch page embeds the length in its player config, so one cheap GET
 * answers the question up front. `https://*.youtube.com/*` is already in
 * host_permissions, so no manifest change is needed.
 *
 * Returns null when the lookup fails for any reason; callers must treat that as
 * "unknown", never as "short".
 */
export async function fetchVideoDurationSeconds(videoId, { signal } = {}) {
  if (!VIDEO_ID_REGEX.test(videoId || "")) return null;
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: "omit",
      signal,
    });
    if (!response.ok) return null;
    const html = await response.text();
    // Present in the ytInitialPlayerResponse blob as "lengthSeconds":"213".
    const match = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (_) {
    return null;
  }
}

export function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "không rõ";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Detects if the URL contains a playlist/queue context. Used for logging only.
export function describeUrlContext(input) {
  if (!input) return null;
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    return {
      host: url.hostname,
      hasList: url.searchParams.has("list"),
      hasRadio: url.searchParams.has("start_radio"),
      hasStart: url.searchParams.has("t"),
    };
  } catch {
    return null;
  }
}

export function safeFilename(name, fallback = "song") {
  const base = (name || fallback).toString().trim() || fallback;
  return base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^A-Za-z0-9_\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

// Canonical list of genres Gemini is allowed to return in the "Thể loại nhạc:"
// line of its LRC response. Kept in Vietnamese exactly as the user provided so
// the prompt validator (see extractSongMetadata in lrcParser.ts) can match the
// model's answer verbatim. The last entry is the safe default we fall back to
// when the model returns nothing, garbage, or a value not in this list.
export const ALLOWED_GENRES = Object.freeze([
  "Remix",
  "Pop",
  "Rock",
  "Hip-hop & Rap",
  "R&B & Soul",
  "Dance & Electronic",
  "Nhạc Đồng quê",
  "Nhạc Cổ điển",
  "K-Pop",
  "Nhạc Mỹ Latinh",
  "Indie & Alternative",
  "Jazz",
  "Blues",
  "Metal",
  "Nhạc Trẻ",
  "Nhạc Trữ tình & Bolero",
  "Nhạc Không lời",
  "Nhạc Thiếu nhi",
  "Reggae",
  "Folk & Acoustic",
]);
export const DEFAULT_GENRE = "Nhạc Trẻ";

export function buildLrcPrompt(youtubeLink, _videoId) {
  // IMPORTANT: pass the ORIGINAL youtubeLink through untouched. Do NOT
  // append `&list=RD<id>&start_radio=1` — that `list=RD` flag is YouTube's
  // "Mix — Radio" convention and biases Gemini toward a radio/mix playlist,
  // which makes it pick the wrong song for the LRC.
  const genreList = ALLOWED_GENRES.join(", ");
  return [
    `Hãy trích xuất nội dung LRC từ Link: ${youtubeLink}. Hãy đối chiếu đúng lời lyrics thực tế nghe được trong video với lời bài hát thực tế và chỉnh sửa lại thời gian/lời cho chuẩn xác do phụ đề tự động có thể bị sai.`,
    "Yêu cầu xuất kết quả trực tiếp dưới dạng văn bản thô (raw text) trong khung code block, KHÔNG tạo file tải về hay liên kết tải xuống.",
    "Cấu trúc kết quả trả về bắt buộc:",
    "Tên bài hát: ...",
    "Tên các ca sỹ: ...",
    `Thể loại nhạc: ... (phải thuộc danh sách: ${genreList})`,
    "Nội dung LRC raw text đặt hoàn toàn trong khung ```text ... ``` với đầy đủ mốc thời gian [mm:ss.xx] và lời bài hát.",
    "Không mô tả hay giải thích gì thêm.",
  ].join("\n");
}

// Detects LRC-style content inside a string.
const LRC_TIME_REGEX = /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/;
export function looksLikeLrc(text) {
  if (!text) return false;
  return LRC_TIME_REGEX.test(text);
}
