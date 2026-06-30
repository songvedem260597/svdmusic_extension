// textSearch.js
//
// Shared text matching helpers. Both the top-bar SearchBox (in App.jsx) and
// the SongLibraryPopover need to search across title / artist / tags using
// the same diacritic-insensitive rule. Keep this single source of truth so a
// tweak to the matcher (e.g. stemming) only lands in one place.

/**
 * Lowercase + strip Vietnamese diacritics + map đ → d.
 * Used as the comparison key for both the query string and any searchable
 * string on a song row.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

/**
 * True when a single field contains the normalized query.
 * Empty query always matches (used by the empty-state guard).
 *
 * @param {string} normalizedQuery result of `normalizeSearch(query)`
 * @param {unknown} value field text
 */
function fieldMatches(normalizedQuery, value) {
  if (!normalizedQuery) return true;
  return normalizeSearch(value).includes(normalizedQuery);
}

/**
 * Match a song against a query by title, artist, and every entry in `tags`.
 * Returns false for nullish input.
 *
 * @param {string} rawQuery raw user input (NOT pre-normalized)
 * @param {unknown} song
 * @returns {boolean}
 */
export function matchSongQuery(rawQuery, song) {
  if (!song || typeof song !== "object") return false;
  const normalizedQuery = normalizeSearch(rawQuery).trim();
  if (!normalizedQuery) return true;

  if (fieldMatches(normalizedQuery, song.title)) return true;
  if (fieldMatches(normalizedQuery, song.artist)) return true;

  if (Array.isArray(song.tags)) {
    for (const tag of song.tags) {
      if (fieldMatches(normalizedQuery, tag)) return true;
    }
  }

  return false;
}