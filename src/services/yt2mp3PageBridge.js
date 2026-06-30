// MAIN-world helpers for the yt2mp3-page-bridge provider.
//
// Why this exists:
//   The yt2mp3converter.net API rejects requests whose Origin is
//   `chrome-extension://...` (HTTP 403). The only working path we
//   found is to make the XHR from the page context of
//   https://www.yt2mp3.cloud/ so the browser sends a normal Origin
//   header. The background service worker opens a tab on yt2mp3.cloud,
//   waits for it to finish loading, then injects one of the functions
//   below into the MAIN world of that tab via
//   `chrome.scripting.executeScript({ world: 'MAIN', func, args })`.
//
// Two responsibilities live here:
//
//   1. convertViaYt2mp3Main({ youtubeId })
//      XHR `GET https://api.yt2mp3converter.net/api/new/convert?youtubeId=ID`
//      and return a plain serialisable payload describing the result.
//      Throws via a sentinel `__yt2mp3Error` property so the background
//      can map the failure back to a stage log without losing the
//      original status code.
//
//   2. fetchMp3AsBase64Main({ url })
//      Fetch the download URL inside the page context (same-origin or
//      CORS-allowed target) and return `{ arrayBuffer, contentType,
//      size }` as plain JSON-safe values. The background then turns
//      the bytes into a Blob. We return the byte array as `Uint8Array`
//      JSON-encoded — chrome.scripting.executeScript serialises the
//      return value via structured clone, so ArrayBuffer survives.
//
// Neither helper touches the DOM. They only need the page to have a
// real fetch/XHR origin. They run as a single async function so the
// `executeScript` caller can `await` the Promise returned by `func`.

export const YT2MP3_API_BASE = "https://api.yt2mp3converter.net";

/**
 * Body of the XHR call to the convert API. Designed to be the body of
 * `chrome.scripting.executeScript({ world: 'MAIN', func })`. Background
 * passes `args: [youtubeId]`.
 *
 * Returns a serialisable object. On any failure the returned object
 * carries `__yt2mp3Error: { stage, message, status }` so the caller
 * can distinguish stages (FORBIDDEN, NO_LINK, ...).
 */
export function convertViaYt2mp3Main(youtubeId) {
  return new Promise((resolve) => {
    if (!youtubeId || typeof youtubeId !== "string") {
      resolve({
        __yt2mp3Error: { stage: "NO_LINK", message: "Thiếu youtubeId." },
      });
      return;
    }
    const url =
      YT2MP3_API_BASE + "/api/new/convert?youtubeId=" + encodeURIComponent(youtubeId);
    let xhr;
    try {
      xhr = new XMLHttpRequest();
    } catch (error) {
      resolve({
        __yt2mp3Error: {
          stage: "INJECT_FAILED",
          message: "Không tạo được XMLHttpRequest: " + (error?.message || String(error)),
        },
      });
      return;
    }
    try {
      xhr.open("GET", url, true);
      xhr.timeout = 15000;
      xhr.setRequestHeader("Accept", "application/json");
    } catch (error) {
      resolve({
        __yt2mp3Error: {
          stage: "INJECT_FAILED",
          message: "Không cấu hình được XHR: " + (error?.message || String(error)),
        },
      });
      return;
    }
    xhr.onload = () => {
      const status = xhr.status;
      if (status === 403) {
        resolve({
          __yt2mp3Error: {
            stage: "API_FORBIDDEN",
            message: "API trả 403 Forbidden.",
            status,
          },
        });
        return;
      }
      if (status < 200 || status >= 300) {
        resolve({
          __yt2mp3Error: {
            stage: "NO_LINK",
            message: "API trả HTTP " + status + ".",
            status,
            raw: (xhr.responseText || "").slice(0, 500),
          },
        });
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch (error) {
        resolve({
          __yt2mp3Error: {
            stage: "NO_LINK",
            message: "API không trả JSON hợp lệ: " + (error?.message || String(error)),
            raw: (xhr.responseText || "").slice(0, 500),
          },
        });
        return;
      }
      if (
        !parsed ||
        parsed.status !== "ok" ||
        (parsed.progress ?? 0) < 100 ||
        !parsed.link
      ) {
        resolve({
          __yt2mp3Error: {
            stage: "NO_LINK",
            message:
              "API không trả về link MP3 (status=" +
              (parsed?.status || "?") +
              ", progress=" +
              (parsed?.progress ?? "?") +
              ").",
          },
        });
        return;
      }
      resolve({
        link: parsed.link,
        title: typeof parsed.title === "string" ? parsed.title : "",
        duration: typeof parsed.duration === "number" ? parsed.duration : null,
        filesize: typeof parsed.filesize === "number" ? parsed.filesize : null,
        videoId: typeof parsed.videoId === "string" ? parsed.videoId : youtubeId,
      });
    };
    xhr.onerror = () => {
      resolve({
        __yt2mp3Error: {
          stage: "NO_LINK",
          message: "XHR lỗi mạng (onerror).",
        },
      });
    };
    xhr.ontimeout = () => {
      resolve({
        __yt2mp3Error: {
          stage: "NO_LINK",
          message: "XHR timeout sau 15s.",
        },
      });
    };
    try {
      xhr.send();
    } catch (error) {
      resolve({
        __yt2mp3Error: {
          stage: "INJECT_FAILED",
          message: "XHR.send() lỗi: " + (error?.message || String(error)),
        },
      });
    }
  });
}

/**
 * Body of the fallback fetcher. Runs inside the page context of
 * yt2mp3.cloud so the MP3 download URL is fetched with that origin.
 * Returns `{ arrayBuffer, contentType, size }` where arrayBuffer is a
 * base64 string (we don't rely on structured-clone of ArrayBuffer
 * across `executeScript` — base64 is bulletproof and the byte cost
 * here is small: ~5MB ≈ 6.7MB base64).
 *
 * Background decodes the base64 and builds the Blob.
 */
export async function fetchMp3AsBase64Main({ url } = {}) {
  if (!url || typeof url !== "string") {
    return { __yt2mp3Error: { stage: "MP3_FETCH_FAILED", message: "Thiếu url." } };
  }
  let response;
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch (error) {
    return {
      __yt2mp3Error: {
        stage: "MP3_FETCH_FAILED",
        message: "fetch() lỗi: " + (error?.message || String(error)),
      },
    };
  }
  if (!response.ok) {
    return {
      __yt2mp3Error: {
        stage: "MP3_FETCH_FAILED",
        message: "MP3 trả HTTP " + response.status + ".",
        status: response.status,
      },
    };
  }
  const contentType = response.headers.get("content-type") || "";
  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    return {
      __yt2mp3Error: {
        stage: "MP3_FETCH_FAILED",
        message: "Không đọc được body: " + (error?.message || String(error)),
      },
    };
  }
  const bytes = new Uint8Array(buffer);
  // Manual base64 to avoid pulling btoa() into large-string territory.
  // chunkSize keeps the call stack safe for large files (~5MB).
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    );
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  return {
    base64,
    contentType,
    size: bytes.length,
  };
}

/**
 * Convenience wrapper: return value validator for the background.
 * If the injected script returns `{ __yt2mp3Error: {...} }` we throw
 * a normal Error so the existing try/catch chain logs the stage.
 *
 * @param {{__yt2mp3Error?: {stage:string,message:string,status?:number}}|any} result
 * @returns {{ok:true, value:any}|{ok:false, stage:string, message:string, status?:number}}
 */
export function unwrapInjectedResult(result) {
  if (result && typeof result === "object" && result.__yt2mp3Error) {
    const e = result.__yt2mp3Error;
    return { ok: false, stage: e.stage || "NO_LINK", message: e.message || "", status: e.status };
  }
  return { ok: true, value: result };
}