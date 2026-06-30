// Calls the ShopAIKey Gemini API to generate LRC text directly,
// without opening a Gemini browser tab.
//
// This service is used when the user selects "Gemini API" as the LRC
// provider in AddSongModal.  The background service worker proxies the
// request so the API key stays in extension storage and is never
// hard-coded.
//
// Flow (AddSongModal → background → ShopAIKey → AddSongModal):
//   1. AddSongModal sends "gemini-api/generate-lrc" to background.
//   2. Background reads the API key from chrome.storage.local,
//      builds the request, and calls https://api.shopaikey.com.
//   3. Background streams/waits for the full text response.
//   4. Background replies with "gemini-api/result" or "gemini-api/error".
//   5. AddSongModal parses the response with the existing extractors
//      (extractLrcFromGeminiOutput, extractSongMetadata) and continues
//      the shared post-LRC flow (MP3 fetch → persistSong).

// ── Constants ────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.shopaikey.com";

/** Prompt sent to the API.  No file attachment required — just plain text. */
function buildApiPrompt(youtubeUrl) {
  const GENRE_LIST =
    "Remix, Pop, Rock, Hip-hop & Rap, R&B & Soul, Dance & Electronic, " +
    "Nhạc Đồng quê, Nhạc Cổ điển, K-Pop, Nhạc Mỹ Latinh, Indie & Alternative, " +
    "Jazz, Blues, Metal, Nhạc Trẻ, Nhạc Trữ tình & Bolero, Nhạc Không lời, " +
    "Nhạc Thiếu nhi, Reggae, Folk & Acoustic";
  return (
    "Hãy tạo nội dung LRC từ Link: " +
    youtubeUrl +
    "\n" +
    "Hãy đối chiếu đúng lời lyrics thực tế của bài hát trong video.\n" +
    "Sửa LRC cho đúng vì phụ đề có thể không đúng so với thực tế.\n" +
    "Kết quả trả về đúng format:\n" +
    "Tên bài hát: ...\n" +
    "Tên các ca sỹ: ...\n" +
    "Thể loại nhạc: ...  (phải thuộc danh sách: " + GENRE_LIST + ")\n" +
    "[mm:ss.xx] lời bài hát\n" +
    "[mm:ss.xx] lời bài hát\n" +
    "Không mô tả gì thêm."
  );
}

// ── chrome.storage helpers ──────────────────────────────────────────────────────

/**
 * Reads `svdmusic:lrcProvider` from chrome.storage.local.
 * Resolves with "gemini-ui" if the key is absent.
 */
function getLrcProvider() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("svdmusic:lrcProvider", (data) => {
        if (chrome.runtime.lastError) { resolve("gemini-ui"); return; }
        const val = data && data["svdmusic:lrcProvider"];
        resolve(val === "gemini-api" ? "gemini-api" : "gemini-ui");
      });
    } catch (_) { resolve("gemini-ui"); }
  });
}

/**
 * Reads `svdmusic:geminiApiKey` from chrome.storage.local.
 * Resolves with "" if the key is absent or on error.
 */
function getApiKey() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("svdmusic:geminiApiKey", (data) => {
        if (chrome.runtime.lastError) { resolve(""); return; }
        resolve(
          (data && typeof data["svdmusic:geminiApiKey"] === "string")
            ? data["svdmusic:geminiApiKey"].trim()
            : ""
        );
      });
    } catch (_) { resolve(""); }
  });
}

/**
 * Saves `svdmusic:geminiApiKey` to chrome.storage.local.
 */
function setApiKey(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(
        { "svdmusic:geminiApiKey": String(key || "").trim() },
        resolve
      );
    } catch (_) { resolve(); }
  });
}

/**
 * Saves `svdmusic:lrcProvider` to chrome.storage.local.
 */
function setLrcProvider(provider) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(
        { "svdmusic:lrcProvider": String(provider || "gemini-ui").trim() },
        resolve
      );
    } catch (_) { resolve(); }
  });
}

// ── API call ───────────────────────────────────────────────────────────────────

/**
 * Calls the ShopAIKey Gemini API with the given youtubeUrl and returns the
 * response text.
 *
 * @param {object} opts
 * @param {string} opts.apiKey       — from chrome.storage.local
 * @param {string} opts.youtubeUrl    — YouTube URL
 * @param {string} opts.correlationId — for logging
 * @param {function} opts.onProgress  — called with a string message
 * @returns {Promise<string>} the raw text response from the API
 * @throws {Error} on missing key, HTTP errors, or parse failure
 */
async function callShopAiKey({ apiKey, youtubeUrl, correlationId, onProgress }) {
  if (!apiKey) {
    const err = new Error("Chưa cấu hình Gemini API key.");
    err.code = "MISSING_KEY";
    throw err;
  }

  onProgress?.("Đang gọi Gemini API...");

  const model = "gemini-3.1-pro-preview";
  const prompt = buildApiPrompt(youtubeUrl);

  // Build the request body per ShopAIKey's OpenAI-compatible /v1/chat/completions endpoint.
  const requestBody = {
    model,
    messages: [{ role: "user", content: prompt }],
    thinking: {
      type: "enabled",
      budget_tokens: 4096,
    },
  };

  onProgress?.("Đang chờ phản hồi từ API...");

  let response;
  try {
    response = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (networkErr) {
    const err = new Error("Không kết nối được API: " + (networkErr.message || String(networkErr)));
    err.code = "NETWORK_ERROR";
    throw err;
  }

  if (response.status === 401 || response.status === 403) {
    const err = new Error("API key sai hoặc không có quyền (401/403).");
    err.code = "AUTH_ERROR";
    throw err;
  }

  if (response.status === 429) {
    const err = new Error("API đang bị giới hạn request (429).");
    err.code = "RATE_LIMIT";
    throw err;
  }

  if (!response.ok) {
    const err = new Error("API trả lỗi HTTP " + response.status + ".");
    err.code = "HTTP_ERROR";
    err.httpStatus = response.status;
    throw err;
  }

  let json;
  try {
    json = await response.json();
  } catch (_) {
    const err = new Error("API trả phản hồi không phải JSON hợp lệ.");
    err.code = "PARSE_ERROR";
    throw err;
  }

  // OpenAI-compatible shape: choices[0].message.content
  const content =
    json &&
    json.choices &&
    json.choices[0] &&
    (json.choices[0].message || json.choices[0]) &&
    (json.choices[0].message?.content || json.choices[0].content || "");

  if (typeof content !== "string" || !content.trim()) {
    const err = new Error("API trả phản hồi trống.");
    err.code = "EMPTY_RESPONSE";
    throw err;
  }

  onProgress?.("Đã nhận phản hồi từ API (" + content.length + " ký tự).");
  return content.trim();
}

// ── Export (used by background.js message handler) ────────────────────────────

// These are exported so background.js can call them without importing a
// module (MV3 service workers handle imports differently than Vite-bundled
// sidepanel code).  Instead of `import`, background.js accesses them via
// the global scope after the script is loaded.
if (typeof window !== "undefined") {
  window.__svdmusicGeminiApi = {
    getLrcProvider,
    getApiKey,
    setApiKey,
    setLrcProvider,
    callShopAiKey,
    API_BASE,
  };
}
