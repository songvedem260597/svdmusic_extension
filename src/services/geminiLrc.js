// Orchestrates the Gemini LRC generation flow from the sidepanel:
//   1. Ask background to ensure a Gemini tab is open and the content script
//      is ready. The background owns a global job lock keyed by jobId, so
//      a duplicate trigger from the sidepanel will be rejected instead of
//      spawning a second content-script instance.
//   2. Send the prompt + chosen model config.
//   3. Wait for the content script to report LRC content (or an error).
//   4. Allow cancellation at any step.
//
// The actual UI interaction happens inside gemini-content.js (content script
// running on https://gemini.google.com/*). Messaging goes through the
// extension background service worker so the sidepanel can wait on a long
// timeout (up to 10 minutes) without losing the connection.

function newCorrelationId() {
  return "svdmusic-lrc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

function newJobId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

const hasRuntime = () =>
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof chrome.runtime.sendMessage === "function";

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    if (!hasRuntime()) {
      reject(new Error("chrome.runtime không khả dụng."));
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "sendMessage failed"));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function listenOnce({ correlationId, jobId, onProgress }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Đã hủy vì timeout khi chờ Gemini."));
    }, 10 * 60 * 1000);

    function listener(message) {
      if (!message) return;
      // Drop messages from other jobIds — they belong to a stale instance.
      if (message.jobId && jobId && message.jobId !== jobId) return;
      if (message.correlationId && message.correlationId !== correlationId) return;
      if (message.type === "progress" && typeof onProgress === "function") {
        try {
          onProgress(message.payload);
        } catch (error) {
          console.warn("[geminiLrc] progress callback error", error);
        }
        return;
      }
      if (message.type === "lrc-ready") {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.payload);
        return;
      }
      if (message.type === "error") {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(message.payload?.message || "Gemini content script gặp lỗi."));
        return;
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

export async function startLrcGeneration({ youtubeLink, prompt }, onProgress) {
  if (!youtubeLink) throw new Error("Thiếu link YouTube.");
  const correlationId = newCorrelationId();
  const jobId = newJobId();
  const waiter = listenOnce({ correlationId, jobId, onProgress });
  const kickoff = await sendMessage({
    type: "gemini/start-lrc",
    correlationId,
    jobId,
    youtubeLink,
    prompt,
  });
  if (!kickoff?.ok) {
    const err = new Error(kickoff?.error || "Không thể khởi động Gemini.");
    err.lockedBy = kickoff?.lockedBy || null;
    throw err;
  }
  return { correlationId, jobId, result: await waiter };
}

/**
 * Inspects the current background job lock so the sidepanel can show
 * "đang có phiên chạy" / "không có phiên nào".
 */
export async function inspectLrcLock() {
  try {
    return await sendMessage({ type: "gemini/inspect-lock" });
  } catch (error) {
    console.warn("[geminiLrc] inspect failed", error);
    return null;
  }
}

/**
 * Force-clears the background job lock. Use this when the user has closed
 * every Gemini tab but the lock from a previous run is still present. Safe
 * to call even when no lock exists.
 */
export async function forceResetLrcLock() {
  try {
    return await sendMessage({ type: "gemini/force-reset-lock" });
  } catch (error) {
    console.warn("[geminiLrc] forceReset failed", error);
    return null;
  }
}

export async function continueAfterLogin({ correlationId, jobId }, onProgress) {
  const waiter = listenOnce({ correlationId, jobId, onProgress });
  const ack = await sendMessage({ type: "gemini/continue", correlationId, jobId });
  if (!ack?.ok) {
    throw new Error(ack?.error || "Không thể tiếp tục Gemini.");
  }
  return { correlationId, jobId, result: await waiter };
}

export async function cancelLrcGeneration({ correlationId, jobId }) {
  if (!correlationId && !jobId) return;
  try {
    await sendMessage({ type: "gemini/cancel", correlationId, jobId });
  } catch (error) {
    console.warn("[geminiLrc] cancel failed", error);
  }
}