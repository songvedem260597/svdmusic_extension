// IndexedDB-backed storage for background gallery images.
//
// The extension already has a generic asset store (see ./assetStorage.ts)
// keyed as `<kind>:<videoId>`. We reuse that store by picking
// kind="background" and videoId=<gallery-id>. That way the gallery
// shares one DB with audio/cover/lyrics and we don't proliferate object
// stores.

import {
  saveAssetByKey,
  loadAssetByKey,
  deleteAssetByKey,
  listStoredVideoIds,
} from "./assetStorage.ts";

/**
 * Saves a Blob under `background:<id>`. Overwrites if the key already exists.
 *
 * @param {string} id
 * @param {Blob} blob
 */
export async function saveBackground(id, blob) {
  if (!id) throw new Error("saveBackground: thiếu id");
  if (!(blob instanceof Blob)) {
    throw new Error("saveBackground: blob không hợp lệ");
  }
  return saveAssetByKey(`background:${id}`, blob);
}

/**
 * Loads the Blob for a gallery item, or null if missing.
 *
 * @param {string} id
 * @returns {Promise<Blob|null>}
 */
export async function loadBackground(id) {
  if (!id) return null;
  return loadAssetByKey(`background:${id}`);
}

/**
 * Removes a gallery item blob. Safe on missing keys.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteBackground(id) {
  if (!id) return false;
  return deleteAssetByKey(`background:${id}`);
}

/**
 * Lists every stored background id. Exposed for housekeeping.
 *
 * @returns {Promise<string[]>}
 */
export async function listBackgroundIds() {
  try {
    const ids = await listStoredVideoIds();
    return Array.isArray(ids) ? ids : [];
  } catch (error) {
    console.warn("[backgroundStorage] listBackgroundIds failed", error);
    return [];
  }
}

/**
 * Converts a File (from <input type="file">) to a Blob.
 *
 * @param {File} file
 * @returns {Blob}
 */
export function fileToBlob(file) {
  return new Blob([file], { type: file.type || "application/octet-stream" });
}