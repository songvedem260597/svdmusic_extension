// Background service worker. Responsibilities:
const BG_BUILD_ID = "pin-back-sidepanel-fix-20260714-004";
console.log("[svdmusic-bg] BUILD_ID =", BG_BUILD_ID);
//   1. Open the sidepanel when the extension icon is clicked.
//   2. Bridge messages between the sidepanel and the gemini-content.js
//      content script running on https://gemini.google.com/*.
//   3. Forward progress / result / error messages from the content script
//      back to the sidepanel so the modal can update its UI.
//   4. Own the single source of truth for "is a Gemini LRC job currently
//      running?" via chrome.storage.local. The content script's sessionStorage
//      lock only worked inside one tab; we need a cross-tab, cross-context
//      lock to prevent duplicate instances from the same sidepanel trigger.
//   5. Run the MP3 download pipeline via the yt2mp3-page-bridge provider.
//      Open a tab on https://www.yt2mp3.cloud/, MAIN-world-inject an XHR
//      to https://api.yt2mp3converter.net/api/new/convert (which rejects
//      chrome-extension:// origins), then download the MP3 from the SW
//      (or fall back to another MAIN-world fetch if CORS blocks us).
//      The sidepanel writes the resulting Blob to IndexedDB.

const GEMINI_ORIGIN = "https://gemini.google.com";
const LOCK_KEY = "svdmusic.gemini.currentJob";
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes; anything older is stale.

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

// Drop seen-sender entries when their tab goes away so a later run on the
// same tabId starts with a clean slate. Also clear the storage lock when
// the LAST Gemini tab for that jobId is closed — without this the lock
// outlives the actual session and the user sees the
// "đã có phiên Gemini đang chạy" error even after they close every tab.
const jobTabs = new Map(); // jobId -> Set<tabId>

function trackGeminiTab(jobId, tabId) {
  if (!jobId || !tabId) return;
  if (!jobTabs.has(jobId)) jobTabs.set(jobId, new Set());
  jobTabs.get(jobId).add(tabId);
}

function untrackGeminiTab(jobId, tabId) {
  if (!jobId) return;
  const set = jobTabs.get(jobId);
  if (!set) return;
  set.delete(tabId);
  if (set.size === 0) jobTabs.delete(jobId);
}

async function clearLockIfNoTabs(jobId) {
  if (!jobId) return;
  untrackGeminiTab(jobId, null);
  if (jobTabs.has(jobId)) return; // some tabs still alive
  await clearCurrentJob(jobId);
  const set = contentPortsByJob.get(jobId);
  if (set) {
    for (const p of set) {
      try { p.disconnect(); } catch (_) { /* noop */ }
    }
    contentPortsByJob.delete(jobId);
  }
}

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  // Drop the owned-tab entry if the user (or our closeOwnedYt2mp3Tab)
  // removed a tab we created. Best-effort.
  ownedYt2mp3Tabs.delete(tabId);

  // ── View-transfer session cleanup ──────────────────────────────────────────
  // For ANY removed tabId, clean up any view-owner or active transfer that
  // references it. Do NOT auto-open the sidepanel — the user explicitly closed
  // the standalone; the sidepanel already has its own React instance.

  // Helper: read and clean a single transfer object if it references tabId.
  function cleanupTransfer(transfer) {
    if (!transfer) return;
    const keysToRemove = [];
    if (transfer.standaloneTabId === tabId) keysToRemove.push("svdmusic.standaloneTabId");
    if (transfer.originWindowId === tabId) keysToRemove.push("svdmusic.originWindowId");
    if (keysToRemove.length > 0) {
      chrome.storage.session.remove(keysToRemove, () => { /* ignore */ });
    }
  }

  chrome.storage.session.get([
    "svdmusic.viewOwner",
    "svdmusic.standaloneTabId",
    "svdmusic.standaloneWindowId",
    "svdmusic.activeViewTransfer",
    "svdmusic.pendingViewSnapshot",
  ]).then((result) => {
    let modified = false;

    // 1. Clear viewOwner if its tabId matches the removed tab.
    const owner = result?.["svdmusic.viewOwner"];
    if (owner && owner.tabId === tabId) {
      chrome.storage.session.remove("svdmusic.viewOwner", () => { /* ignore */ });
      modified = true;
    }

    // 2. Clear standaloneTabId if it matches.
    if (result?.["svdmusic.standaloneTabId"] === tabId) {
      chrome.storage.session.remove("svdmusic.standaloneTabId", () => { /* ignore */ });
      modified = true;
    }

    // 3. Clear any active transfer or pending snapshot that references this tabId.
    const transfer = result?.["svdmusic.activeViewTransfer"];
    if (transfer) {
      const refsThisTab =
        transfer.standaloneTabId === tabId ||
        transfer.originWindowId === tabId;
      if (refsThisTab) {
        chrome.storage.session.remove("svdmusic.activeViewTransfer", () => { /* ignore */ });
        modified = true;
      }
    }

    const snap = result?.["svdmusic.pendingViewSnapshot"];
    if (snap && snap.tabId === tabId) {
      chrome.storage.session.remove("svdmusic.pendingViewSnapshot", () => { /* ignore */ });
      modified = true;
    }
  }).catch(() => {});

  // ── Clear the storage lock if this tab was the last one for its jobId. ──────
  for (const [jobId, set] of Array.from(jobTabs.entries())) {
    if (set.has(tabId)) {
      set.delete(tabId);
      if (set.size === 0) {
        jobTabs.delete(jobId);
        clearCurrentJob(jobId).catch(() => {});
        const ports = contentPortsByJob.get(jobId);
        if (ports) {
          for (const entry of ports) {
            try { entry.port.disconnect(); } catch (_) { /* noop */ }
          }
          contentPortsByJob.delete(jobId);
        }
      }
    }
  }
});

chrome.windows?.onRemoved?.addListener?.((removedWindowId) => {
  // ── Popup window session cleanup ────────────────────────────────────────────
  // If the user manually closes the standalone popup (via the OS X button),
  // clear all popup metadata. Do NOT auto-open the sidepanel — the user
  // explicitly closed the popup; the sidepanel is already gone in that
  // window.

  chrome.storage.session.get([
    "svdmusic.standaloneWindowId",
    "svdmusic.viewOwner",
    "svdmusic.activeViewTransfer",
    "svdmusic.pendingViewSnapshot",
  ]).then((result) => {
    const storedId = result?.["svdmusic.standaloneWindowId"];
    if (typeof storedId !== "number" || storedId !== removedWindowId) {
      return; // not our popup
    }

    // Clear popup window id.
    chrome.storage.session.remove("svdmusic.standaloneWindowId", () => { /* ignore */ });

    // Clear viewOwner if its windowId matches.
    const owner = result?.["svdmusic.viewOwner"];
    if (owner && owner.windowId === removedWindowId) {
      chrome.storage.session.remove("svdmusic.viewOwner", () => { /* ignore */ });
    }

    // Clear active transfer if it references this popup window.
    const transfer = result?.["svdmusic.activeViewTransfer"];
    if (transfer && transfer.standaloneWindowId === removedWindowId) {
      chrome.storage.session.remove("svdmusic.activeViewTransfer", () => { /* ignore */ });
    }

    // Clear pending snapshot if it belongs to this popup transfer.
    const snap = result?.["svdmusic.pendingViewSnapshot"];
    if (snap && snap.targetMode === "standalone" &&
        transfer && transfer.standaloneWindowId === removedWindowId) {
      chrome.storage.session.remove("svdmusic.pendingViewSnapshot", () => { /* ignore */ });
    }
  }).catch(() => {});
});

chrome.action?.onClicked?.addListener(async (tab) => {
  if (!chrome.sidePanel?.open) return;
  try {
    await chrome.sidePanel.open({ tabId: tab?.id });
  } catch (error) {
    console.warn("[svdmusic-bg] open sidepanel failed", error);
  }
});

// ── View-mode session watcher (debug) ───────────────────────────────────
// Logs every change to svdmusic.activeViewTransfer and
// svdmusic.pendingViewSnapshot so we can verify writes from popup
// reach session storage before the sidepanel reads them.
chrome.storage?.session?.onChanged?.addListener?.((changes, area) => {
  if (area !== "session") return;
  const transferChange = changes["svdmusic.activeViewTransfer"];
  if (transferChange) {
    console.log("[SW] ACTIVE_TRANSFER_CHANGED", {
      oldValue: transferChange.oldValue,
      newValue: transferChange.newValue,
    });
  }
  const snapChange = changes["svdmusic.pendingViewSnapshot"];
  if (snapChange) {
    console.log("[SW] PENDING_SNAPSHOT_CHANGED", {
      oldValue: snapChange.oldValue,
      newValue: snapChange.newValue,
    });
  }
});

function isGeminiUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "gemini.google.com" || host.endsWith(".gemini.google.com");
  } catch {
    return false;
  }
}

// ── yt2mp3-page-bridge MP3 pipeline (runs in service worker) ─────────────
//
// We can't hit https://api.yt2mp3converter.net/ directly from the SW:
// the API rejects any request whose Origin header is
// `chrome-extension://...` with HTTP 403. The only working path is to
// make the XHR from the page context of https://www.yt2mp3.cloud/ so
// the browser sends a normal `Origin: https://www.yt2mp3.cloud`.
//
// Pipeline:
//   1. Open (or reuse) a tab on https://www.yt2mp3.cloud/ and wait for
//      the document to finish loading.
//   2. Inject a MAIN-world function that does an XHR against
//      https://api.yt2mp3converter.net/api/new/convert?youtubeId=ID
//      and returns `{ link, title, duration, filesize, videoId }`.
//   3. Try to fetch the MP3 from the SW (no CORS restriction on the
//      download URL once we know it). If the SW fetch fails for any
//      reason, fall back to a second MAIN-world fetch and ship the
//      bytes back as base64.
//   4. Validate the Blob (content-type starts with `audio/`, size
//      > 100KB, not text/html/json). Then close the tab we opened.

const YT2MP3_BRIDGE_BASE = "https://www.yt2mp3.cloud";
const YT2MP3_API_BASE = "https://api.yt2mp3converter.net";
const YT2MP3_HOST_RE = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|live\/|shorts\/)|[?&]v=)([a-zA-Z0-9_-]{11})/;

function extractYoutubeVideoId(url) {
  if (!url || typeof url !== "string") return null;
  const m = YT2MP3_HOST_RE.exec(url);
  return m ? m[1] : null;
}

// Tabs we opened ourselves so we can close them at the end of the job.
// We never close a tab the user opened manually.
const ownedYt2mp3Tabs = new Set();
const MP3COW_BRIDGE_BASE = "https://mp3cow.com";
const ownedMp3cowTabs = new Set();

function isMp3cowBridgeUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "mp3cow.com" || url.hostname.endsWith(".mp3cow.com"))
    );
  } catch (_) {
    return false;
  }
}

async function openOrReuseYt2mp3Tab() {
  // We support both the root path and any sub-page of yt2mp3.cloud. If
  // the user already has a tab on this site we reuse it instead of
  // opening another one — but we MUST NOT close that tab on job end.
  const existing = await chrome.tabs.query({ url: `${YT2MP3_BRIDGE_BASE}/*` });
  if (existing.length > 0) {
    const tab = existing[0];
    if (tab?.id != null) {
      return { tab, createdByBridge: false };
    }
  }
  // TODO(debug): tạm thời mở tab bridge active:true để kiểm tra e2e thủ
  // công. Sau khi xác nhận flow emit mp3/result + IndexedDB save ổn,
  // đổi lại active:false. Lý do giữ false bình thường: bridge tab
  // chạy nền, không cần đánh cắp focus của user đang làm việc khác.
  const tab = await chrome.tabs.create({ url: YT2MP3_BRIDGE_BASE + "/", active: true });
  if (tab?.id != null) ownedYt2mp3Tabs.add(tab.id);
  return { tab, createdByBridge: true };
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let info;
    try {
      info = await chrome.tabs.get(tabId);
    } catch (_) {
      // Tab was closed by the user mid-load.
      throw new Error("YT2MP3_PAGE_LOAD_FAILED: tab không tồn tại.");
    }
    if (info.status === "complete") return info;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("YT2MP3_PAGE_LOAD_FAILED: tab không load sau " + timeoutMs + "ms.");
}

async function closeOwnedYt2mp3Tab(tabId) {
  // Hard guard: never close a tab we didn't create ourselves. The
  // `createdByBridge` flag in `fetchMp3FromYt2mp3PageBridge` is the
  // primary gate; this Set is a defence-in-depth check.
  if (!tabId || !ownedYt2mp3Tabs.has(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    // Best-effort; user may have already closed it.
  } finally {
    ownedYt2mp3Tabs.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// MP3Cow page bridge
// ---------------------------------------------------------------------------

async function openOrReuseMp3cowTab() {
  const existing = await chrome.tabs.query({ url: `${MP3COW_BRIDGE_BASE}/*` });
  if (existing.length > 0) {
    const tab = existing[0];
    if (tab?.id != null) {
      return { tab, createdByBridge: false };
    }
  }
  const tab = await chrome.tabs.create({ url: MP3COW_BRIDGE_BASE + "/", active: true });
  if (tab?.id != null) ownedMp3cowTabs.add(tab.id);
  return { tab, createdByBridge: true };
}

async function waitForMp3cowTab(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let info;
    try {
      info = await chrome.tabs.get(tabId);
    } catch (_) {
      throw new Error("MP3COW_PAGE_LOAD_FAILED: tab không tồn tại.");
    }
    if (info.status === "complete") return info;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("MP3COW_PAGE_LOAD_FAILED: tab không load sau " + timeoutMs + "ms.");
}

async function closeOwnedMp3cowTab(tabId) {
  if (!tabId || !ownedMp3cowTabs.has(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) { /* noop */ } finally {
    ownedMp3cowTabs.delete(tabId);
  }
}

// Page-context script injected into mp3cow.com. Fetches the download link
// via api.mp3cow.com/z.php (bypasses CORS because it's same-origin in the
// mp3cow.com page context). Does NOT download the MP3 file — only returns
// the download URL. The caller fetches the MP3 in the background worker.
function mp3cowConvertMain(youtubeId) {
  var _youtubeId = youtubeId;
  var maxAttempts = 18;
  var pollDelayMs = 5000;

  function fail(stage, message, status, raw) {
    return {
      __yt2mp3Error: {
        stage: stage,
        message: message,
        status: status,
        raw: raw,
      },
    };
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function validHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value);
  }

  function extractDownload(parsed, apiStatus) {
    if (!parsed || typeof parsed !== "object") return "";
    var candidates = [
      parsed.download,
      parsed.download_url,
      parsed.downloadUrl,
      parsed.link,
    ];
    // MP3Cow's current page uses obj.url only for status "c" redirects.
    // A status "1" response may safely expose it as a direct file URL.
    if (apiStatus === "1") candidates.push(parsed.url);
    for (var i = 0; i < candidates.length; i += 1) {
      if (validHttpUrl(candidates[i])) return candidates[i];
    }
    return "";
  }

  function poll(attempt) {
    var apiUrl =
      "https://api.mp3cow.com/z.php?id=" +
      encodeURIComponent(_youtubeId) +
      "&t=" +
      Date.now();

    return fetch(apiUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json, text/plain, */*" },
    })
      .then(function (response) {
        return response.text().then(function (text) {
          return { response: response, text: text };
        });
      })
      .then(function (result) {
        var response = result.response;
        var text = result.text;
        var httpStatus = response.status;
        if (httpStatus < 200 || httpStatus >= 300) {
          return fail("API_ERROR", "API trả HTTP " + httpStatus + ".", httpStatus, text.slice(0, 500));
        }

        var parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          return fail(
            "API_PARSE_ERROR",
            "API không trả JSON hợp lệ: " + (e && e.message ? e.message : String(e)),
            httpStatus,
            text.slice(0, 500)
          );
        }

        var apiStatus =
          parsed && parsed.status !== undefined && parsed.status !== null
            ? String(parsed.status)
            : "";
        var download = extractDownload(parsed, apiStatus);
        if (download) {
          return {
            link: download,
            title: typeof parsed.title === "string" ? parsed.title : "",
            duration: null,
            filesize: null,
            videoId: typeof parsed.videoId === "string" ? parsed.videoId : _youtubeId,
            apiStatus: apiStatus,
          };
        }

        if (apiStatus === "c" && validHttpUrl(parsed.url)) {
          return {
            redirectUrl: parsed.url,
            apiStatus: apiStatus,
          };
        }

        if (apiStatus === "0" || apiStatus === "p") {
          return fail(
            "API_REJECTED",
            (typeof parsed.message === "string" && parsed.message) ||
              "MP3Cow từ chối yêu cầu chuyển đổi (status=" + apiStatus + ").",
            httpStatus,
            text.slice(0, 500)
          );
        }

        // The live MP3Cow page polls the same endpoint every five seconds
        // while conversion is pending (normally status "3"). Keep waiting
        // for that state and for transient incomplete payloads instead of
        // treating the first response as a missing download link.
        if (attempt + 1 < maxAttempts) {
          return wait(pollDelayMs).then(function () { return poll(attempt + 1); });
        }

        return fail(
          "CONVERSION_TIMEOUT",
          "MP3Cow chưa trả link sau " + maxAttempts +
            " lần kiểm tra (status=" + (apiStatus || "missing") + ").",
          httpStatus,
          text.slice(0, 500)
        );
      })
      .catch(function (e) {
        return fail(
          "API_FETCH_FAILED",
          "fetch() lỗi: " + (e && e.message ? e.message : String(e)),
          null,
          ""
        );
      });
  }

  if (!_youtubeId || typeof _youtubeId !== "string") {
    return Promise.resolve(fail("NO_LINK", "Thiếu youtubeId.", null, ""));
  }
  return poll(0);
}

// Page-context script injected into mp3cow.com to fetch the MP3 file.
// The file is fetched in the page context (Origin: mp3cow.com) so it
// bypasses CDN CORS restrictions. Returns base64-encoded bytes.
function mp3cowFetchMain(payload) {
  var url = payload && payload.url;
  return fetch(url, { credentials: "omit" })
    .then(function (response) {
      if (!response.ok) {
        return {
          __yt2mp3Error: {
            stage: "MP3_FETCH_FAILED",
            message: "MP3 trả HTTP " + response.status + ".",
            status: response.status,
          },
        };
      }
      var contentType = response.headers.get("content-type") || "";
      return response.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var binary = "";
        var chunkSize = 0x8000;
        for (var i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
          );
        }
        var base64 =
          typeof btoa === "function"
            ? btoa(binary)
            : Buffer.from(binary, "binary").toString("base64");
        return {
          base64: base64,
          contentType: contentType,
          size: bytes.length,
          status: response.status,
        };
      });
    })
    .catch(function (e) {
      return {
        __yt2mp3Error: {
          stage: "MP3_FETCH_FAILED",
          message: "fetch() lỗi: " + (e && e.message ? e.message : String(e)),
        },
      };
    });
}

// ---------------------------------------------------------------------------
// yt2mp3 page bridge
// ---------------------------------------------------------------------------

// MAIN-world scripts. These functions are JSON-serialised by Vite into
// background.js, so they must NOT reference any closure variables from
// this file. They live entirely inside the page context.
function yt2mp3ConvertMain(youtubeId) {
  return new Promise(function (resolve) {
    if (!youtubeId || typeof youtubeId !== "string") {
      resolve({ __yt2mp3Error: { stage: "NO_LINK", message: "Thiếu youtubeId." } });
      return;
    }
    var url =
      "https://api.yt2mp3converter.net/api/new/convert?youtubeId=" +
      encodeURIComponent(youtubeId);
    var xhr;
    try {
      xhr = new XMLHttpRequest();
    } catch (e) {
      resolve({
        __yt2mp3Error: {
          stage: "INJECT_FAILED",
          message: "Không tạo được XMLHttpRequest: " + (e && e.message ? e.message : String(e)),
        },
      });
      return;
    }
    try {
      xhr.open("GET", url, true);
      xhr.timeout = 15000;
      xhr.setRequestHeader("Accept", "application/json");
    } catch (e) {
      resolve({
        __yt2mp3Error: {
          stage: "INJECT_FAILED",
          message: "Không cấu hình được XHR: " + (e && e.message ? e.message : String(e)),
        },
      });
      return;
    }
    xhr.onload = function () {
      var status = xhr.status;
      if (status === 403) {
        resolve({
          __yt2mp3Error: {
            stage: "API_FORBIDDEN",
            message: "API trả 403 Forbidden.",
            status: status,
          },
        });
        return;
      }
      if (status < 200 || status >= 300) {
        resolve({
          __yt2mp3Error: {
            stage: "NO_LINK",
            message: "API trả HTTP " + status + ".",
            status: status,
            raw: (xhr.responseText || "").slice(0, 500),
          },
        });
        return;
      }
      var parsed = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch (e) {
        resolve({
          __yt2mp3Error: {
            stage: "NO_LINK",
            message:
              "API không trả JSON hợp lệ: " + (e && e.message ? e.message : String(e)),
            raw: (xhr.responseText || "").slice(0, 500),
          },
        });
        return;
      }
      if (
        !parsed ||
        parsed.status !== "ok" ||
        (parsed.progress | 0) < 100 ||
        !parsed.link
      ) {
        resolve({
          __yt2mp3Error: {
            stage: "NO_LINK",
            message:
              "API không trả về link MP3 (status=" +
              (parsed && parsed.status ? parsed.status : "?") +
              ", progress=" +
              (parsed && parsed.progress != null ? parsed.progress : "?") +
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
    xhr.onerror = function () {
      resolve({
        __yt2mp3Error: { stage: "NO_LINK", message: "XHR lỗi mạng (onerror)." },
      });
    };
    xhr.ontimeout = function () {
      resolve({
        __yt2mp3Error: { stage: "NO_LINK", message: "XHR timeout sau 15s." },
      });
    };
    try {
      xhr.send();
    } catch (e) {
      resolve({
        __yt2mp3Error: {
          stage: "INJECT_FAILED",
          message: "XHR.send() lỗi: " + (e && e.message ? e.message : String(e)),
        },
      });
    }
  });
}

function yt2mp3FetchMain(payload) {
  var url = payload && payload.url;
  return fetch(url, { credentials: "omit" })
    .then(function (response) {
      if (!response.ok) {
        return {
          __yt2mp3Error: {
            stage: "MP3_FETCH_FAILED",
            message: "MP3 trả HTTP " + response.status + ".",
            status: response.status,
          },
        };
      }
      var contentType = response.headers.get("content-type") || "";
      return response.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var binary = "";
        var chunkSize = 0x8000;
        for (var i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
          );
        }
        var base64 =
          typeof btoa === "function"
            ? btoa(binary)
            : Buffer.from(binary, "binary").toString("base64");
        return {
          base64: base64,
          contentType: contentType,
          size: bytes.length,
          status: response.status,
        };
      });
    })
    .catch(function (e) {
      return {
        __yt2mp3Error: {
          stage: "MP3_FETCH_FAILED",
          message: "fetch() lỗi: " + (e && e.message ? e.message : String(e)),
        },
      };
    });
}

function unwrapInjectedResult(result) {
  if (result && typeof result === "object" && result.__yt2mp3Error) {
    var e = result.__yt2mp3Error;
    return {
      ok: false,
      stage: e.stage || "NO_LINK",
      message: e.message || "",
      status: e.status,
    };
  }
  return { ok: true, value: result };
}

/**
 * Wraps a yt2mp3 failure into an Error that also exposes the numeric
 * HTTP status (when known). The `runMp3Job` catch handler reads
 * `error.httpStatus` and forwards it as `status` in the `mp3/error`
 * event so the sidepanel can map it to the spec-mandated user-facing
 * copy (HTTP 410 → "đã hết hạn hoặc bị xoá", 429 → "đang giới hạn", ...).
 *
 * If `httpStatus` is null/undefined we still wrap the message — callers
 * get the original behaviour, just with the convenience property.
 */
function makeYt2mp3Error(stage, message, httpStatus) {
  var err = new Error(stage + ": " + message);
  err.stage = stage;
  err.code = stage;
  err.httpStatus = typeof httpStatus === "number" ? httpStatus : null;
  return err;
}

/**
 * Extracts a numeric HTTP status code from an arbitrary error message.
 * Used by the MP3 fallback decision: many failures come back with the
 * status embedded in the message text (e.g. "API trả HTTP 500.") rather
 * than as an `err.httpStatus` property. Returns 0 if no status can be
 * parsed — callers should treat 0 as "no HTTP-level signal".
 */
function extractHttpStatus(message) {
  var text = String(message || "");
  var match =
    text.match(/HTTP\s*(\d{3})/i) ||
    text.match(/API trả HTTP\s*(\d{3})/i) ||
    text.match(/status[=: ]+(\d{3})/i);
  return match ? Number(match[1]) : 0;
}

function isAudioContentType(ct) {
  if (!ct) return false;
  var s = String(ct).toLowerCase();
  if (s.indexOf("audio/") === 0) return true;
  // octet-stream is what some CDNs return for MP3; allow if we later
  // detect MP3 magic bytes. We just don't outright reject it.
  if (s.indexOf("application/octet-stream") === 0) return true;
  return false;
}

function isBadContentType(ct) {
  if (!ct) return false;
  var s = String(ct).toLowerCase();
  return (
    s.indexOf("text/html") === 0 ||
    s.indexOf("text/plain") === 0 ||
    s.indexOf("application/json") === 0 ||
    s.indexOf("text/xml") === 0 ||
    s.indexOf("application/xml") === 0
  );
}

// Quick MP3 sniff: first 3 bytes are "ID3" or 0xFFEx (MPEG sync).
function looksLikeMp3(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // MPEG sync
  return false;
}

// Strict MP3 validator. Throws with a precise reason on failure. Caller
// is expected to log the message and either retry through the fallback
// path or surface the failure to the user.
//
// Rules (must all hold):
//   - response.ok === true
//   - blob.size > 100000  (100 KB)
//   - content-type startsWith "audio/" OR is "application/octet-stream"
//     (the latter is what many CDNs return for MP3).
//   - NOT one of: text/html, application/json, text/plain, text/xml,
//     application/xml. The provider sometimes redirects to a JSON error
//     page; we must NOT treat that as a valid MP3.
//   - First 3 bytes are either "ID3" or 0xFFEx (MPEG sync). Optional
//     but catches obvious wrong-format bodies.
//
// On any failure, we attach debug info to the thrown error so the
// sidepanel log is useful for diagnosis.
async function validateMp3Blob({ res, blob, stage }) {
  const ct = res?.headers?.get?.("content-type") || blob?.type || "";
  const size = blob?.size || 0;
  const status = res?.status;

  if (!res || res.ok !== true) {
    const err = new Error(`${stage}: HTTP_NOT_OK status=${status}`);
    err.httpStatus = typeof status === "number" ? status : null;
    err.mp3Stage = stage;
    throw err;
  }

  if (size < 100000) {
    // Try to read up to 200 chars of text body for debugging — when the
    // provider returns an error page, the size is small and the body is
    // readable. Don't fail if text() throws (e.g. binary blob).
    let raw = "";
    try { raw = (await blob.text()).slice(0, 200); } catch (_) { /* noop */ }
    const err = new Error(
      `${stage}: INVALID_AUDIO_BLOB size=${size} type=${ct} raw=${JSON.stringify(raw)}`
    );
    err.httpStatus = typeof status === "number" ? status : null;
    err.mp3Stage = stage;
    throw err;
  }

  const lowerCt = String(ct || "").toLowerCase();
  const badType =
    lowerCt.indexOf("text/html") === 0 ||
    lowerCt.indexOf("application/json") === 0 ||
    lowerCt.indexOf("text/plain") === 0 ||
    lowerCt.indexOf("text/xml") === 0 ||
    lowerCt.indexOf("application/xml") === 0;
  const goodType =
    lowerCt.indexOf("audio/") === 0 ||
    lowerCt.indexOf("application/octet-stream") === 0;

  if (badType || !goodType) {
    const err = new Error(
      `${stage}: INVALID_CONTENT_TYPE size=${size} type=${ct}`
    );
    err.httpStatus = typeof status === "number" ? status : null;
    err.mp3Stage = stage;
    throw err;
  }

  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
  const isMp3Frame =
    head[0] === 0xff && (head[1] === 0xfb || head[1] === 0xf3 || head[1] === 0xf2);

  if (!isId3 && !isMp3Frame) {
    const err = new Error(
      `${stage}: INVALID_MP3_HEADER head=[${Array.from(head).join(",")}] type=${ct} size=${size}`
    );
    err.httpStatus = typeof status === "number" ? status : null;
    err.mp3Stage = stage;
    throw err;
  }

  return true;
}

async function fetchMp3FromYt2mp3PageBridge(youtubeUrl, { onProgress } = {}) {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) throw new Error("Link YouTube không hợp lệ.");

  const emit = (stage, info) => {
    if (typeof onProgress === "function") {
      try { onProgress(stage, info); } catch (_) { /* noop */ }
    }
  };

  emit("bridge/open-tab");
  const { tab, createdByBridge } = await openOrReuseYt2mp3Tab();
  if (!tab?.id) throw new Error("YT2MP3_PAGE_LOAD_FAILED: không mở được tab bridge.");
  const tabId = tab.id;

  try {
    await waitForTabComplete(tabId, 30000);

    emit("bridge/requesting-conversion");
    let apiRaw;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        func: yt2mp3ConvertMain,
        args: [videoId],
      });
      apiRaw = result;
    } catch (err) {
      throw new Error(
        "YT2MP3_INJECT_FAILED: " + (err?.message || String(err))
      );
    }
    const apiCheck = unwrapInjectedResult(apiRaw);
    if (!apiCheck.ok) {
      throw makeYt2mp3Error(apiCheck.stage, apiCheck.message, apiCheck.status);
    }
    const apiPayload = apiCheck.value || {};
    const downloadURL = apiPayload.link;
    const apiTitle = apiPayload.title || videoId;
    const apiDuration = typeof apiPayload.duration === "number" ? apiPayload.duration : null;
    const apiFilesize = typeof apiPayload.filesize === "number" ? apiPayload.filesize : null;

    if (!downloadURL) throw new Error("YT2MP3_API_NO_LINK: response không có link.");

    emit("bridge/link-ready");
    // ── Try 1: SW fetch (no CORS). On ANY failure — network error,
    //    response not OK, invalid Blob from validator — we fall through
    //    to the MAIN-world fetch below. The validator is the same for
    //    both paths; the only thing that differs is the transport.
    emit("bridge/mp3-fetch");
    let swBlob = null;
    let swResponse = null;
    let swError = null;
    try {
      swResponse = await fetch(downloadURL, {
        headers: { Accept: "audio/mpeg, audio/*" },
        credentials: "omit",
      });
      if (swResponse && swResponse.ok) {
        const buf = await swResponse.arrayBuffer();
        swBlob = new Blob([buf], {
          type: swResponse.headers.get("content-type") || "audio/mpeg",
        });
      }
    } catch (e) {
      swError = e;
      console.warn("[svdmusic-bg] SW fetch MP3 threw, falling back", e);
    }

    let blob = null;
    let mimeType = "audio/mpeg";
    // Which transport produced the winning blob. We log this so we can
    // tell, after a failed e2e, whether the validator was bypassed or
    // the SW/MMAIN path is broken.
    let sourcePath = null;

    if (swBlob) {
      try {
        await validateMp3Blob({ res: swResponse, blob: swBlob, stage: "bridge/mp3-fetch" });
        blob = swBlob;
        mimeType = swBlob.type || "audio/mpeg";
        sourcePath = "sw-fetch";
      } catch (validationErr) {
        // The SW transport succeeded but the body is not a real MP3.
        // Surface a distinct stage so the UI / logs make it obvious the
        // provider is returning an error page (often a 15-byte JSON like
        // `{"status":"fail"}`) rather than a network/CORS problem.
        //
        // We DISCARD `swBlob` here — it is NOT reused. The fallback
        // path below issues a brand-new `fetch(downloadURL)` from the
        // page context of yt2mp3.cloud (different Origin header, often
        // hits a different CDN path) and rebuilds a fresh Blob from
        // that response's bytes. The 15-byte body is never returned to
        // the sidepanel.
        emit("bridge/mp3-fetch-invalid", {
          reason: String(validationErr?.message || validationErr),
          size: swBlob.size,
          type: swBlob.type,
          status: swResponse?.status,
        });
        console.warn(
          "[svdmusic-bg] SW fetch returned invalid MP3 blob (size=" +
            swBlob.size +
            " type=" + swBlob.type +
            "), discarding and re-fetching via MAIN-world",
          validationErr
        );
        blob = null;
        swBlob = null; // belt-and-suspenders — never reference this again.
      }
    } else if (swResponse && !swResponse.ok) {
      emit("bridge/mp3-fetch-invalid", {
        reason: `HTTP ${swResponse.status}`,
        status: swResponse.status,
      });
      console.warn("[svdmusic-bg] SW fetch non-OK", swResponse.status);
    }
    // If swBlob is null because of a network throw, no extra log —
    // the earlier console.warn already covered it.

    // ── Try 2: MAIN-world fetch. Runs when SW fetch threw, returned
    //    non-OK, OR returned an invalid Blob. The body comes back as
    //    base64 because fetch() can't transfer an ArrayBuffer across
    //    the scripting boundary cheaply.
    if (!blob) {
      // The fallback path runs when SW fetch threw, returned non-OK, OR
      // returned an invalid Blob. It is a COMPLETELY NEW fetch — we
      // never reuse any bytes from the SW response. `chrome.scripting.
      // executeScript` with `world: "MAIN"` runs the supplied function
      // inside the page context of `yt2mp3.cloud`, so `fetch(url)`
      // carries Origin: https://www.yt2mp3.cloud and bypasses the CORS
      // check that some CDNs impose on the SW-issued request.
      console.log(
        "[svdmusic-bg] fallback: issuing fresh fetch from MAIN world of tab",
        tabId,
        "url=" + downloadURL
      );
      emit("bridge/mp3-fallback");
      let fbRaw;
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "MAIN",
          func: yt2mp3FetchMain,
          args: [{ url: downloadURL }],
        });
        fbRaw = result;
      } catch (err) {
        throw new Error(
          "YT2MP3_INJECT_FAILED (fallback): " + (err?.message || String(err))
        );
      }
      const fbCheck = unwrapInjectedResult(fbRaw);
      if (!fbCheck.ok) {
        throw makeYt2mp3Error(fbCheck.stage, fbCheck.message, fbCheck.status);
      }
      const fbPayload = fbCheck.value || {};
      if (!fbPayload.base64) {
        throw new Error("YT2MP3_MP3_FETCH_FAILED: fallback trả về rỗng.");
      }
      const binary = atob(fbPayload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const fallbackMime = fbPayload.contentType || "audio/mpeg";
      const fallbackBlob = new Blob([bytes.buffer], { type: fallbackMime });
      // Construct a minimal fake Response-like object so validateMp3Blob
      // can read content-type via res.headers.get(). We pass through the
      // real status from the page context if it was returned; otherwise
      // we assume 200 (the page-context fetch only throws on non-OK,
      // because yt2mp3FetchMain checks response.ok internally).
      const fakeRes = {
        ok: true,
        status: fbPayload.status || 200,
        headers: { get: (name) => (name && name.toLowerCase() === "content-type" ? fallbackMime : null) },
      };
      try {
        await validateMp3Blob({ res: fakeRes, blob: fallbackBlob, stage: "bridge/mp3-fallback" });
        console.log(
          "[svdmusic-bg] fallback blob validated OK (size=" +
            fallbackBlob.size +
            " type=" + fallbackMime +
            ")"
        );
        blob = fallbackBlob;
        mimeType = fallbackMime;
        sourcePath = "main-fallback";
      } catch (validationErr) {
        // Both transports returned invalid bodies. Surface the precise
        // reason so the user / logs can diagnose. `fallbackBlob` is
        // discarded here too — nothing leaks to the sidepanel.
        const err = new Error(
          "YT2MP3_INVALID_AUDIO_BLOB (fallback): " +
            String(validationErr?.message || validationErr) +
            ` size=${fallbackBlob.size} type=${fallbackMime}`
        );
        err.httpStatus =
          typeof validationErr?.httpStatus === "number"
            ? validationErr.httpStatus
            : null;
        throw err;
      }
    }

    // ── Final guard. Even after validateMp3Blob passes we re-check
    //    size here so a 15-byte body can NEVER reach the sidepanel.
    //    This is the LAST line of defence: if it fires, the validator
    //    itself is broken and we want that to scream in the log.
    if (!blob || blob.size < 100000) {
      const sz = blob ? blob.size : 0;
      throw new Error(
        "YT2MP3_INVALID_AUDIO_BLOB (final-guard): size=" + sz +
          " type=" + (blob?.type || "?") +
          " sourcePath=" + (sourcePath || "?") +
          " — refusing to emit mp3/ready or mp3/result."
      );
    }

    // Diagnostic log right before we hand the bytes off to the sidepanel.
    // Useful when triaging e2e failures: we can see size, type, source
    // transport, and the first 4 bytes (ID3 vs MPEG sync).
    let firstBytesHex = "";
    try {
      const headBuf = await blob.slice(0, 4).arrayBuffer();
      const head = new Uint8Array(headBuf);
      firstBytesHex = Array.from(head)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } catch (_) { /* noop */ }
    console.log(
      "[svdmusic-bg] mp3 ready to emit: size=" + blob.size +
        " type=" + (blob.type || "?") +
        " sourcePath=" + sourcePath +
        " first4bytes=[" + firstBytesHex + "]"
    );

    emit("bridge/mp3-ready");

    const arrayBuffer = await blob.arrayBuffer();
    return {
      arrayBuffer,
      mimeType: mimeType || "audio/mpeg",
      size: blob.size,
      title: apiTitle,
      duration: apiDuration,
      filesize: apiFilesize != null ? apiFilesize : blob.size,
    };
  } finally {
    // Only close the tab if WE opened it ourselves. We must NEVER
    // close a tab the user already had on yt2mp3.cloud — that would
    // be disruptive (close background tabs, lose unsaved form input,
    // etc). The `createdByBridge` flag is the single source of truth
    // here. The `ownedYt2mp3Tabs` Set is a defence-in-depth check in
    // case we lose track of the flag (e.g. on extension reload).
    if (createdByBridge) await closeOwnedYt2mp3Tab(tabId);
  }
}

// ---------------------------------------------------------------------------
// MP3Cow page bridge
// ---------------------------------------------------------------------------

async function fetchMp3FromMp3cowPageBridge(youtubeUrl, { onProgress } = {}) {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) throw new Error("Link YouTube không hợp lệ.");

  const emit = (stage, info) => {
    if (typeof onProgress === "function") {
      try { onProgress(stage, info); } catch (_) { /* noop */ }
    }
  };

  emit("mp3cow/open-tab");
  const { tab, createdByBridge } = await openOrReuseMp3cowTab();
  if (!tab?.id) throw new Error("MP3COW_PAGE_LOAD_FAILED: không mở được tab bridge.");
  const tabId = tab.id;

  try {
    await waitForMp3cowTab(tabId, 30000);

    emit("mp3cow/api-ready");

    // The current MP3Cow page may first return status "c" and navigate to
    // another same-site page before the normal status "1" download result.
    // Follow that bounded redirect sequence, then ask the page-context
    // converter again so it shares the same first-party session as the UI.
    let apiPayload = null;
    for (let redirectAttempt = 0; redirectAttempt < 3; redirectAttempt += 1) {
      emit("mp3cow/converting");
      let apiRaw;
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "MAIN",
          func: mp3cowConvertMain,
          args: [videoId],
        });
        apiRaw = result;
      } catch (err) {
        throw new Error(
          "MP3COW_INJECT_FAILED: " + (err?.message || String(err))
        );
      }

      const apiCheck = unwrapInjectedResult(apiRaw);
      if (!apiCheck.ok) {
        throw makeMp3cowError(apiCheck.stage, apiCheck.message, apiCheck.status);
      }

      const nextPayload = apiCheck.value || {};
      if (!nextPayload.redirectUrl) {
        apiPayload = nextPayload;
        break;
      }

      if (!isMp3cowBridgeUrl(nextPayload.redirectUrl)) {
        throw new Error("MP3COW_REDIRECT_REJECTED: redirect không thuộc mp3cow.com.");
      }
      if (redirectAttempt === 2) {
        throw new Error("MP3COW_REDIRECT_LOOP: chuyển hướng quá nhiều lần.");
      }

      emit("mp3cow/redirect");
      await chrome.tabs.update(tabId, { url: nextPayload.redirectUrl });
      await waitForMp3cowTab(tabId, 30000);
    }

    if (!apiPayload) {
      throw new Error("MP3COW_API_NO_LINK: API không trả payload tải xuống.");
    }
    const downloadURL = apiPayload.link;
    const apiTitle = apiPayload.title || videoId;

    if (!downloadURL) throw new Error("MP3COW_API_NO_LINK: response không có link.");

    emit("mp3cow/page-api-ok", { downloadURL });

    // Step 2: Background fetch the MP3 (service worker context).
    // The URL came from the MP3Cow bridge so it's expected to be accessible
    // from the SW. We validate strictly — if this fails we fall through to
    // the page-context fetch below.
    emit("mp3cow/mp3-fetch");
    let blob = null;
    let mimeType = "audio/mpeg";
    let sourcePath = null;

    let swResponse = null;
    let swError = null;
    try {
      swResponse = await fetch(downloadURL, {
        headers: { Accept: "audio/mpeg, audio/*" },
        credentials: "omit",
      });
      if (swResponse && swResponse.ok) {
        const buf = await swResponse.arrayBuffer();
        const fetchedBlob = new Blob([buf], {
          type: swResponse.headers.get("content-type") || "audio/mpeg",
        });
        await validateMp3Blob({ res: swResponse, blob: fetchedBlob, stage: "mp3cow/mp3-fetch" });
        blob = fetchedBlob;
        mimeType = fetchedBlob.type || "audio/mpeg";
        sourcePath = "sw-fetch";
        emit("mp3cow/mp3-fetch-ok", { size: fetchedBlob.size, type: mimeType });
      }
    } catch (e) {
      swError = e;
      console.warn("[svdmusic-bg] MP3Cow SW fetch MP3 threw, falling back to page fetch", e);
      emit("mp3cow/mp3-fetch-invalid", {
        reason: String(e?.message || e),
      });
    }

    // Step 3: Page-context fetch (fallback when SW fetch fails).
    if (!blob) {
      console.log(
        "[svdmusic-bg] MP3Cow fallback: issuing fresh fetch from MAIN world of tab",
        tabId,
        "url=" + downloadURL
      );
      emit("mp3cow/mp3-fallback");
      let fbRaw;
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "MAIN",
          func: mp3cowFetchMain,
          args: [{ url: downloadURL }],
        });
        fbRaw = result;
      } catch (err) {
        throw new Error(
          "MP3COW_INJECT_FAILED (fallback): " + (err?.message || String(err))
        );
      }
      const fbCheck = unwrapInjectedResult(fbRaw);
      if (!fbCheck.ok) {
        throw makeMp3cowError(fbCheck.stage, fbCheck.message, fbCheck.status);
      }
      const fbPayload = fbCheck.value || {};
      if (!fbPayload.base64) {
        throw new Error("MP3COW_MP3_FETCH_FAILED: fallback trả về rỗng.");
      }
      const binary = atob(fbPayload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const fallbackMime = fbPayload.contentType || "audio/mpeg";
      const fallbackBlob = new Blob([bytes.buffer], { type: fallbackMime });
      const fakeRes = {
        ok: true,
        status: fbPayload.status || 200,
        headers: { get: (name) => (name && name.toLowerCase() === "content-type" ? fallbackMime : null) },
      };
      try {
        await validateMp3Blob({ res: fakeRes, blob: fallbackBlob, stage: "mp3cow/mp3-fallback" });
        console.log(
          "[svdmusic-bg] MP3Cow fallback blob validated OK (size=" +
            fallbackBlob.size +
            " type=" + fallbackMime +
            ")"
        );
        blob = fallbackBlob;
        mimeType = fallbackMime;
        sourcePath = "main-fallback";
        emit("mp3cow/mp3-fetch-ok", { size: fallbackBlob.size, type: mimeType });
      } catch (validationErr) {
        const err = new Error(
          "MP3COW_INVALID_AUDIO_BLOB (fallback): " +
            String(validationErr?.message || validationErr) +
            " size=" + fallbackBlob.size + " type=" + fallbackMime
        );
        err.httpStatus =
          typeof validationErr?.httpStatus === "number"
            ? validationErr.httpStatus
            : null;
        throw err;
      }
    }

    // Final guard: refuse to ship a tiny blob.
    if (!blob || blob.size < 100000) {
      const sz = blob ? blob.size : 0;
      throw new Error(
        "MP3COW_INVALID_AUDIO_BLOB (final-guard): size=" + sz +
          " type=" + (blob?.type || "?") +
          " sourcePath=" + (sourcePath || "?") +
          " — refusing to emit mp3/result."
      );
    }

    let firstBytesHex = "";
    try {
      const headBuf = await blob.slice(0, 4).arrayBuffer();
      const head = new Uint8Array(headBuf);
      firstBytesHex = Array.from(head)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } catch (_) { /* noop */ }
    console.log(
      "[svdmusic-bg] MP3Cow mp3 ready: size=" + blob.size +
        " type=" + (blob.type || "?") +
        " sourcePath=" + sourcePath +
        " first4bytes=[" + firstBytesHex + "]"
    );

    emit("mp3cow/mp3-ready");

    const arrayBuffer = await blob.arrayBuffer();
    return {
      arrayBuffer,
      mimeType: mimeType || "audio/mpeg",
      size: blob.size,
      title: apiTitle,
      duration: null,
      filesize: blob.size,
    };
  } finally {
    if (createdByBridge) await closeOwnedMp3cowTab(tabId);
  }
}

function makeMp3cowError(stage, message, httpStatus) {
  var err = new Error(stage + ": " + message);
  err.stage = stage;
  err.httpStatus = typeof httpStatus === "number" ? httpStatus : null;
  return err;
}

// Pings a freshly-opened Gemini tab until the content script responds or we
  // give up. Used by `ensureGeminiTab` for both fresh tabs and (historically)
  // reused tabs.
  //
  // We poll aggressively at first (50ms × 10 ticks) because in the happy
  // path the content script listener is registered within tens of
  // milliseconds and we want the first sendMessage to start the LRC job as
  // fast as possible. If the listener is still not ready after the fast
  // window we fall back to a slower 200ms poll so a pathological case
  // (e.g. the tab is mid-navigation) doesn't waste CPU but still completes
  // in <5s.
  async function pingGeminiTab(tab) {
    const fastPolls = 10; // 10 × 50ms = 500ms
    for (let attempt = 0; attempt < fastPolls; attempt += 1) {
      try {
        const ping = await chrome.tabs.sendMessage(tab.id, { type: "gemini/ping" });
        if (ping?.ok) return { tab, ready: true };
      } catch (_) { /* retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        const ping = await chrome.tabs.sendMessage(tab.id, { type: "gemini/ping" });
        if (ping?.ok) return { tab, ready: true };
      } catch (_) { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { tab, ready: false };
  }

  async function ensureGeminiTab() {
    // Mỗi lần tạo bài hát → luôn mở tab Gemini MỚI để tránh dính state cũ
    // (chat/prompt/model selection/composer state của phiên trước). KHÔNG
    // reuse tab cũ qua chrome.tabs.query({ url: `${GEMINI_ORIGIN}/*` }) nữa.
    const tab = await chrome.tabs.create({
      url: `${GEMINI_ORIGIN}/app`,
      active: true,
    });
    const { ready } = await pingGeminiTab(tab);
    if (!ready) {
      console.warn(
        "[svdmusic-bg] fresh Gemini tab did not respond to ping within ~5.5s; sending anyway"
      );
    }
    // Vẫn return tab để caller gửi message — sidepanel sẽ surface lỗi
    // sendMessage nếu content script thực sự không attach.
    return tab;
  }

// ── Global job lock via chrome.storage.local ──────────────────────────────────
//
// We can't trust sessionStorage inside the Gemini tab because the content
// script may attach multiple times (re-injection, navigation, devtools
// reload) and each invocation thinks it's the only one. The background
// service worker is the only thing that's guaranteed singleton per
// extension install, so we serialize jobs here.
//
// Shape: { jobId, videoId, startedAt, status: "running" | "done" | "failed" }
//
// In addition to the lock, every content-script instance connects to the
// background with a long-lived Port. If two content scripts exist (e.g.
// due to script re-injection), only the one whose Port registered first
// is allowed to publish progress — the rest are told to bail immediately.
// This is what kills the duplicate-log bug.

const CONTENT_PORT_NAME = "svdmusic.gemini.content";

async function readCurrentJob() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(LOCK_KEY, (data) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(data?.[LOCK_KEY] || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function writeCurrentJob(job) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [LOCK_KEY]: job }, () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function clearCurrentJob(jobId) {
  const current = await readCurrentJob();
  if (!current) return;
  if (jobId && current.jobId !== jobId) return; // not ours
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(LOCK_KEY, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

async function tryAcquireLock({ jobId, videoId }) {
  const current = await readCurrentJob();
  const now = Date.now();

  if (current && current.status === "running" && now - current.startedAt < LOCK_TTL_MS) {
    // Someone else is running. Reject.
    return { ok: false, current };
  }

  const next = {
    jobId,
    videoId: videoId || null,
    startedAt: now,
    status: "running",
  };
  const ok = await writeCurrentJob(next);
  if (!ok) return { ok: false, current: null };

  // Verify by re-reading. If a parallel call raced us, our write is now stale.
  const verify = await readCurrentJob();
  if (!verify || verify.jobId !== jobId) {
    return { ok: false, current: verify };
  }
  return { ok: true, current: next };
}

// ── Content-script port registry (kills duplicate logs) ─────────────────────
//
// Each content-script instance opens a Port on startup. We keep the FIRST
// port that announces a given jobId and reject any subsequent arrivals.
// The "winning" port is the only one allowed to publish progress / result /
// error back to the sidepanel.
//
// This is the second line of defence after the chrome.storage.local lock:
//   - storage lock stops two TABS from running the same job.
//   - port registry stops two INJECTIONS of the same content script in the
//     same tab from both publishing progress.
//
// When the port disconnects (tab navigates, content script is reloaded,
// page closes) we clear the entry. A new port that arrives later for the
// same jobId wins again — but only if the storage lock is still "running".
//
// We also remember the `sender` so the onMessage handler in this file can
// verify a message actually came from the registered port instead of a
// stray injection that didn't open a port.

const contentPortsByJob = new Map(); // jobId -> Set<{ port, sender }>

// MP3 download registry keyed by `correlationId`. The background OWNS
// every MP3 job end-to-end — the sidepanel just sends `mp3/start` to
// kick the job off, then listens on `chrome.runtime.onMessage` for
// `mp3/progress` and `mp3/result` events. There is NO Port on the
// MP3 pipeline anymore, so a sidepanel/modal unmount mid-conversion
// cannot break the download.
//
// Each entry: { videoId, youtubeUrl, status, controller, startedAt,
//   finishedAt, size, title, mimeType, error, keepUntil }
const mp3JobsByCorrelation = new Map();
// Index by videoId so we can de-dupe parallel requests for the same song.
const mp3JobIdByVideoId = new Map();

// How long a `ready` job stays de-dupable. After this window the entry
// is removed from both maps so a fresh request starts a new conversion
// instead of returning the stale bytes. Long enough to cover the common
// "user clicks 'Add song' twice within a few seconds" double-submit
// case, short enough that re-adding the same videoId later actually
// re-fetches the audio.
const MP3_READY_TTL_MS = 5 * 60 * 1000;
// Failed jobs stay around briefly so `mp3/status` can still report them
// to a freshly-mounted sidepanel that wants to know why nothing arrived,
// then they're gone.
const MP3_FAILED_TTL_MS = 30 * 1000;

function purgeMp3Job(correlationId, { alsoUnindex = true } = {}) {
  const job = mp3JobsByCorrelation.get(correlationId);
  if (!job) return;
  mp3JobsByCorrelation.delete(correlationId);
  if (alsoUnindex) {
    // Only clear the videoId index if it still points at THIS
    // correlationId — otherwise another, newer job has already taken
    // over the slot and we must not evict it.
    const indexed = mp3JobIdByVideoId.get(job.videoId);
    if (indexed === correlationId) mp3JobIdByVideoId.delete(job.videoId);
  }
}

function sweepMp3Jobs() {
  const now = Date.now();
  for (const [id, job] of mp3JobsByCorrelation.entries()) {
    if (job.keepUntil && job.keepUntil <= now) {
      purgeMp3Job(id, { alsoUnindex: true });
    }
  }
}

// GC the maps every minute. Chrome can leave a service worker alive for
// long stretches, so an interval is fine. We also sweep opportunistically
// at the end of runMp3Job so a quick second request doesn't see a
// just-stale entry.
if (typeof setInterval !== "undefined") {
  setInterval(sweepMp3Jobs, 60 * 1000).unref?.();
}

function emitMp3Event(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      void chrome.runtime?.lastError;
    });
  } catch (_) {
    // No listeners — fine, the job still completes in background.
  }
}

// Structured-clone serialization across chrome.runtime.sendMessage drops
// ArrayBuffer (it becomes {} on the receiver side, which silently turns
// into the 15-byte string "[object Object]" when wrapped in `new Blob()`).
// A 7 MB MP3 needs to round-trip to the sidepanel so it can write the
// bytes to IndexedDB; convert to base64 first, the receiver rebuilds
// the Uint8Array and verifies length against the advertised `size`.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // 32 KB chunks keep apply() under arg limits.

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    );
  }

  return btoa(binary);
}

function startMp3Job({ correlationId, videoId, youtubeUrl, geminiJobId = null }) {
  if (!correlationId) {
    return { ok: false, error: "Thiếu correlationId." };
  }
  if (!videoId) {
    return { ok: false, error: "Thiếu videoId." };
  }
  if (!youtubeUrl) {
    return { ok: false, error: "Thiếu youtubeUrl." };
  }

  // De-dupe theo videoId đang bị disable vì AddSongModal chưa biết cách
  // switch listener từ correlationId mới sang correlationId của job cũ —
  // event của job cũ bị listener mới bỏ qua, gây treo sidepanel.
  //
  // Mỗi lần sidepanel gọi mp3/start, luôn tạo job mới với correlationId
  // mới. Sau khi e2e MP3 pass ổn, mới làm lại de-dupe/replay.
  //
  // Code de-dupe cũ (giữ comment để dễ bật lại):
  //   const existingCorrelation = mp3JobIdByVideoId.get(videoId);
  //   if (existingCorrelation) {
  //     const existing = mp3JobsByCorrelation.get(existingCorrelation);
  //     if (existing) {
  //       const now = Date.now();
  //       const stillFresh = !existing.keepUntil || existing.keepUntil > now;
  //       if (existing.status === "running" || (existing.status === "ready" && stillFresh)) {
  //         return { ok: true, correlationId: existingCorrelation, deduplicated: true, status: existing.status };
  //       }
  //       if (!stillFresh) {
  //         purgeMp3Job(existingCorrelation, { alsoUnindex: false });
  //         mp3JobIdByVideoId.delete(videoId);
  //       }
  //     }
  //   }

  // Tuy nhiên vẫn cần dọn các job cũ "ready/failed" hết TTL của cùng
  // videoId để tránh leak map — không trả existingCorrelation về caller.
  const existingCorrelation = mp3JobIdByVideoId.get(videoId);
  if (existingCorrelation) {
    const existing = mp3JobsByCorrelation.get(existingCorrelation);
    if (existing) {
      const now = Date.now();
      const stillFresh = !existing.keepUntil || existing.keepUntil > now;
      if (!stillFresh || existing.status === "ready" || existing.status === "failed") {
        purgeMp3Job(existingCorrelation, { alsoUnindex: false });
        mp3JobIdByVideoId.delete(videoId);
      }
    }
  }

  const job = {
    correlationId,
    videoId,
    youtubeUrl,
    // ID của Gemini job đã sinh ra LRC cho videoId này — dùng để biết
    // Gemini tab nào cần dọn conversation khi MP3 xong.
    geminiJobId: geminiJobId || null,
    status: "running",
    controller: null,
    startedAt: Date.now(),
    finishedAt: 0,
    size: 0,
    title: "",
    mimeType: "audio/mpeg",
    error: null,
    // Numeric HTTP status for the terminal failure (when known). Used by
    // runMp3Job's catch block to forward `status` into the `mp3/error`
    // event so the sidepanel can map it to the spec-mandated user-facing
    // copy (HTTP 410 → "đã hết hạn", 429 → "đang giới hạn", ...).
    errorStatus: null,
  };
  mp3JobsByCorrelation.set(correlationId, job);
  mp3JobIdByVideoId.set(videoId, correlationId);

  // Kick the conversion off. We deliberately do NOT await — the function
  // is fire-and-forget so the kickoff message handler returns immediately.
  runMp3Job(job).catch((error) => {
    console.warn("[svdmusic-bg] mp3 job crashed", error);
  });

  return { ok: true, correlationId, status: "running" };
}

async function runMp3Job(job) {
  const { correlationId, videoId, youtubeUrl } = job;

  const emitProgress = (stage, info) => {
    emitMp3Event({
      type: "mp3/progress",
      correlationId,
      videoId,
      stage,
      progress: info && typeof info.progress === "number" ? info.progress : null,
    });
  };

  try {
    const result = await fetchMp3FromYt2mp3PageBridge(youtubeUrl, {
      onProgress: emitProgress,
    });
    job.size = result.size || 0;
    job.title = result.title || videoId;
    job.mimeType = result.mimeType || "audio/mpeg";
    job.filesize = typeof result.filesize === "number" ? result.filesize : job.size;
    job.duration = typeof result.duration === "number" ? result.duration : null;
    job.audioSource = "yt2mp3-page-bridge";
    job.finishedAt = Date.now();

    // Defence-in-depth: refuse to ship a too-small arrayBuffer to the
    // sidepanel. fetchMp3FromYt2mp3PageBridge already enforces 100 KB,
    // but if that ever regresses we want to catch it HERE before the
    // bytes leak into the IndexedDB write path.
    const byteLen = result.arrayBuffer ? result.arrayBuffer.byteLength : 0;
    if (!result.arrayBuffer || byteLen < 100000) {
      const reason =
        "runMp3Job: final arrayBuffer too small (" + byteLen + " bytes) — refusing to emit mp3/result";
      console.warn("[svdmusic-bg] " + reason);
      job.status = "failed";
      job.finishedAt = Date.now();
      job.keepUntil = job.finishedAt + MP3_FAILED_TTL_MS;
      job.error = reason;
      // A too-small body doesn't carry an HTTP status — keep `status`
      // null so the sidepanel falls back to the generic "không thể tải
      // MP3" copy via mapMp3ErrorToMessage(null, reason).
      job.errorStatus = null;
      emitMp3Event({
        type: "mp3/result-invalid",
        correlationId,
        videoId,
        size: byteLen,
        mimeType: job.mimeType,
        reason: reason,
        // No HTTP status applies here — the body itself was too small,
        // but we send `status: null` for shape consistency so the
        // sidepanel doesn't have to special-case missing keys.
        status: null,
      });
      emitMp3Event({
        type: "mp3/error",
        correlationId,
        videoId,
        error: reason,
        status: null,
      });
      return;
    }

    let headHex = "";
    try {
      const head = new Uint8Array(result.arrayBuffer, 0, Math.min(4, byteLen));
      headHex = Array.from(head)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } catch (_) { /* noop */ }
    console.log(
      "[svdmusic-bg] emitting mp3/result: size=" + byteLen +
        " type=" + job.mimeType +
        " videoId=" + videoId +
        " first4bytes=[" + headHex + "]"
    );

    job.status = "ready";
    job.keepUntil = job.finishedAt + MP3_READY_TTL_MS;

    // Sidepanel owns IndexedDB (MV3 service workers can't open IndexedDB
    // directly). We ship the audio bytes once via sendMessage — but
    // structured-clone serialization loses ArrayBuffer (it becomes {}
    // on the receiver, which a `new Blob([{}])` turns into the 15-byte
    // string "[object Object]"). We instead convert to base64 and the
    // sidepanel decodes back to Uint8Array, validating byteLength ===
    // size before persisting.
    const audioBase64 = arrayBufferToBase64(result.arrayBuffer);
    console.log(
      "[svdmusic-bg] emitting mp3/result: size=" + byteLen +
        " type=" + job.mimeType +
        " videoId=" + videoId +
        " audioBase64Len=" + audioBase64.length
    );

    emitMp3Event({
      type: "mp3/result",
      correlationId,
      videoId,
      mimeType: job.mimeType,
      size: job.size,
      title: job.title,
      filesize: job.filesize,
      duration: job.duration,
      audioSource: job.audioSource,
      audioBase64,
    });

    emitMp3Event({
      type: "mp3/ready",
      correlationId,
      videoId,
      audioKey: `audio:${videoId}`,
      size: job.size,
      title: job.title,
      mimeType: job.mimeType,
      filesize: job.filesize,
      duration: job.duration,
      audioSource: job.audioSource,
    });

    // Đã tải MP3 xong (bytes OK, sidepanel sẽ IndexedDB ngay sau) → báo
    // Gemini tab dọn conversation hiện tại (xoá chat vừa rồi). Best-effort:
    // nếu Gemini tab đã đóng/đổi jobId → bỏ qua, không throw.
    //
    // AddSongModal là nơi duy nhất biết khi nào IndexedDB save xong nhưng
    // ta không sửa nó. Cách thay thế: broadcast tới TẤT CẢ Gemini tabs
    // đang track — thực tế người dùng chỉ mở 1 Gemini tab/job tại 1 thời
    // điểm (đã enforce bằng global lock + ensureGeminiTab luôn tạo tab
    // mới). Cleanup là idempotent — tab nào nhận cũng chỉ dọn 1 lần.
    //
    // Diagnostic: log jobTabs state + each target tab URL, then forward
    // every sendMessage result (success/failure) to the sidepanel as a
    // progress event so the user can see why cleanup did or didn't run.
    try {
      const sentTabs = new Set();
      // Diagnostic snapshot of what we're about to dispatch to.
      const snapshot = {
        jobTabsSize: jobTabs.size,
        jobIds: Array.from(jobTabs.keys()),
        targetTabIds: [],
        targetUrls: {},
      };
      for (const tabIds of jobTabs.values()) {
        for (const tabId of tabIds) {
          snapshot.targetTabIds.push(tabId);
        }
      }
      console.log("[GeminiCleanupDispatch] about to dispatch", snapshot);
      try {
        chrome.runtime.sendMessage({
          type: "progress",
          payload: {
            message:
              "[GeminiCleanupDispatch] about to dispatch jobTabs=" +
              snapshot.jobTabsSize +
              " targets=[" + snapshot.targetTabIds.join(",") + "]",
            cleanup: true,
          },
        }, () => { void chrome.runtime?.lastError; });
      } catch (_) { /* sidepanel not open */ }

      for (const tabIds of jobTabs.values()) {
        for (const tabId of tabIds) {
          if (sentTabs.has(tabId)) continue;
          sentTabs.add(tabId);
          // Resolve the target tab URL up front so the diagnostic log is
          // accurate even if the tab goes away during the async send.
          let targetUrl = null;
          try {
            const t = await chrome.tabs.get(tabId);
            targetUrl = t?.url || null;
            snapshot.targetUrls[tabId] = targetUrl || "(no url)";
          } catch (_) {
            snapshot.targetUrls[tabId] = "(tab gone)";
          }
          console.log("[GeminiCleanupDispatch] target tab", {
            tabId,
            url: targetUrl,
          });
          try {
            chrome.runtime.sendMessage({
              type: "progress",
              payload: {
                message: "[GeminiCleanup] target tabId=" + tabId + " url=" + (targetUrl || "(unknown)"),
                cleanup: true,
              },
            }, () => { void chrome.runtime?.lastError; });
          } catch (_) { /* noop */ }
          // sendMessage is fire-and-forget but the callback receives the
          // response or chrome.runtime.lastError. We surface BOTH outcomes
          // — previously `void chrome.runtime?.lastError` silently swallowed
          // "Receiving end does not exist" which is exactly the symptom
          // users were hitting.
          chrome.tabs.sendMessage(
            tabId,
            {
              type: "svdmusic/cleanup-conversation",
              reason: "mp3-ready",
              correlationId,
              videoId,
            },
            (response) => {
              const err = chrome.runtime?.lastError?.message;
              if (err) {
                console.warn("[GeminiCleanupDispatch] send failed", { tabId, err });
                try {
                  chrome.runtime.sendMessage({
                    type: "progress",
                    payload: {
                      message:
                        "[GeminiCleanup] send cleanup to tab " + tabId +
                        " FAILED: " + err,
                      cleanup: true,
                    },
                  }, () => { void chrome.runtime?.lastError; });
                } catch (_) { /* noop */ }
                return;
              }
              console.log("[GeminiCleanupDispatch] send ok", { tabId, response });
              try {
                chrome.runtime.sendMessage({
                  type: "progress",
                  payload: {
                    message: "[GeminiCleanup] send cleanup to tab " + tabId + " OK",
                    cleanup: true,
                  },
                }, () => { void chrome.runtime?.lastError; });
              } catch (_) { /* noop */ }
            }
          );
        }
      }
    } catch (cleanupErr) {
      console.warn("[svdmusic-bg] dispatch cleanup-conversation failed:", cleanupErr);
      try {
        chrome.runtime.sendMessage({
          type: "progress",
          payload: {
            message:
              "[GeminiCleanupDispatch] dispatch threw: " +
              (cleanupErr?.message || String(cleanupErr)),
            cleanup: true,
          },
        }, () => { void chrome.runtime?.lastError; });
      } catch (_) { /* noop */ }
    }
  } catch (error) {
    job.finishedAt = Date.now();
    const errMsg = String(error?.message || error || "");
    // Three-tier HTTP status extraction:
    //   1. err.httpStatus (set by makeYt2mp3Error / validateMp3Blob)
    //   2. err.status (some lower-level fetches)
    //   3. regex scrape of errMsg (covers API trả HTTP 500. etc.)
    const httpStatus =
      Number(error?.httpStatus) ||
      Number(error?.status) ||
      extractHttpStatus(errMsg) ||
      0;

    // Decide whether the failure is one MP3Cow can recover from.
    // Covers: HTTP 410/429/403/404, 5xx, NO_LINK, invalid-audio, network
    // failures, message-level HTTP status, etc.
    const isFallbackEligible =
      httpStatus === 410 ||
      httpStatus === 429 ||
      httpStatus === 403 ||
      httpStatus === 404 ||
      (httpStatus >= 500 && httpStatus < 600) ||
      /NO_LINK/i.test(errMsg) ||
      /HTTP\s*(403|404|410|429|5\d\d)/i.test(errMsg) ||
      /API trả HTTP\s*(403|404|410|429|5\d\d)/i.test(errMsg) ||
      /invalid.*audio/i.test(errMsg) ||
      /non.*audio/i.test(errMsg) ||
      /size.*too.*small/i.test(errMsg) ||
      /YT2MP3_INVALID_AUDIO_BLOB/i.test(errMsg) ||
      /failed to fetch|network|download.*failed|fetch.*failed/i.test(errMsg);

    if (!isFallbackEligible) {
      // Unrecoverable error — surface it immediately without attempting MP3Cow.
      job.status = "failed";
      job.keepUntil = job.finishedAt + MP3_FAILED_TTL_MS;
      job.error = errMsg;
      job.errorStatus = httpStatus || null;
      console.warn(
        "[svdmusic-bg] yt2mp3 mp3 job failed (no fallback)",
        errMsg,
        httpStatus ? "(HTTP " + httpStatus + ")" : ""
      );
      emitMp3Event({
        type: "mp3/error",
        correlationId,
        videoId,
        error: errMsg,
        status: httpStatus || null,
      });
      return;
    }

    // Fallback: try MP3Cow page bridge.
    console.warn(
      "[svdmusic-bg] yt2mp3 mp3 job failed, switching to MP3Cow fallback:",
      errMsg,
      httpStatus ? "(HTTP " + httpStatus + ")" : ""
    );

    try {
      const mp3cowResult = await fetchMp3FromMp3cowPageBridge(youtubeUrl, {
        onProgress: emitProgress,
      });

      // Same processing as the happy path above.
      job.size = mp3cowResult.size || 0;
      job.title = mp3cowResult.title || videoId;
      job.mimeType = mp3cowResult.mimeType || "audio/mpeg";
      job.filesize = typeof mp3cowResult.filesize === "number" ? mp3cowResult.filesize : job.size;
      job.duration = typeof mp3cowResult.duration === "number" ? mp3cowResult.duration : null;
      job.audioSource = "mp3cow-page-bridge";
      job.finishedAt = Date.now();

      const byteLen = mp3cowResult.arrayBuffer ? mp3cowResult.arrayBuffer.byteLength : 0;
      if (!mp3cowResult.arrayBuffer || byteLen < 100000) {
        const reason =
          "runMp3Job: MP3Cow fallback final arrayBuffer too small (" + byteLen + " bytes)";
        console.warn("[svdmusic-bg] " + reason);
        job.status = "failed";
        job.finishedAt = Date.now();
        job.keepUntil = job.finishedAt + MP3_FAILED_TTL_MS;
        job.error = reason;
        job.errorStatus = null;
        emitMp3Event({
          type: "mp3/result-invalid",
          correlationId,
          videoId,
          size: byteLen,
          mimeType: job.mimeType,
          reason: reason,
          status: null,
        });
        emitMp3Event({
          type: "mp3/error",
          correlationId,
          videoId,
          error: reason,
          status: null,
        });
        return;
      }

      let headHex = "";
      try {
        const head = new Uint8Array(mp3cowResult.arrayBuffer, 0, Math.min(4, byteLen));
        headHex = Array.from(head)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
      } catch (_) { /* noop */ }
      console.log(
        "[svdmusic-bg] MP3Cow emitting mp3/result: size=" + byteLen +
          " type=" + job.mimeType +
          " videoId=" + videoId +
          " first4bytes=[" + headHex + "]"
      );

      job.status = "ready";
      job.keepUntil = job.finishedAt + MP3_READY_TTL_MS;

      const audioBase64 = arrayBufferToBase64(mp3cowResult.arrayBuffer);

      emitMp3Event({
        type: "mp3/result",
        correlationId,
        videoId,
        mimeType: job.mimeType,
        size: job.size,
        title: job.title,
        filesize: job.filesize,
        duration: job.duration,
        audioSource: job.audioSource,
        audioBase64,
      });

      emitMp3Event({
        type: "mp3/ready",
        correlationId,
        videoId,
        audioKey: `audio:${videoId}`,
        size: job.size,
        title: job.title,
        mimeType: job.mimeType,
        filesize: job.filesize,
        duration: job.duration,
        audioSource: job.audioSource,
      });

      // Gemini cleanup dispatch (same as happy path).
      try {
        const sentTabs = new Set();
        const snapshot = {
          jobTabsSize: jobTabs.size,
          jobIds: Array.from(jobTabs.keys()),
          targetTabIds: [],
          targetUrls: {},
        };
        for (const tabIds of jobTabs.values()) {
          for (const tabId of tabIds) {
            snapshot.targetTabIds.push(tabId);
          }
        }
        console.log("[GeminiCleanupDispatch] about to dispatch", snapshot);
        try {
          chrome.runtime.sendMessage({
            type: "progress",
            payload: {
              message:
                "[GeminiCleanupDispatch] about to dispatch jobTabs=" +
                snapshot.jobTabsSize +
                " targets=[" + snapshot.targetTabIds.join(",") + "]",
              cleanup: true,
            },
          }, () => { void chrome.runtime?.lastError; });
        } catch (_) { /* sidepanel not open */ }

        for (const tabIds of jobTabs.values()) {
          for (const tabId of tabIds) {
            if (sentTabs.has(tabId)) continue;
            sentTabs.add(tabId);
            let targetUrl = null;
            try {
              const t = await chrome.tabs.get(tabId);
              targetUrl = t?.url || null;
              snapshot.targetUrls[tabId] = targetUrl || "(no url)";
            } catch (_) {
              snapshot.targetUrls[tabId] = "(tab gone)";
            }
            chrome.tabs.sendMessage(
              tabId,
              {
                type: "svdmusic/cleanup-conversation",
                reason: "mp3-ready",
                correlationId,
                videoId,
              },
              () => { void chrome.runtime?.lastError; }
            );
          }
        }
      } catch (_) { /* noop */ }
      return;
    } catch (mp3cowError) {
      // MP3Cow also failed — this is the terminal failure.
      job.status = "failed";
      job.finishedAt = Date.now();
      job.keepUntil = job.finishedAt + MP3_FAILED_TTL_MS;
      job.error = mp3cowError?.message || String(mp3cowError);
      job.errorStatus =
        typeof mp3cowError?.httpStatus === "number" ? mp3cowError.httpStatus : null;
      console.warn(
        "[svdmusic-bg] MP3Cow fallback failed",
        job.error,
        job.errorStatus != null ? "(HTTP " + job.errorStatus + ")" : ""
      );
      emitMp3Event({
        type: "mp3/error",
        correlationId,
        videoId,
        error: job.error,
        status: job.errorStatus,
      });
    }
  } finally {
    // Opportunistic GC: a quick follow-up request for the same videoId
    // shouldn't have to wait for the 60s interval tick to clear a
    // long-expired entry.
    sweepMp3Jobs();
  }
}

function cancelMp3Job({ correlationId, videoId }) {
  const id = correlationId || (videoId && mp3JobIdByVideoId.get(videoId)) || null;
  if (!id) return { ok: true, cancelled: false };
  const job = mp3JobsByCorrelation.get(id);
  if (!job) return { ok: true, cancelled: false };
  if (job.status === "running") {
    job.status = "cancelled";
    job.finishedAt = Date.now();
  }
  return { ok: true, cancelled: true, status: job.status };
}

function getMp3JobStatus({ correlationId, videoId }) {
  const id = correlationId || (videoId && mp3JobIdByVideoId.get(videoId)) || null;
  if (!id) {
    return { ok: true, found: false };
  }
  const job = mp3JobsByCorrelation.get(id);
  if (!job) {
    return { ok: true, found: false };
  }
  return {
    ok: true,
    found: true,
    correlationId: job.correlationId,
    videoId: job.videoId,
    status: job.status,
    size: job.size,
    title: job.title,
    mimeType: job.mimeType,
    audioKey: `audio:${job.videoId}`,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    errorStatus: job.errorStatus ?? null,
  };
}

function registerContentPort(port, jobId, sender) {
  if (!jobId) return { allowed: false, reason: "no-job-id" };
  const existing = contentPortsByJob.get(jobId);
  if (existing && existing.size > 0) {
    // Tell the loser to shut up.
    try { port.postMessage({ type: "svdmusic/bail", reason: "duplicate-port" }); } catch (_) { /* noop */ }
    return { allowed: false, reason: "duplicate-port" };
  }
  const set = new Set();
  set.add({ port, sender: sender || null });
  contentPortsByJob.set(jobId, set);
  port.onDisconnect.addListener(() => {
    const s = contentPortsByJob.get(jobId);
    if (!s) return;
    for (const entry of Array.from(s)) {
      if (entry.port === port) s.delete(entry);
    }
    if (s.size === 0) contentPortsByJob.delete(jobId);
  });
  return { allowed: true };
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port?.name) return;
  if (port.name === CONTENT_PORT_NAME) {
    // chrome doesn't expose sender via onConnect in older versions; we read
    // it from the well-known property available in MV3.
    const sender = port.sender || null;
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "svdmusic/hello") {
        const result = registerContentPort(port, msg.jobId || null, sender);
        if (result.allowed) {
          try { port.postMessage({ type: "svdmusic/welcome", jobId: msg.jobId }); } catch (_) { /* noop */ }
        }
      }
    });
    return;
  }
  // No MP3 Port handler anymore — MP3 jobs are owned by the background
  // and stream progress/result events through chrome.runtime.sendMessage.
});

/**
 * Recover from "Could not establish connection. Receiving end does not
 * exist." errors by re-attaching the Gemini content script.
 *
 * Background case:
 *   1. `ensureGeminiTab` pinged content script and got `{ok:true}` — the
 *      script was alive at that moment.
 *   2. Right after, the user (or Chrome) reloaded the tab, navigated
 *      cross-document, or the service worker was restarted with stale
 *      `contentPortsByJob` entries. Chrome tears down content scripts
 *      without notifying us.
 *   3. `chrome.tabs.sendMessage` now rejects because there's no
 *      listener. Returning the opaque error to the sidepanel forces the
 *      user to refresh the tab manually, which is a poor UX for a
 *      one-shot "Add song" flow.
 *
 * Recovery ladder (each step is bounded so a pathological tab can't
 * stall the sidepanel):
 *   - **Step 1**: poll `gemini/ping` for ~600ms. If the script is alive
 *     but the message channel was momentarily busy (e.g. mid-
 *     navigation), this is enough to land on the next tick.
 *   - **Step 2**: if Step 1 fails, drop any stale port entries for the
 *     current `jobId` (a re-injected content script would otherwise be
 *     rejected as a `duplicate-port` by `registerContentPort`) and
 *     re-inject `gemini-content.js` via `chrome.scripting.executeScript`.
 *   - **Step 3**: poll `gemini/ping` for ~1.5s waiting for the fresh
 *     listener to register.
 *
 * Returns `true` if the content script appears responsive again, else
 * `false` so the caller can fall back to the original "tải lại tab"
 * error message.
 */
async function tryRecoverGeminiContentScript(tabId, jobId) {
  // Step 1: short ping window for transient races.
  for (let i = 0; i < 3; i += 1) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "gemini/ping" });
      if (ping?.ok) {
        console.log("[svdmusic-bg] Gemini content script recovered via ping (tabId=" + tabId + ")");
        return true;
      }
    } catch (_) { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Step 2: drop any stale port entry and re-inject the content script.
  // We deliberately only evict when the port appears orphaned (no
  // `sender` reachable, or the underlying connection is already
  // disconnected) so a healthy concurrent job isn't disrupted. Cheapest
  // signal: just clear the Set — Chrome will silently drop the next
  // message on a closed port, and `registerContentPort` will accept the
  // re-injected script.
  const stale = contentPortsByJob.get(jobId);
  if (stale && stale.size > 0) {
    console.warn(
      "[svdmusic-bg] dropping " + stale.size + " stale port(s) for jobId=" +
        jobId + " before re-injecting Gemini content script"
    );
    contentPortsByJob.delete(jobId);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["gemini-content.js"],
    });
    console.log("[svdmusic-bg] re-injected gemini-content.js into tabId=" + tabId);
  } catch (scriptErr) {
    console.warn(
      "[svdmusic-bg] executeScript(gemini-content.js) failed for tabId=" + tabId + ":",
      scriptErr?.message || scriptErr
    );
    return false;
  }

  // Step 3: poll for the fresh listener.
  for (let i = 0; i < 5; i += 1) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "gemini/ping" });
      if (ping?.ok) {
        console.log("[svdmusic-bg] Gemini content script recovered via re-inject (tabId=" + tabId + ")");
        return true;
      }
    } catch (_) { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function reply(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (error) {
    console.warn("[svdmusic-bg] sendResponse failed", error);
  }
}

// ── Sidepanel ↔ standalone view-mode plumbing ─────────────────────────
//
// The two views of the player coordinate via chrome.runtime messages
// routed through this service worker. The state we keep here is just
// `standaloneTabId` — the SW is the only place that knows "is the
// standalone tab currently alive?", because it gets the
// `chrome.tabs.onRemoved` event regardless of which view triggered it.
//
// All call sites use chrome.storage.session (origin-scoped, not
// persistent) so the data dies with the browser session — exactly what
// we want for runtime view-mode bookkeeping.
let standaloneTabId = null;

function setStandaloneTabId(tabId) {
  standaloneTabId = typeof tabId === "number" ? tabId : null;
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      if (standaloneTabId) {
        chrome.storage.session.set({ "svdmusic.standaloneTabId": standaloneTabId }, () => { /* ignore */ });
      } else {
        chrome.storage.session.remove("svdmusic.standaloneTabId", () => { /* ignore */ });
      }
    }
  } catch (_) { /* noop */ }
}

function setStandaloneWindowId(windowId) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      if (typeof windowId === "number") {
        chrome.storage.session.set({ "svdmusic.standaloneWindowId": windowId }, () => { /* ignore */ });
      } else {
        chrome.storage.session.remove("svdmusic.standaloneWindowId", () => { /* ignore */ });
      }
    }
  } catch (_) { /* noop */ }
}

function setOriginWindowId(windowId) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      if (typeof windowId === "number") {
        chrome.storage.session.set({ "svdmusic.originWindowId": windowId }, () => { /* ignore */ });
      } else {
        chrome.storage.session.remove("svdmusic.originWindowId", () => { /* ignore */ });
      }
    }
  } catch (_) { /* noop */ }
}

async function openStandalonePopup({ url, originWindowId }) {
  // Popup: chrome.windows.create({ type: 'popup' }) — no URL bar, no tab strip.
  if (!url || typeof chrome === "undefined" || !chrome.windows?.create) {
    return { ok: false, error: "windows.create unavailable" };
  }
  try {
    // Always open at full screen so the player surface isn't constrained
    // by a hardcoded size. Chrome's `state: "maximized"` lets the OS
    // choose the work area; the popup grows to fill it on every monitor.
    const win = await chrome.windows.create({
      url,
      type: "popup",
      state: "maximized",
      focused: true,
    });
    if (!win?.id) return { ok: false, error: "windows.create returned no id" };

    const popupWindowId = win.id;
    const popupTabId = win.tabs?.[0]?.id ?? null;

    setStandaloneWindowId(popupWindowId);
    if (popupTabId != null) setStandaloneTabId(popupTabId);
    if (typeof originWindowId === "number") setOriginWindowId(originWindowId);

    return {
      ok: true,
      standaloneWindowId: popupWindowId,
      standaloneTabId: popupTabId,
    };
  } catch (err) {
    console.warn("[svdmusic-bg] openStandalonePopup failed", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function closeStandalonePopup(windowId, sender) {
  // Resolve the target window ID with a fallback chain so this function
  // works whether it's called from the popup, the sidepanel, or after the
  // popup's `pagehide` has already torn down its tab reference.
  let messageWindowId = Number.isInteger(windowId) ? windowId : null;
  let senderWindowId = Number.isInteger(sender?.tab?.windowId)
    ? sender.tab.windowId
    : null;
  let storedWindowId = null;
  try {
    const s = await chrome.storage.session.get("svdmusic.standaloneWindowId");
    if (Number.isInteger(s?.["svdmusic.standaloneWindowId"])) {
      storedWindowId = s["svdmusic.standaloneWindowId"];
    }
  } catch (_) { /* noop */ }

  const targetWindowId = messageWindowId ?? senderWindowId ?? storedWindowId;

  // Read originWindowId so we can refuse to close the origin window if the
  // chain above accidentally resolved to it (defensive — messages from the
  // popup should always carry the correct id).
  let originWindowId = null;
  try {
    const s = await chrome.storage.session.get("svdmusic.originWindowId");
    if (Number.isInteger(s?.["svdmusic.originWindowId"])) {
      originWindowId = s["svdmusic.originWindowId"];
    }
  } catch (_) { /* noop */ }

  const log = {
    messageWindowId,
    senderWindowId,
    storedWindowId,
    targetWindowId,
    originWindowId,
  };
  console.log("[SW] CLOSE_STANDALONE_POPUP", log);

  if (!Number.isInteger(targetWindowId)) {
    return { ok: false, error: "no popup windowId available" };
  }
  // Never close the origin Chrome window — that would kill the browser tab
  // the user is working in. popupWindowId must be a popup, not a normal
  // browser window.
  if (Number.isInteger(originWindowId) && targetWindowId === originWindowId) {
    return { ok: false, error: "refusing to close origin window" };
  }

  // Validate that the window still exists and is a popup. We fetch and
  // inspect type before removing so we don't blindly close a normal
  // Chrome window if a different windowId resolves.
  let win;
  try {
    win = await chrome.windows.get(targetWindowId);
  } catch (err) {
    return { ok: false, error: `windows.get failed: ${err?.message || err}` };
  }
  if (!win) {
    return { ok: false, error: "window not found" };
  }
  if (win.type !== "popup") {
    return {
      ok: false,
      error: `window type is "${win.type}", not popup — refusing to close`,
    };
  }

  if (typeof chrome === "undefined" || !chrome.windows?.remove) {
    return { ok: false, error: "windows.remove unavailable" };
  }
  try {
    await chrome.windows.remove(targetWindowId);
    // Do NOT clear svdmusic.standaloneWindowId here — it is a job for
    // chrome.windows.onRemoved so the listener fires only if removal
    // actually happened (and so a stale message can't wipe state).
    console.log("[SW] POPUP_REMOVED", { targetWindowId });
    return { ok: true, removedWindowId: targetWindowId };
  } catch (err) {
    console.warn("[svdmusic-bg] closeStandalonePopup failed", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function closeStandaloneTab(tabId) {
  const target = typeof tabId === "number" ? tabId : standaloneTabId;
  if (!target || typeof chrome === "undefined" || !chrome.tabs?.remove) {
    return { ok: false, error: "no target tab" };
  }
  try {
    await chrome.tabs.remove(target);
    // The chrome.tabs.onRemoved listener above will clear standaloneTabId
    // and broadcast player/standalone-closed. No need to do it here.
    return { ok: true };
  } catch (err) {
    console.warn("[svdmusic-bg] closeStandaloneTab failed", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function closeSidepanelWindow(windowId) {
  if (!windowId || typeof chrome === "undefined" || !chrome.sidePanel?.close) {
    return { ok: false, error: "sidePanel.close unavailable or no windowId" };
  }
  try {
    await chrome.sidePanel.close({ windowId });
    return { ok: true };
  } catch (err) {
    console.warn("[svdmusic-bg] closeSidepanelWindow failed", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function openSidepanelWindow(windowId) {
  if (!windowId || typeof chrome === "undefined" || !chrome.sidePanel?.open) {
    return { ok: false, error: "sidePanel.open unavailable or no windowId" };
  }
  try {
    console.log("[SW] SIDEPANEL_OPEN_REQUESTED", { windowId });
    // Note: chrome.sidePanel.open requires a user gesture. The click
    // handler in the standalone page is responsible for routing this
    // call through the user-gesture window. As a fallback we still try
    // here so an automatic recovery flow (e.g. sidepanel closed by
    // another path) can re-open without a click.
    await chrome.sidePanel.open({ windowId });
    console.log("[SW] SIDEPANEL_OPEN_RESOLVED", { windowId });
    return { ok: true };
  } catch (err) {
    console.warn("[svdmusic-bg] openSidepanelWindow failed", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  // ── Debug breadcrumb for all `player/*` messages (2026-07-14) ─────
  // Helps verify whether the popup successfully reaches the SW. Logs only
  // when the type starts with "player/" so background noise is unchanged.
  if (typeof message.type === "string" && message.type.startsWith("player/")) {
    try {
      console.log("[SW] PLAYER_MESSAGE_RECEIVED", {
        type: message.type,
        transferId: message.transferId ?? null,
        standaloneWindowId: message.standaloneWindowId ?? null,
        originWindowId: message.originWindowId ?? null,
        url: message.url ?? null,
        windowId: message.windowId ?? null,
        senderTabId: sender?.tab?.id ?? null,
        senderWindowId: sender?.tab?.windowId ?? null,
        senderUrl: sender?.tab?.url ?? null,
        hasResponse: typeof sendResponse === "function",
      });
    } catch (_) { /* noop */ }
  }

  // ── View-mode messages (sidepanel ↔ standalone popup) ───────────────
  if (message.type === "player/standalone-opened") {
    (async () => {
      const result = await openStandalonePopup({
        url: message.url,
        originWindowId: message.originWindowId,
      });
      reply(sendResponse, result);
    })();
    return true;
  }
  if (message.type === "player/close-standalone-popup") {
    (async () => {
      try {
        const result = await closeStandalonePopup(message.standaloneWindowId, sender);
        reply(sendResponse, result);
      } catch (err) {
        reply(sendResponse, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }
  if (message.type === "player/sidepanel-close") {
    (async () => {
      const result = await closeSidepanelWindow(message.windowId);
      reply(sendResponse, result);
    })();
    return true;
  }
  if (message.type === "player/sidepanel-open") {
    (async () => {
      console.log("[SW] SIDEPANEL_OPEN_REQUESTED", {
        windowId: message.windowId,
        transferId: message.transferId ?? null,
        senderTabId: sender?.tab?.id ?? null,
        senderWindowId: sender?.tab?.windowId ?? null,
        senderUrl: sender?.tab?.url ?? null,
      });
      const result = await openSidepanelWindow(message.windowId);
      reply(sendResponse, result);
    })();
    return true;
  }
  // ── View-mode READY messages ─────────────────────────────────────────
  // player/standalone-ready: standalone tab → SW → forwarded to source sidepanel.
  // player/sidepanel-ready: sidepanel → SW → forwarded to source standalone.
  // These carry transferId for the structured handshake.
  if (message.type === "player/standalone-ready") {
    (async () => {
      // Forward to the source sidepanel context via BroadcastChannel relay.
      // The source App.jsx also listens for this via chrome.runtime.onMessage
      // and via the storage.onChanged listener (activeViewTransfer update).
      // Best-effort: just reply ok; the source already gets this via the
      // storage change and the App's BroadcastChannel handler.
      console.log("[SW] standalone-ready received", message.transferId);
      reply(sendResponse, { ok: true });
    })();
    return true;
  }
  if (message.type === "player/sidepanel-ready") {
    (async () => {
      console.log("[SW] sidepanel-ready received", message.transferId);
      reply(sendResponse, { ok: true });
    })();
    return true;
  }
  if (message.type === "player/standalone-closed") {
    // Legacy: user closed standalone tab. Clean up transfer metadata.
    reply(sendResponse, { ok: true });
    return false;
  }

  // --- Sidepanel → background → content script ---
  if (message.type === "gemini/start-lrc" || message.type === "gemini/continue") {
    (async () => {
      try {
        const { jobId, correlationId, prompt, videoId } = message;
        if (!jobId) {
          reply(sendResponse, { ok: false, error: "Thiếu jobId." });
          return;
        }
        const lock = await tryAcquireLock({ jobId, videoId });
        if (!lock.ok) {
          reply(sendResponse, {
            ok: false,
            error: "Đã có một phiên Gemini đang chạy (jobId=" + (lock.current?.jobId || "?") + "). Vui lòng đợi phiên hiện tại hoàn tất hoặc hủy trước khi bắt đầu phiên mới.",
            lockedBy: lock.current?.jobId || null,
          });
          return;
        }
        const tab = await ensureGeminiTab();
        if (!tab?.id) {
          await clearCurrentJob(jobId);
          reply(sendResponse, { ok: false, error: "Không mở được tab Gemini." });
          return;
        }
        trackGeminiTab(jobId, tab.id);
        // Forward to the content script. The content script tags the
        // job with the same jobId so it can self-identify whether it
        // should run or bail.
        //
        // We wrap this in try/catch because `ensureGeminiTab` may
        // still return a tab whose content script hasn't finished
        // attaching (e.g. extension was reloaded while the Gemini tab
        // was idle — Chrome tears down the content script instance
        // and re-injects it asynchronously). Without this catch the
        // rejection bubbles up as the opaque
        // "Could not establish connection. Receiving end does not
        // exist." message and the user just sees a generic failure.
        try {
          await chrome.tabs.sendMessage(tab.id, {
            ...message,
            tabId: tab.id,
            jobId,
            correlationId,
          });
          reply(sendResponse, { ok: true, tabId: tab.id, jobId });
        } catch (sendErr) {
          const reason = String(sendErr?.message || sendErr);
          console.warn(
            "[svdmusic-bg] sendMessage to Gemini content script failed for tabId=" +
              tab.id +
              ":",
            reason
          );
          // Recovery: the content script listener may have been torn down
          // by Chrome (tab reload, cross-document nav, service worker
          // restart). Try ping → re-inject → ping before giving up so the
          // user doesn't have to manually refresh the tab.
          let recovered = false;
          try {
            recovered = await tryRecoverGeminiContentScript(tab.id, jobId);
          } catch (recoverErr) {
            console.warn(
              "[svdmusic-bg] recovery ladder failed for tabId=" + tab.id + ":",
              recoverErr?.message || recoverErr
            );
          }
          if (recovered) {
            try {
              await chrome.tabs.sendMessage(tab.id, {
                ...message,
                tabId: tab.id,
                jobId,
                correlationId,
              });
              reply(sendResponse, { ok: true, tabId: tab.id, jobId });
              return;
            } catch (resendErr) {
              // Even after recovery the message channel refused — fall
              // through to the original error so the user sees a clear
              // explanation instead of a silent stuck spinner.
              console.warn(
                "[svdmusic-bg] resend after recovery still failed for tabId=" +
                  tab.id +
                  ":",
                resendErr?.message || resendErr
              );
            }
          }
          await clearCurrentJob(jobId);
          reply(sendResponse, {
            ok: false,
            error:
              "Không liên lạc được với content script trong tab Gemini (tabId=" +
              tab.id +
              "). Hãy tải lại tab Gemini hoặc extension rồi thử lại. Chi tiết: " +
              reason,
          });
        }
        return;
      } catch (error) {
        console.warn("[svdmusic-bg] start-lrc failed", error);
        try {
          await clearCurrentJob(message.jobId);
        } catch (_) { /* noop */ }
        reply(sendResponse, { ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === "gemini/cancel") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: `${GEMINI_ORIGIN}/*` });
        await Promise.allSettled(
          tabs.map((tab) =>
            tab.id
              ? chrome.tabs.sendMessage(tab.id, { ...message }).catch(() => null)
              : null
          )
        );
        await clearCurrentJob(message.jobId);
        // Drop any port still associated with this job.
        const ports = contentPortsByJob.get(message.jobId);
        if (ports) {
          for (const entry of ports) {
            try { entry.port.disconnect(); } catch (_) { /* noop */ }
          }
          contentPortsByJob.delete(message.jobId);
        }
        jobTabs.delete(message.jobId);
        reply(sendResponse, { ok: true });
      } catch (error) {
        reply(sendResponse, { ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  // Force-reset the global job lock. The user invokes this when they have
  // closed every Gemini tab but the lock from a previous run is still
  // present in chrome.storage.local. We only clear the storage entry and
  // drop the port registry for that jobId; live jobs in other tabs are not
  // affected (different jobId).
  if (message.type === "gemini/force-reset-lock") {
    (async () => {
      try {
        const jobId = message.jobId || (await readCurrentJob())?.jobId || null;
        if (!jobId) {
          reply(sendResponse, { ok: true, cleared: false });
          return;
        }
        await clearCurrentJob(jobId);
        const ports = contentPortsByJob.get(jobId);
        if (ports) {
          for (const entry of ports) {
            try { entry.port.disconnect(); } catch (_) { /* noop */ }
          }
          contentPortsByJob.delete(jobId);
        }
        jobTabs.delete(jobId);
        reply(sendResponse, { ok: true, cleared: true, jobId });
      } catch (error) {
        reply(sendResponse, { ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  // Inspect the current lock state so the sidepanel can show "đang chạy"
  // or "không có phiên nào".
  if (message.type === "gemini/inspect-lock") {
    (async () => {
      try {
        const current = await readCurrentJob();
        if (!current) {
          reply(sendResponse, { ok: true, locked: false });
          return;
        }
        const ageMs = Date.now() - (current.startedAt || 0);
        const stale = ageMs >= LOCK_TTL_MS;
        reply(sendResponse, {
          ok: true,
          locked: !stale && current.status === "running",
          stale,
          jobId: current.jobId,
          videoId: current.videoId,
          status: current.status,
          ageMs,
        });
      } catch (error) {
        reply(sendResponse, { ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  // --- Content script → background → sidepanel ---
  // Re-emit so the sidepanel's onMessage listener picks up the same shape.
  //
  // De-duplication: we never compare `sender` objects (they're not stable
  // across calls). Instead we check the port registry built up by
  // chrome.runtime.onConnect — only the "winning" content-script port is
  // allowed to forward. Any other sender for the same jobId is dropped.
  if (
    sender.tab &&
    isGeminiUrl(sender.tab?.url) &&
    (message.type === "progress" || message.type === "lrc-ready" || message.type === "error")
  ) {
    (async () => {
      try {
        const current = await readCurrentJob();
        const jobId = message.jobId || current?.jobId;
        if (!jobId) {
          console.log("[svdmusic-bg] DROPPING message without jobId");
          return;
        }
        if (current && current.jobId && current.jobId !== jobId) {
          console.log(
            "[svdmusic-bg] DROPPING stale message from jobId=" +
              message.jobId + " (current=" + current.jobId + ")"
          );
          return;
        }

        // Port-registry check: if we have a registered port for this jobId
        // it must match the sender's tab + frameId. Otherwise this message
        // comes from a duplicate injection that didn't open a port (e.g.
        // a stale script instance) and must be dropped.
        const ports = contentPortsByJob.get(jobId);
        if (ports && ports.size > 0) {
          let matchesRegistered = false;
          for (const p of ports) {
            const ps = p.sender || {};
            if (
              ps.tab &&
              ps.tab.id === sender.tab.id &&
              (ps.frameId ?? 0) === (sender.frameId ?? 0)
            ) {
              matchesRegistered = true;
              break;
            }
          }
          if (!matchesRegistered) {
            console.log(
              "[svdmusic-bg] DROPPING message from non-registered sender " +
                "tab=" + sender.tab.id + " frame=" + sender.frameId +
                " jobId=" + jobId
            );
            return;
          }
        }

        // On terminal events (lrc-ready, error) clear the lock so the next
        // job can start.
        if (message.type === "lrc-ready") {
          await clearCurrentJob(jobId);
        } else if (message.type === "error") {
          await clearCurrentJob(jobId);
        }
        chrome.runtime.sendMessage(message).catch(() => {
          void chrome.runtime?.lastError;
        });
      } catch (error) {
        console.warn("[svdmusic-bg] forward failed", error);
      }
    })();
    return false;
  }

  // Health check used by ensureGeminiTab.
  if (message.type === "gemini/ping") {
    reply(sendResponse, { ok: true });
    return true;
  }

  // --- MP3 pipeline (background-owned, fire-and-forget) ---
  //
  // Sidepanel sends ONE of:
  //   { type: "mp3/start", correlationId, videoId, youtubeUrl }
  //     -> kicks off a conversion job. Background returns immediately.
  //        Progress / result / error events arrive later via
  //        chrome.runtime.sendMessage broadcasts.
  //   { type: "mp3/cancel", correlationId?, videoId? }
  //     -> marks a running job as cancelled (next emit becomes
  //        "mp3/cancelled"). Best-effort.
  //   { type: "mp3/status", correlationId?, videoId? }
  //     -> returns the current job state so the sidepanel can recover
  //        after unmount or sync UI on remount.
  if (message.type === "mp3/start") {
    (async () => {
      try {
        const result = startMp3Job({
          correlationId: message.correlationId,
          videoId: message.videoId,
          youtubeUrl: message.youtubeUrl,
          // geminiJobId là jobId của Gemini LRC đã hoàn tất cho cùng
          // videoId — dùng để map ngược về tab Gemini cần dọn conversation
          // khi MP3 sẵn sàng. Optional.
          geminiJobId: message.geminiJobId || null,
        });
        reply(sendResponse, result);
      } catch (error) {
        reply(sendResponse, { ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === "mp3/cancel") {
    reply(sendResponse, cancelMp3Job({
      correlationId: message.correlationId,
      videoId: message.videoId,
    }));
    return true;
  }

  if (message.type === "mp3/status") {
    reply(sendResponse, getMp3JobStatus({
      correlationId: message.correlationId,
      videoId: message.videoId,
    }));
    return true;
  }

  // ── Gemini API (ShopAIKey) handler ────────────────────────────────────────
  // Proxies LRC generation through the ShopAIKey API so the API key stays
  // in extension storage and no Gemini tab is opened.
  //
  // ShopAIKey exposes Google's GenAI Native Format at
  //   POST https://api.shopaikey.com/v1beta/models/{model}:generateContent
  // with `Authorization: Bearer <token>`.
  //
  // Request:  { type:"gemini-api/generate-lrc", correlationId, videoId, youtubeUrl }
  // Response: { ok, error?, lrcText?, lrcFormat?, timestampLineCount? }
  //
  // DISABLED: switched back to Gemini Web UI only. Keep the handler in
  // source for reference / quick re-enable, but early-return if a stale
  // call still hits this listener.
  const ENABLE_GEMINI_API_MODE = false;

  if (message.type === "gemini-api/generate-lrc") {
    if (!ENABLE_GEMINI_API_MODE) {
      console.warn("[gemini-api] disabled — dropping generate-lrc (use Gemini Web UI)");
      reply(sendResponse, {
        ok: false,
        error: "Gemini API mode đã bị tắt. Hãy dùng Gemini Web UI mode.",
      });
      return;
    }
    (async () => {
      try {
        const { correlationId, videoId, youtubeUrl } = message;
        console.log("[gemini-api] received generate-lrc, correlationId=" + correlationId);

        // Helper: emit a progress event to the sidepanel.
        function emitProgress(type, payload) {
          try {
            chrome.runtime.sendMessage({
              type,
              correlationId,
              ...(payload || {}),
            });
          } catch (_) { /* noop */ }
        }

        // 1) Read API key from storage. Trim aggressively — masked/dirty
        // values will break the Bearer header.
        const apiKey = String(
          (await new Promise((res) => {
            chrome.storage.local.get("svdmusic:geminiApiKey", (d) => {
              res((d && d["svdmusic:geminiApiKey"]) || "");
            });
          })) || ""
        ).trim();
        console.log("[gemini-api] API key present:", !!apiKey, "length:", apiKey.length);

        if (!apiKey) {
          reply(sendResponse, {
            ok: false,
            error: "Chưa cấu hình Gemini API key. Vào Settings để thêm API key."
          });
          return;
        }

        // 2) Build prompt + multimodal body.
// Try the Gemini fileData / fileUri path: pass the YouTube URL as a video
// attachment instead of stuffing the URL into plain text. The model can
// then fetch / transcode the video itself and return real LRC text.
        const GENRE_LIST =
          "Remix, Pop, Rock, Hip-hop & Rap, R&B & Soul, Dance & Electronic, " +
          "Nhạc Đồng quê, Nhạc Cổ điển, K-Pop, Nhạc Mỹ Latinh, Indie & Alternative, " +
          "Jazz, Blues, Metal, Nhạc Trẻ, Nhạc Trữ tình & Bolero, Nhạc Không lời, " +
          "Nhạc Thiếu nhi, Reggae, Folk & Acoustic";
        const promptWithoutRawLinkOnly = (
          "Hãy phân tích video YouTube được đính kèm trong request.\n" +
          "Tạo nội dung LRC đúng với lời bài hát thực tế trong video.\n" +
          "Không tự bịa lời.\n" +
          "Nếu không đọc được video hoặc không xác định được lời thật, " +
          "trả đúng một dòng: ERROR: CANNOT_ACCESS_VIDEO\n" +
          "Nếu thành công, format đúng:\n" +
          "Tên bài hát: ...\n" +
          "Tên các ca sỹ: ...\n" +
          "Thể loại nhạc: ...  (phải thuộc danh sách: " + GENRE_LIST + ")\n" +
          "[mm:ss.xx] lời bài hát\n" +
          "[mm:ss.xx] lời bài hát\n" +
          "Không mô tả gì thêm."
        );

        // GenAI Native Format body. Multimodal: fileData first, text prompt second.
        const buildBody = () => ({
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    mimeType: "video/mp4",
                    fileUri: youtubeUrl,
                  },
                },
                { text: promptWithoutRawLinkOnly },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 12000,
          },
        });

        // 3) Call ShopAIKey with cascading model fallback.
        // Gemini 3.1 Pro only — thinking first, then non-thinking.
        // No 2.5 models, no other fallbacks.
        const MODEL_CHAIN = [
          "gemini-3.1-pro-preview-thinking",
          "gemini-3.1-pro-preview",
        ];

        // Emit a debug snapshot right away so the sidepanel can confirm
        // which build / chain / key fingerprint is actually running.
        emitProgress("gemini-api/debug", {
          buildId: BG_BUILD_ID,
          modelChain: MODEL_CHAIN,
          inputMode: "fileData",
          fileMimeType: "video/mp4",
          keyFingerprint: {
            length: apiKey.length,
            first4: apiKey.slice(0, 4),
            last4: apiKey.slice(-4),
            hasMask: /[*•]/.test(apiKey),
            hasBearerPrefix: /^Bearer\s+/i.test(apiKey),
          },
          apiBase: "https://api.shopaikey.com/v1beta/models/",
        });

        async function callShopAIKey(model) {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 60_000);
          const url =
            "https://api.shopaikey.com/v1beta/models/" +
            encodeURIComponent(model) +
            ":generateContent?key=" +
            encodeURIComponent(apiKey);
          try {
            console.log(
              "[gemini-api] calling ShopAIKey model=" + model +
                " url=" + url.replace(/key=[^&]+/, "key=***")
            );
            emitProgress("gemini-api/calling-model", { model });
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + apiKey,
              },
              body: JSON.stringify(buildBody()),
              signal: ctrl.signal,
            });
            console.log("[gemini-api] " + model + " returned status=" + res.status);
            emitProgress("gemini-api/http-status", { model, status: res.status });
            return res;
          } finally {
            clearTimeout(t);
          }
        }

        let response = null;
        let lastError = null;
        let authFailed = false;
        let modelUnavailable = false;
        let rateLimited = false;
        let fileDataUnsupported = false;

        for (const model of MODEL_CHAIN) {
          try {
            response = await callShopAIKey(model);
          } catch (netErr) {
            console.warn("[gemini-api] " + model + " network error:", netErr.message);
            // Network error is non-terminal as long as other models can still try.
            lastError = "Không kết nối được API (" + model + "): " + (netErr.message || netErr);
            emitProgress("gemini-api/model-fallback", {
              from: model,
              reason: "network",
              message: netErr.message || String(netErr),
            });
            continue;
          }

          if (response.ok) {
            break; // success on this model
          }

          // Read raw body (capped) and try to extract json.error.message
          // so we never report a vague "unknown error".
          let rawSnippet = "";
          let parsedErrMsg = "";
          try {
            const txt = await response.text();
            rawSnippet = (txt || "").slice(0, 500);
            try {
              const j = JSON.parse(txt);
              if (j && j.error) {
                parsedErrMsg =
                  (typeof j.error === "string" ? j.error : j.error.message) || "";
              }
            } catch (_) { /* not JSON, keep rawSnippet only */ }
          } catch (_) { /* noop */ }
          console.warn(
            "[gemini-api] " + model + " status=" + response.status +
              " body=" + rawSnippet
          );

          if (response.status === 401 || response.status === 403) {
            authFailed = true;
            lastError =
              "ShopAIKey token không hợp lệ hoặc hết hạn. (HTTP " + response.status +
              (parsedErrMsg ? " — " + parsedErrMsg : "") + ")";
            // Terminal: auth won't fix itself by trying another model.
            emitProgress("gemini-api/error", {
              error: lastError,
              message: lastError,
              model,
              status: response.status,
              stage: "auth",
            });
            break; // don't retry on auth — token problem.
          }
          if (response.status === 429) {
            rateLimited = true;
            lastError =
              "ShopAIKey đang giới hạn request. (HTTP 429" +
              (parsedErrMsg ? " — " + parsedErrMsg : "") + ")";
            emitProgress("gemini-api/model-fallback", {
              from: model,
              reason: "rate-limited",
              error: lastError,
              message: lastError,
              rawMessage: parsedErrMsg,
            });
            continue; // try next model in case higher tier has capacity
          }
          if (response.status === 404 || response.status === 400) {
            modelUnavailable = true;
            const lowerErr = (parsedErrMsg || "").toLowerCase();
            const looksLikeFileDataUnsupported =
              lowerErr.includes("filedata") ||
              lowerErr.includes("fileuri") ||
              lowerErr.includes("file_data") ||
              lowerErr.includes("multimodal") ||
              lowerErr.includes("unsupported") ||
              lowerErr.includes("invalid argument") ||
              lowerErr.includes("not supported");
            const nextModel = MODEL_CHAIN[MODEL_CHAIN.indexOf(model) + 1];
            // Terminal case: ShopAIKey does not support YouTube video input
            // through generateContent. Don't fall back, don't fabricate.
            if (looksLikeFileDataUnsupported) {
              lastError =
                "ShopAIKey không hỗ trợ YouTube video input qua generateContent. " +
                "(HTTP " + response.status +
                (parsedErrMsg ? " — " + parsedErrMsg : "") + ")";
              emitProgress("gemini-api/error", {
                stage: "fileData-unsupported",
                error: lastError,
                message: lastError,
                model,
                status: response.status,
                rawMessage: parsedErrMsg,
              });
              // Stop trying — request design itself is rejected.
              // Use a sentinel so the post-loop block surfaces the right message.
              fileDataUnsupported = true;
              break;
            }
            lastError =
              "Model " + model + " không khả dụng" +
              (nextModel ? ", đang thử " + nextModel + "..." : " (HTTP " + response.status + ")");
            emitProgress("gemini-api/model-fallback", {
              from: model,
              to: nextModel || null,
              reason: "model-unavailable",
              status: response.status,
              error: lastError,
              message: lastError,
              rawMessage: parsedErrMsg,
            });
            continue; // try next model
          }
          // Other status — try next model.
          lastError =
            "API trả lỗi HTTP " + response.status + " với model " + model +
            (parsedErrMsg ? " — " + parsedErrMsg : (rawSnippet ? " — " + rawSnippet.slice(0, 200) : ""));
          emitProgress("gemini-api/model-fallback", {
            from: model,
            reason: "http-" + response.status,
            error: lastError,
            message: lastError,
            rawMessage: parsedErrMsg || rawSnippet.slice(0, 200),
          });
          continue;
        }

        if (authFailed) {
          console.warn("[gemini-api] auth failed — token invalid/expired");
          reply(sendResponse, {
            ok: false,
            error: "ShopAIKey token không hợp lệ hoặc hết hạn. Vui lòng kiểm tra lại API key trong Settings.",
          });
          return;
        }
        if (fileDataUnsupported) {
          console.warn("[gemini-api] ShopAIKey does not support fileData/video input");
          reply(sendResponse, {
            ok: false,
            error:
              "ShopAIKey không hỗ trợ YouTube video input qua generateContent. " +
              "API mode không tự bịa lyrics. Hãy chuyển sang Gemini Web UI mode " +
              "hoặc cung cấp transcript/lyrics thật.",
          });
          return;
        }
        if (!response || !response.ok) {
          console.warn("[gemini-api] all models failed:", lastError);
          const finalMsg = rateLimited
            ? "ShopAIKey đang giới hạn request. Vui lòng thử lại sau. Bạn có thể chuyển sang Gemini Web UI để tiếp tục."
            : modelUnavailable
              ? "Không có model Gemini 3.1 Pro nào khả dụng trên ShopAIKey key này. Đã thử: " + MODEL_CHAIN.join(", ") + ". Vui lòng kiểm tra lại gói dịch vụ hoặc chuyển sang Gemini Web UI."
              : (lastError || "API trả lỗi không xác định.") + " Bạn có thể chuyển sang Gemini Web UI để tiếp tục.";
          emitProgress("gemini-api/error", {
            error: finalMsg,
            message: finalMsg,
            stage: "all-failed",
          });
          reply(sendResponse, {
            ok: false,
            error: finalMsg,
          });
          return;
        }

        emitProgress("gemini-api/parse", { model: "success" });
        let json;
        try {
          json = await response.json();
        } catch (parseErr) {
          console.warn("[gemini-api] parse error:", parseErr?.message);
          const msg = "API trả phản hồi không phải JSON hợp lệ: " + (parseErr?.message || parseErr);
          emitProgress("gemini-api/error", {
            error: msg,
            message: msg,
            stage: "parse",
          });
          reply(sendResponse, {
            ok: false,
            error: msg,
          });
          return;
        }

        // GenAI Native response shape:
        //   { candidates: [{ content: { parts: [{ text: "..." }] } }] }
        const content = (
          (json && json.candidates && json.candidates[0] &&
            json.candidates[0].content && json.candidates[0].content.parts &&
            json.candidates[0].content.parts.map((p) => (p && p.text) || "").join("")) || ""
        ).trim();

        if (!content) {
          console.warn("[gemini-api] empty content");
          const msg = "API trả phản hồi trống (không có candidates[0].content.parts[*].text).";
          emitProgress("gemini-api/error", {
            error: msg,
            message: msg,
            stage: "empty",
          });
          reply(sendResponse, {
            ok: false,
            error: msg,
          });
          return;
        }

        // Return the raw text. AddSongModal will run it through the existing
        // extractLrcFromGeminiOutput / extractSongMetadata parsers.
        console.log("[gemini-api] success, lrcText length=" + content.length);
        // Emit with full lrcText so AddSongModal can resolve the async
        // Promise without depending solely on sendResponse (which arrives
        // before the modal listener is fully wired in some races).
        emitProgress("gemini-api/done", {
          length: content.length,
          lrcText: content,
          correlationId,
          videoId,
        });
        reply(sendResponse, {
          ok: true,
          correlationId,
          videoId,
          lrcText: content,
        });
      } catch (err) {
        console.error("[gemini-api] error:", err.message);
        reply(sendResponse, {
          ok: false,
          error: "Lỗi Gemini API: " + (err.message || String(err)),
        });
      }
    })();
    return true; // async response
  }

  // ── Storage helpers for provider / API key settings ──────────────────────────

  if (message.type === "svdmusic:get-lrc-provider") {
    chrome.storage.local.get("svdmusic:lrcProvider", (d) => {
      const val = d && d["svdmusic:lrcProvider"];
      reply(sendResponse, { ok: true, provider: val === "gemini-api" ? "gemini-api" : "gemini-ui" });
    });
    return true;
  }

  if (message.type === "svdmusic:set-lrc-provider") {
    chrome.storage.local.set(
      { "svdmusic:lrcProvider": String(message.provider || "gemini-ui").trim() },
      () => reply(sendResponse, { ok: true })
    );
    return true;
  }

  if (message.type === "svdmusic:get-gemini-api-key") {
    chrome.storage.local.get("svdmusic:geminiApiKey", (d) => {
      reply(sendResponse, {
        ok: true,
        key: (d && d["svdmusic:geminiApiKey"] && String(d["svdmusic:geminiApiKey"]).trim()) || "",
      });
    });
    return true;
  }

  if (message.type === "svdmusic:set-gemini-api-key") {
    chrome.storage.local.set(
      { "svdmusic:geminiApiKey": String(message.key || "").trim() },
      () => reply(sendResponse, { ok: true })
    );
    return true;
  }

  // ── Mood Quote proxy (bypasses CORS) ─────────────────────────────────────────
  // ZenQuotes is blocked by CORS from the extension's origin, so we fetch it
  // here in the background service worker and translate via MyMemory.
  //
  // Strategy:
  //   1. Read svd_mood_quote_cache from chrome.storage.local (2 min TTL).
  //   2. If miss, try ZenQuotes → translate via MyMemory.
  //   3. If ZenQuotes fails (CORS / network), fall back to api.quotable.io.
  //   4. If both providers fail, use a small built-in Vietnamese fallback.
  //
  // In-flight lock: while a fetch is pending, every concurrent caller waits
  // on the same promise — no hammering the APIs on every typing cycle.
  // Dedup logs: each provider's failure is logged at most once per service
  // worker lifetime.

  if (message.action === "GET_MOOD_QUOTE") {
    handleGetMoodQuote().then((result) => reply(sendResponse, result));
    return true; // async
  }

  return false;
});

// ── Mood Quote implementation ─────────────────────────────────────────────────

const MOOD_QUOTE_CACHE_KEY = "svd_mood_quote_cache";
const MOOD_QUOTE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const MOOD_QUOTE_FALLBACK = [
  "Có những ngày tuyệt vọng đến cùng cực, tôi và cuộc đời đã tha thứ cho nhau ☘️",
  "Có những nỗi buồn không cần gọi tên, chỉ cần một bài nhạc đủ lâu ☘️",
  "Rồi mọi thứ cũng sẽ dịu lại, theo một cách rất im lặng ☘️",
];

let moodQuoteInFlight = null;
const moodQuoteLogOnce = new Set();

function moodQuoteLog(tag, msg) {
  if (moodQuoteLogOnce.has(tag)) return;
  moodQuoteLogOnce.add(tag);
  console.warn(`[svdmusic-bg] MoodQuote ${tag}: ${msg}`);
}

function normalizeVietnamese(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

async function fetchEnglishFromZenQuotes() {
  const res = await fetch("https://zenquotes.io/api/random");
  if (!res.ok) throw new Error(`ZenQuotes HTTP ${res.status}`);
  const data = await res.json();
  const item = Array.isArray(data) ? data[0] : null;
  if (!item?.q) throw new Error("ZenQuotes: missing quote text");
  return { text: String(item.q).trim(), author: String(item.a || "Unknown").trim(), source: "zenquotes" };
}

async function fetchEnglishFromQuotable() {
  const res = await fetch("https://api.quotable.io/random");
  if (!res.ok) throw new Error(`Quotable HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.content) throw new Error("Quotable: missing quote text");
  return {
    text: String(data.content).trim(),
    author: String(data.author || "Unknown").trim(),
    source: "quotable",
  };
}

async function translateToVietnamese(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|vi`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  const translated = data?.responseData?.translatedText;
  if (!translated) throw new Error("MyMemory: missing translatedText");
  return normalizeVietnamese(translated);
}

function buildLocalFallback() {
  const text = MOOD_QUOTE_FALLBACK[Math.floor(Math.random() * MOOD_QUOTE_FALLBACK.length)];
  // Strip the trailing ☘️ so we can store a clean translatedText, then re-add ☘️ in displayText.
  const translatedText = text.replace(/\s*☘️?\s*$/, "").trim();
  return {
    ok: true,
    sourceText: "",
    author: "Local",
    translatedText,
    displayText: `${translatedText} ☘️`,
    source: "fallback",
  };
}

async function readMoodQuoteCache() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MOOD_QUOTE_CACHE_KEY, (data) => {
        const entry = data && data[MOOD_QUOTE_CACHE_KEY];
        if (!entry || typeof entry !== "object") return resolve(null);
        if (Date.now() - (entry.savedAt || 0) > MOOD_QUOTE_CACHE_TTL_MS) return resolve(null);
        if (!entry.displayText || typeof entry.displayText !== "string") return resolve(null);
        resolve(entry);
      });
    } catch (err) {
      console.warn("[svdmusic-bg] MoodQuote cache read error:", err);
      resolve(null);
    }
  });
}

async function writeMoodQuoteCache(entry) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [MOOD_QUOTE_CACHE_KEY]: entry }, () => resolve());
    } catch (err) {
      console.warn("[svdmusic-bg] MoodQuote cache write error:", err);
      resolve();
    }
  });
}

async function fetchFreshMoodQuote() {
  // Try ZenQuotes → Quotable, translate via MyMemory.
  const providers = [fetchEnglishFromZenQuotes, fetchEnglishFromQuotable];

  let english = null;
  for (const provider of providers) {
    const name = provider === fetchEnglishFromZenQuotes ? "ZenQuotes" : "Quotable";
    try {
      english = await provider();
      break;
    } catch (err) {
      moodQuoteLog(name, `${err.message || err}`);
    }
  }

  if (!english) {
    moodQuoteLog("using local fallback", "all providers failed");
    return buildLocalFallback();
  }

  let translatedText = "";
  try {
    translatedText = await translateToVietnamese(english.text);
  } catch (err) {
    moodQuoteLog("MyMemory", `${err.message || err}`);
    // Translation failed but we have English text — still return English as
    // displayText (with the ☘️) so the user isn't left staring at a blank line.
    return {
      ok: true,
      sourceText: english.text,
      author: english.author,
      translatedText: english.text,
      displayText: `${english.text} ☘️`,
      source: english.source,
    };
  }

  return {
    ok: true,
    sourceText: english.text,
    author: english.author,
    translatedText,
    displayText: `${translatedText} ☘️`,
    source: english.source,
  };
}

async function handleGetMoodQuote() {
  // 1) Cache hit — return immediately, no network.
  const cached = await readMoodQuoteCache();
  if (cached) {
    return {
      ok: true,
      displayText: cached.displayText,
      sourceText: cached.sourceText || "",
      author: cached.author || "",
      translatedText: cached.translatedText || "",
      source: cached.source || "cache",
      cached: true,
    };
  }

  // 2) Reuse in-flight promise so concurrent calls share one fetch.
  if (moodQuoteInFlight) return moodQuoteInFlight;

  moodQuoteInFlight = (async () => {
    try {
      const fresh = await fetchFreshMoodQuote();
      // Cache successful results.
      if (fresh && fresh.displayText) {
        await writeMoodQuoteCache({
          displayText: fresh.displayText,
          translatedText: fresh.translatedText || "",
          sourceText: fresh.sourceText || "",
          author: fresh.author || "",
          source: fresh.source || "unknown",
          savedAt: Date.now(),
        });
      }
      return fresh;
    } catch (err) {
      console.error("[svdmusic-bg] MoodQuote fatal:", err);
      return buildLocalFallback();
    } finally {
      // Allow next call to fetch again. Brief delay prevents back-to-back storms
      // if the typing loop somehow re-triggers while we're cleaning up.
      setTimeout(() => {
        moodQuoteInFlight = null;
      }, 250);
    }
  })();

  return moodQuoteInFlight;
}
