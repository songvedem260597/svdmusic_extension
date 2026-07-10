// Mood Quote service.
//
// Asks the extension background (service worker) for a Vietnamese mood quote.
// The background handles CORS-bypass, multi-provider fallback (ZenQuotes →
// Quotable → local), and an in-flight lock so we never spam the APIs.
//
// This module adds a small localStorage cache (2 min) as a second layer of
// dedup so the typing loop can resume instantly when the panel reopens inside
// the same window — without any background roundtrip.
//
// If anything fails (network, background dead, schema mismatch), we fall back
// to a small built-in array of Vietnamese mood quotes.

const BG_ACTION = "GET_MOOD_QUOTE";

const CACHE_KEY = "svd_mood_quote_cache";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const FALLBACK_QUOTES = [
  "Có những ngày tuyệt vọng đến cùng cực, tôi và cuộc đời đã tha thứ cho nhau ☘️",
  "Có những nỗi buồn không cần gọi tên, chỉ cần một bài nhạc đủ lâu ☘️",
  "Rồi mọi thứ cũng sẽ dịu lại, theo một cách rất im lặng ☘️",
];

let warnLogged = false;

/** Reads localStorage cache; returns null if absent or stale. */
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry?.displayText || Date.now() - entry.savedAt > CACHE_TTL_MS) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/** Writes displayText + savedAt into localStorage. */
function writeCache(displayText) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ displayText, savedAt: Date.now() }),
    );
  } catch {
    // localStorage unavailable (private mode / quota) — ignore.
  }
}

/**
 * Returns a Vietnamese quote string ending in ☘️.
 *
 * Tries (in order):
 *   1. localStorage cache (2 min TTL) → no network at all.
 *   2. background proxy → ZenQuotes → Quotable → MyMemory translate.
 *   3. Built-in fallback array (random pick).
 *
 * @returns {Promise<string>}
 */
export async function getMoodQuote() {
  // 1) localStorage hit
  const cached = readCache();
  if (cached) return cached.displayText;

  // 2) Ask background (CORS-free) for a fresh quote
  try {
    const response = await chrome.runtime.sendMessage({ action: BG_ACTION });
    if (
      response &&
      typeof response === "object" &&
      typeof response.displayText === "string" &&
      response.displayText.length > 0
    ) {
      const displayText = response.displayText.trim();
      writeCache(displayText);
      return displayText;
    }
  } catch (err) {
    if (!warnLogged) {
      warnLogged = true;
      console.warn("[moodQuoteApi] background proxy error:", err);
    }
  }

  // 3) Everything failed — use built-in fallback.
  const pick = FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)];
  return pick;
}
