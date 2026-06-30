// Parses LRC content from Gemini output, handling both raw LRC and Python
// wrapper formats.  Gemini sometimes returns a .txt file containing a Python script
// with `lrc_content = """..."""` instead of raw LRC text.

const LRC_TIMESTAMP = /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/;

const INVALID_LRC_STUBS = [
  "# SVDMusic stub",
  "Bạn cần đặt file MP3 thật vào",
  "public/uploads/mp3/",
  "reload extension",
  "#!/usr/bin/env python3",
  "lrc_content =",
];

/**
 * Parses LRC content from raw Gemini output text.
 *
 * @param {string} raw - The raw text returned by Gemini (may be a .txt Python script).
 * @returns {{ ok: boolean, lrcText?: string, reason?: string, sourceType?: "raw_lrc" | "python_wrapper" }}
 */
export function extractLrcFromGeminiOutput(raw) {
  const text = raw.trim();

  if (!text) {
    return { ok: false, reason: "EMPTY_INPUT" };
  }

  // Reject stub/invalid files.
  const hitStub = INVALID_LRC_STUBS.find((stub) => text.includes(stub));
  if (hitStub) {
    return { ok: false, reason: "INVALID_LRC_STUB_FILE", stub: hitStub };
  }

  // Case A: raw LRC (contains timestamps, no Python wrapper).
  if (LRC_TIMESTAMP.test(text) && !text.includes("lrc_content")) {
    return { ok: true, lrcText: text, sourceType: "raw_lrc" };
  }

  // Case B: Python wrapper with triple-double-quoted string.
  const tripleDouble = text.match(/lrc_content\s*=\s*"""([\s\S]*?)"""/);
  if (tripleDouble?.[1]) {
    const candidate = tripleDouble[1].trim();
    if (LRC_TIMESTAMP.test(candidate)) {
      return { ok: true, lrcText: candidate, sourceType: "python_wrapper" };
    }
  }

  // Case C: Python wrapper with triple-single-quoted string.
  const tripleSingle = text.match(/lrc_content\s*=\s*'''([\s\S]*?)'''/);
  if (tripleSingle?.[1]) {
    const candidate = tripleSingle[1].trim();
    if (LRC_TIMESTAMP.test(candidate)) {
      return { ok: true, lrcText: candidate, sourceType: "python_wrapper" };
    }
  }

  // Case D: Gemini sometimes returns plain LRC but wrapped in a markdown code block.
  // Strip code fences and try again.
  const withoutFences = text.replace(/```(?:lrc|txt|python)?\n?/gi, "").trim();
  if (withoutFences !== text && LRC_TIMESTAMP.test(withoutFences)) {
    return { ok: true, lrcText: withoutFences, sourceType: "raw_lrc" };
  }

  return { ok: false, reason: "NO_VALID_LRC_CONTENT" };
}

/**
 * Chooses the best LRC from multiple Gemini candidates, preferring the one
 * whose filename matches the current videoId.
 *
 * @param {Array<{name: string, text: string}>} candidates - Candidate files from Gemini.
 * @param {string} videoId - The target video ID.
 * @returns {{ ok: boolean, lrcText?: string, fileName?: string, reason?: string, sourceType?: string }}
 */
export function chooseBestLrcCandidate(candidates, videoId) {
  if (!candidates || candidates.length === 0) {
    return { ok: false, reason: "NO_CANDIDATES" };
  }

  // 1. Prefer candidate whose name contains the current videoId.
  const matched = candidates.find((c) =>
    c.name && c.name.toLowerCase().includes(videoId.toLowerCase())
  );
  if (matched) {
    const parsed = extractLrcFromGeminiOutput(matched.text);
    if (parsed.ok) {
      return { ...parsed, fileName: matched.name };
    }
  }

  // 2. Otherwise take the first candidate with valid LRC content.
  for (const candidate of candidates) {
    const parsed = extractLrcFromGeminiOutput(candidate.text);
    if (parsed.ok) {
      return { ...parsed, fileName: candidate.name };
    }
  }

  // 3. Return the first failure reason.
  const first = candidates[0];
  const parsed = extractLrcFromGeminiOutput(first?.text || "");
  return {
    ok: false,
    reason: parsed.reason || "NO_VALID_LRC_CONTENT",
    fileName: first?.name,
  };
}

// ── Song metadata extraction ───────────────────────────────────────────────
//
// Gemini is told (see buildLrcPrompt) to return the song title, artist
// names, and a single canonical genre in plain text alongside the .lrc
// attachment, e.g.
//
//   Tên bài hát: Hãy Yêu Nhau Đi
//   Tên các ca sỹ: Bùi Anh Tuấn, Phạm Quỳnh Anh
//   Thể loại nhạc: Nhạc Trữ tình & Bolero
//
// extractSongMetadata scans the raw response and returns whatever it can
// recover. Returns { title?, artists?, genre? } — fields are omitted
// (not "") when not found, so callers can decide how to fall back.
// `genre`, when present, is guaranteed to be one of ALLOWED_GENRES. If
// no valid genre is recovered we substitute DEFAULT_GENRE so callers
// always get a usable tag for the UI.
//
// Robustness:
//   * Accepts bold (**...**), surrounding quotes (' " “ ” « »), trailing
//     dots/commas/semicolons.
//   * Accepts English fallback labels ("Song:", "Title:", "Artist:", "Artists:",
//     "Singer:", "Genre:", "Category:").
//   * Splits artists on commas, semicolons, ampersands, " and ", " và ".
//   * Strips LRC ID3 tags like [ti: ...] / [ar: ...] / [genre: ...] as a
//     tertiary signal — these are extracted from the actual LRC text
//     inside the response.
//   * Genre is matched against ALLOWED_GENRES; case-insensitive and
//     substring fallback so model typos ("Pop ", "nhạc trẻ") still
//     resolve to a canonical label.
const META_TITLE =
  /(?:^|\n)\s*(?:\*\*)?\s*(?:Tên\s*bài\s*hát|Song\s*title|Title|Bài\s*hát|Tên\s*track|Tên\s*ca\s*khúc)\s*(?:\*\*)?\s*[:：]\s*(.+?)\s*(?:\n|$)/iu;
const META_ARTIST =
  /(?:^|\n)\s*(?:\*\*)?\s*(?:Tên\s*các\s*ca\s*sĩ|Tên\s*các\s*ca\s*sỹ|Tên\s*ca\s*sĩ|Ca\s*sĩ|Ca\s*sỹ|Artist|Artists|Singer|Singers|Performed\s*by)\s*(?:\*\*)?\s*[:：]\s*(.+?)\s*(?:\n|$)/iu;
const META_GENRE =
  /(?:^|\n)\s*(?:\*\*)?\s*(?:Thể\s*loại\s*nhạc|Thể\s*loại|Thể\s*loai|Loại\s*nhạc|Genre|Category)\s*(?:\*\*)?\s*[:：]\s*(.+?)\s*(?:\n|$)/iu;
const ID3_TITLE = /\[ti\s*:\s*([^\]]+)\]/i;
const ID3_ARTIST = /\[ar\s*:\s*([^\]]+)\]/i;
const ID3_GENRE = /\[(?:genre|tag|tt)\s*:\s*([^\]]+)\]/i;

const ALLOWED_GENRES = Object.freeze([
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
const DEFAULT_GENRE = "Nhạc Trẻ";

function normalizeGenre(raw) {
  const cleaned = cleanMetaValue(raw || "");
  if (!cleaned) return "";
  // Try direct match first (case-sensitive — labels in the list are
  // canonical and must round-trip with the prompt verbatim).
  if (ALLOWED_GENRES.includes(cleaned)) return cleaned;
  // Case-insensitive fallback so "nhạc trẻ" or "REMIX" still resolve.
  const lower = cleaned.toLowerCase();
  const ci = ALLOWED_GENRES.find((g) => g.toLowerCase() === lower);
  if (ci) return ci;
  // Last resort: pick the longest allowed-genre substring that appears
  // in the value. Handles cases like "Nhạc trữ tình / bolero" where the
  // model returns a separator that's not in the canonical list.
  const sorted = [...ALLOWED_GENRES].sort((a, b) => b.length - a.length);
  for (const g of sorted) {
    if (lower.includes(g.toLowerCase())) return g;
  }
  return "";
}

function cleanMetaValue(raw) {
  if (!raw) return "";
  let v = String(raw).trim();
  // Strip surrounding quotes (straight + curly).
  v = v.replace(/^["'“”«»]+|["'“”«»]+$/g, "").trim();
  // Strip trailing punctuation that's typically noise.
  v = v.replace(/[.,;:\-–—]+$/g, "").trim();
  // Collapse whitespace.
  v = v.replace(/\s+/g, " ").trim();
  return v;
}

function splitArtists(raw) {
  const cleaned = cleanMetaValue(raw);
  if (!cleaned) return [];
  // Split on commas, semicolons, ampersands, slashes, " and ", " và ".
  return cleaned
    .split(/\s*(?:,|;|\/|\&|\b(?:and|và|vs\.?)\b)\s*/i)
    .map((s) => cleanMetaValue(s))
    .filter((s) => s.length > 0);
}

/**
 * Extracts song title, artist names, and canonical genre from a Gemini
 * response. Designed to tolerate preamble text, markdown, code fences,
 * and mixed language. Always returns an object; missing fields are
 * omitted (not ""). The `genre` field, when present, is guaranteed to
 * be one of ALLOWED_GENRES — callers can use it directly as a tag.
 *
 * @param {string} raw - The raw Gemini response (LRC text, Python wrapper, or
 *                       any string that may contain the Vietnamese labels).
 * @returns {{ title?: string, artists?: string[], genre?: string }}
 */
export function extractSongMetadata(raw) {
  if (!raw || typeof raw !== "string") return {};
  const out = {};

  // 1) Primary signal: preamble lines with the explicit Vietnamese labels.
  const titleMatch = raw.match(META_TITLE);
  if (titleMatch && titleMatch[1]) {
    const t = cleanMetaValue(titleMatch[1]);
    if (t) out.title = t;
  }
  const artistMatch = raw.match(META_ARTIST);
  if (artistMatch && artistMatch[1]) {
    const a = splitArtists(artistMatch[1]);
    if (a.length > 0) out.artists = a;
  }
  const genreMatch = raw.match(META_GENRE);
  if (genreMatch && genreMatch[1]) {
    const g = normalizeGenre(genreMatch[1]);
    if (g) out.genre = g;
  }

  // 2) Secondary signal: LRC ID3 tags [ti: ...] / [ar: ...] / [genre: ...].
  if (!out.title) {
    const m = raw.match(ID3_TITLE);
    if (m && m[1]) {
      const t = cleanMetaValue(m[1]);
      if (t) out.title = t;
    }
  }
  if (!out.artists || out.artists.length === 0) {
    const m = raw.match(ID3_ARTIST);
    if (m && m[1]) {
      const a = splitArtists(m[1]);
      if (a.length > 0) out.artists = a;
    }
  }
  if (!out.genre) {
    const m = raw.match(ID3_GENRE);
    if (m && m[1]) {
      const g = normalizeGenre(m[1]);
      if (g) out.genre = g;
    }
  }

  // 3) Always guarantee a genre. The UI shows tags[0] next to the song
  // title; we'd rather fall back to a sane default than leak an empty
  // tag or whatever nonsense the model produced.
  if (!out.genre) out.genre = DEFAULT_GENRE;

  return out;
}

export { ALLOWED_GENRES, DEFAULT_GENRE };
