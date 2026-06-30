// Downloads files via the browser's download manager into the user's
// Downloads folder, under svdmusic/<subfolder>/. The extension cannot write
// directly into the project's public/uploads folder, so users move the file
// there manually after the popup completes.

const DEFAULT_BASE = "svdmusic";

const hasChromeDownloads = () =>
  typeof chrome !== "undefined" &&
  chrome.downloads &&
  typeof chrome.downloads.download === "function";

function safeFolderName(name) {
  return (name || "")
    .toString()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "file";
}

export function downloadOptionsFor({ subfolder, fileName }) {
  return {
    filename: `${DEFAULT_BASE}/${safeFolderName(subfolder)}/${safeFolderName(fileName)}`,
    conflictAction: "uniquify",
    saveAs: false,
  };
}

export async function downloadFromUrl(url, subfolder, fileName) {
  if (!url) throw new Error("downloadFromUrl: missing url");
  if (!hasChromeDownloads()) {
    throw new Error("chrome.downloads API không khả dụng trong môi trường này.");
  }
  const options = downloadOptionsFor({ subfolder, fileName });
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download({ url, ...options }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Download failed"));
          return;
        }
        resolve(downloadId);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function downloadCoverFromThumbnails(thumbUrls, fileBaseName) {
  if (!Array.isArray(thumbUrls) || thumbUrls.length === 0) {
    throw new Error("downloadCoverFromThumbnails: no thumbnail URLs");
  }
  let lastError = null;
  for (const url of thumbUrls) {
    try {
      // Verify the URL actually returns an image (maxres returns 120x90 for missing).
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) {
        lastError = new Error(`Thumbnail ${url} responded ${head.status}`);
        continue;
      }
      const id = await downloadFromUrl(url, "image_song", `${fileBaseName}.jpg`);
      return { downloadId: id, url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Không tải được thumbnail YouTube.");
}

export async function downloadTextAsLrc(content, fileBaseName) {
  if (!content) throw new Error("downloadTextAsLrc: missing content");
  if (!hasChromeDownloads()) {
    throw new Error("chrome.downloads API không khả dụng trong môi trường này.");
  }
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const id = await downloadFromUrl(blobUrl, "lrc", fileBaseName + ".lrc");
    return { downloadId: id };
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

/**
 * Saves LRC text via chrome.downloads at a deterministic path inside the user's
 * Downloads folder: svdmusic/lrc/{videoId}.lrc. Overwrites existing files so
 * re-running for the same videoId does not leave duplicates.
 */
export async function autoSaveLrcFile(videoId, lrcText) {
  if (!videoId) throw new Error("autoSaveLrcFile: thiếu videoId");
  if (typeof lrcText !== "string" || !lrcText.trim()) {
    throw new Error("autoSaveLrcFile: nội dung LRC trống");
  }
  if (!hasChromeDownloads()) {
    throw new Error("chrome.downloads API không khả dụng trong môi trường này.");
  }
  const blob = new Blob([lrcText], { type: "text/plain;charset=utf-8" });
  const blobUrl = URL.createObjectURL(blob);
  const fileName = videoId + ".lrc";
  try {
    return await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename: DEFAULT_BASE + "/lrc/" + fileName,
          saveAs: false,
          conflictAction: "overwrite",
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "Download failed"));
            return;
          }
          resolve({ downloadId, fileName });
        }
      );
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

// Generate a stub MP3 placeholder so users can drop their own file with the
// correct name. Keeps the filename predictable.
export async function downloadMp3Stub(fileBaseName) {
  if (!hasChromeDownloads()) {
    throw new Error("chrome.downloads API không khả dụng trong môi trường này.");
  }
  const note = [
    `# SVDMusic stub`,
    `# Bạn cần đặt file MP3 thật vào:`,
    `# public/uploads/mp3/${fileBaseName}.mp3`,
    `# rồi reload extension.`,
    ``,
  ].join("\n");
  const blob = new Blob([note], { type: "text/plain;charset=utf-8" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const id = await downloadFromUrl(blobUrl, "mp3", `${fileBaseName}.mp3`);
    return { downloadId: id };
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

export const __testing = { downloadOptionsFor };