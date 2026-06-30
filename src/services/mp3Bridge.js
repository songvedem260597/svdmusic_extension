// Sidepanel-side bridge for the MP3 fetch pipeline.
//
// IMPORTANT: this bridge is now backed by `chrome.runtime.sendMessage`
// instead of a long-lived Port. The MP3 job is owned by the background
// service worker end-to-end — the sidepanel just kicks the job off and
// subscribes to progress / result / error broadcasts.
//
// Protocol:
//   sidepanel → background
//     { type: "mp3/start", correlationId, videoId, youtubeUrl }
//       -> background returns { ok: true, correlationId, status: "running" }
//          (or deduplicated if the same videoId already has a live job).
//     { type: "mp3/cancel", correlationId?, videoId? }
//     { type: "mp3/status", correlationId?, videoId? }
//
//   background → sidepanel (broadcasts)
//     { type: "mp3/progress", correlationId, videoId, stage, progress? }
//     { type: "mp3/result",   correlationId, videoId, mimeType, size,
//                             title, filesize, duration, audioSource,
//                             arrayBuffer }   // one-shot, transferable
//     { type: "mp3/ready",    correlationId, videoId,
//                             audioKey: "audio:{videoId}", size, title,
//                             mimeType, filesize, duration, audioSource }
//     { type: "mp3/error",    correlationId, videoId, error }
//
// Two public APIs:
//   startMp3Job({ correlationId, videoId, youtubeUrl, onProgress, onResult })
//     -> returns { correlationId } immediately. The actual result/error is
//        delivered later via onResult({ blob, filesize, duration,
//        audioSource, ... }) / onResult({ error }).
//   queryMp3Status({ correlationId, videoId })
//     -> returns the current job state (used for recovery after remount).
//
// A sidepanel/modal unmount does NOT cancel the job. The background keeps
// running the conversion; the blob is still streamed back as `mp3/result`.
// If no listener is attached when `mp3/result` arrives, the sidepanel can
// query the job status on remount and call `queryMp3Status` to recover —
// but the final arrayBuffer is only delivered once via sendMessage, so the
// canonical place to write it to IndexedDB is the first onResult callback
// that runs.

function hasRuntime() {
  return (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === "function"
  );
}

function newCorrelationId() {
  return "svdmusic-mp3-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

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

/**
 * Kicks off an MP3 conversion job owned by the background service worker.
 *
 * @param {{
 *   correlationId?: string,
 *   videoId: string,
 *   youtubeUrl: string,
 *   onProgress?: (stage: string, info?: { progress?: number }) => void,
 *   onResult?: (result: { ok: true, blob: Blob, mimeType: string, size: number, title: string, audioKey: string, filesize?: number, duration?: number|null, audioSource?: string } | { ok: false, error: string }) => void,
 * }} opts
 * @returns {Promise<{ correlationId: string }>}
 */
export async function startMp3Job({
  correlationId,
  videoId,
  youtubeUrl,
  onProgress,
  onResult,
} = {}) {
  if (!videoId) throw new Error("startMp3Job: thiếu videoId.");
  if (!youtubeUrl) throw new Error("startMp3Job: thiếu youtubeUrl.");

  const id = correlationId || newCorrelationId();

  // Install a one-shot listener that captures progress + the terminal
  // result/error for THIS correlationId. When the listener fires we
  // remove it so subsequent MP3 jobs (or jobs for other videos) don't
  // get cross-talked into this handler.
  const installListener = () => {
    function listener(message) {
      if (!message || typeof message !== "object") return;
      if (message.correlationId !== id) return;

      if (message.type === "mp3/progress") {
        if (typeof onProgress === "function") {
          try {
            onProgress(message.stage || "progress", { progress: message.progress });
          } catch (_) { /* noop */ }
        }
        return;
      }

      if (message.type === "mp3/result") {
        // Save the blob bytes that the background streamed back. The
        // sidepanel writes them to IndexedDB (background can't, MV3 SW
        // can't open IndexedDB).
        let blob = null;
        if (message.arrayBuffer) {
          blob = new Blob([message.arrayBuffer], { type: message.mimeType || "audio/mpeg" });
        } else if (typeof message.base64 === "string" && message.base64.length > 0) {
          const binary = atob(message.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          blob = new Blob([bytes.buffer], { type: message.mimeType || "audio/mpeg" });
        }
        if (typeof onResult === "function") {
          try {
            if (!blob || blob.size < 1024) {
              onResult({ ok: false, error: "Dịch vụ trả về file MP3 rỗng." });
            } else {
              onResult({
                ok: true,
                blob,
                mimeType: message.mimeType || "audio/mpeg",
                size: blob.size,
                title: message.title || videoId,
                audioKey: `audio:${videoId}`,
                filesize:
                  typeof message.filesize === "number" ? message.filesize : blob.size,
                duration:
                  typeof message.duration === "number" ? message.duration : null,
                audioSource:
                  typeof message.audioSource === "string"
                    ? message.audioSource
                    : "yt2mp3-page-bridge",
              });
            }
          } catch (_) { /* noop */ }
        }
        // Don't remove the listener yet — `mp3/ready` follows and the
        // UI might want to react to it (e.g. flip audioMissing=false).
        return;
      }

      if (message.type === "mp3/ready") {
        // Background signals the IndexedDB save point + final shape.
        // The sidepanel has already received the arrayBuffer in
        // `mp3/result`; this is the bookkeeping event the UI hooks
        // into to advance the step indicator.
        if (typeof onProgress === "function") {
          try {
            onProgress("ready", { size: message.size });
          } catch (_) { /* noop */ }
        }
        cleanup();
        return;
      }

      if (message.type === "mp3/error") {
        if (typeof onResult === "function") {
          try {
            onResult({ ok: false, error: message.error || "Lỗi không xác định từ background." });
          } catch (_) { /* noop */ }
        }
        cleanup();
        return;
      }
    }

    function cleanup() {
      try { chrome.runtime.onMessage.removeListener(listener); } catch (_) { /* noop */ }
    }

    chrome.runtime.onMessage.addListener(listener);
    return cleanup;
  };

  installListener();

  // Kick off the job. `deduplicated: true` means a previous job for the
  // same videoId is already in flight — the background will keep using
  // its existing correlationId, which is NOT the one we passed in. In
  // that case we re-subscribe to the existing correlationId instead.
  const kickoff = await sendMessage({
    type: "mp3/start",
    correlationId: id,
    videoId,
    youtubeUrl,
  });

  if (!kickoff?.ok) {
    throw new Error(kickoff?.error || "Không thể khởi động job MP3.");
  }

  return {
    correlationId: kickoff.correlationId || id,
    deduplicated: !!kickoff.deduplicated,
    status: kickoff.status || "running",
  };
}

/**
 * Best-effort cancel — does not abort the in-flight HTTP request inside
 * the background; just marks the job as cancelled so subsequent events
 * stop being delivered.
 */
export async function cancelMp3Job({ correlationId, videoId } = {}) {
  if (!correlationId && !videoId) return { ok: true, cancelled: false };
  try {
    return await sendMessage({ type: "mp3/cancel", correlationId, videoId });
  } catch (error) {
    console.warn("[mp3Bridge] cancel failed", error);
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Returns the current state of a job so the sidepanel can re-sync its
 * UI after a remount, or recover a `ready` job whose `mp3/result`
 * event was missed (e.g. nobody was listening at the time).
 */
export async function queryMp3Status({ correlationId, videoId } = {}) {
  if (!correlationId && !videoId) return { ok: false, found: false };
  try {
    return await sendMessage({ type: "mp3/status", correlationId, videoId });
  } catch (error) {
    console.warn("[mp3Bridge] status failed", error);
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Subscribes to all MP3 events for a single correlationId. Returns a
 * cleanup function that removes the listener.
 *
 * Useful when you want to share progress across multiple UI surfaces
 * without each surface starting its own job.
 */
export function subscribeMp3Events({ correlationId, onProgress, onResult, onReady, onError }) {
  if (!correlationId) return () => {};
  function listener(message) {
    if (!message || typeof message !== "object") return;
    if (message.correlationId !== correlationId) return;
    if (message.type === "mp3/progress" && typeof onProgress === "function") {
      try { onProgress(message.stage, { progress: message.progress }); } catch (_) { /* noop */ }
    } else if (message.type === "mp3/result" && typeof onResult === "function") {
      let blob = null;
      if (message.arrayBuffer) {
        blob = new Blob([message.arrayBuffer], { type: message.mimeType || "audio/mpeg" });
      } else if (typeof message.base64 === "string" && message.base64.length > 0) {
        const binary = atob(message.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        blob = new Blob([bytes.buffer], { type: message.mimeType || "audio/mpeg" });
      }
      try {
        onResult({
          blob,
          mimeType: message.mimeType || "audio/mpeg",
          size: blob ? blob.size : 0,
          title: message.title || "",
          videoId: message.videoId,
          filesize:
            typeof message.filesize === "number"
              ? message.filesize
              : blob
                ? blob.size
                : 0,
          duration: typeof message.duration === "number" ? message.duration : null,
          audioSource:
            typeof message.audioSource === "string"
              ? message.audioSource
              : "yt2mp3-page-bridge",
        });
      } catch (_) { /* noop */ }
    } else if (message.type === "mp3/ready" && typeof onReady === "function") {
      try {
        onReady({
          videoId: message.videoId,
          audioKey: message.audioKey,
          size: message.size,
          title: message.title,
          mimeType: message.mimeType,
          filesize:
            typeof message.filesize === "number" ? message.filesize : message.size,
          duration: typeof message.duration === "number" ? message.duration : null,
          audioSource:
            typeof message.audioSource === "string"
              ? message.audioSource
              : "yt2mp3-page-bridge",
        });
      } catch (_) { /* noop */ }
    } else if (message.type === "mp3/error" && typeof onError === "function") {
      try { onError({ error: message.error || "Lỗi không xác định." }); } catch (_) { /* noop */ }
    }
  }
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    try { chrome.runtime.onMessage.removeListener(listener); } catch (_) { /* noop */ }
  };
}