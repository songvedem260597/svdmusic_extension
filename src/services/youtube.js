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
  // Verbatim prompt template — do NOT add or remove any clauses. The parser
  // on the app side handles whatever Gemini returns (.txt, Python wrapper,
  // markdown, garbage, raw LRC, etc.).
  //
  // The "Kết quả trả về là: Tên bài hát:..., Tên các ca sỹ:..., Thể loại nhạc:..."
  // clause tells Gemini to put the song title, artist names, and a single
  // canonical genre label in plain text alongside the .lrc file. The
  // extension extracts them from the response (via preamble lines and/or
  // LRC ID3 tags [ti: ...] / [ar: ...]) so the user does not have to type
  // them. The genre must be chosen from the fixed Vietnamese list below —
  // the parser rejects anything outside it and falls back to "Nhạc Trẻ".
  //
  // IMPORTANT: pass the ORIGINAL youtubeLink through untouched. Do NOT
  // append `&list=RD<id>&start_radio=1` — that `list=RD` flag is YouTube's
  // "Mix — Radio" convention and biases Gemini toward a radio/mix playlist,
  // which makes it pick the wrong song for the LRC. Metadata recovery is
  // handled on our side via parsing [ti:], [ar:], [genre:] (or preamble),
  // and the genre whitelist.
  const genreList = ALLOWED_GENRES.join(", ");
  return (
    `Hãy tạo file .lrc từ Link:${youtubeLink}. Hãy đối chiếu đúng lời lyrics thực tế của các bài hát trong video. ` +
    `Sửa lrc cho đúng do phụ đề có thể sẽ không đúng so với thực tế. ` +
    `Kết quả trả về là: Tên bài hát:... , Tên các ca sỹ:.. , Thể loại nhạc:... (phải thuộc danh sách: ${genreList}) ` +
    `và file đuôi .lrc chỉ cần bấm vào là có thể tải xuống. Không mô tả gì thêm.`
  );
}

// Detects LRC-style content inside a string.
const LRC_TIME_REGEX = /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/;
export function looksLikeLrc(text) {
  if (!text) return false;
  return LRC_TIME_REGEX.test(text);
}