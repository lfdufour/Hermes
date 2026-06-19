/**
 * fileTags.js -- Human-friendly tag aliases for uploaded files.
 *
 * Maps a short tag name (e.g. "report") to a VFS path (e.g. "/q3-report.txt")
 * so the user can refer to a file by tag in chat and the model can read/write it
 * with read_file/write_file {tag:"report"} without knowing the real path.
 *
 * Persisted in localStorage. All access is guarded so the module also parses in
 * non-browser contexts (e.g. Node tests) without throwing at import time.
 *
 * Exports: fileTags
 */

const KEY = 'iris.fileTags';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch (_) { return {}; }
}
function save(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (_) { /* ignore */ }
}

export const fileTags = {
  /** @returns {Record<string,string>} tag -> path */
  all() { return load(); },

  /** @returns {string|undefined} the path for a tag */
  get(tag) { return load()[tag]; },

  /** Assign a tag to a path (a tag maps to exactly one path). */
  set(tag, path) {
    const t = String(tag || '').trim();
    if (!t) return;
    const map = load();
    map[t] = path;
    save(map);
  },

  /** Remove a tag. */
  removeTag(tag) {
    const map = load();
    if (tag in map) { delete map[tag]; save(map); }
  },

  /** Remove every tag pointing at a path (e.g. when the file is deleted). */
  removeByPath(path) {
    const map = load();
    let changed = false;
    for (const t of Object.keys(map)) {
      if (map[t] === path) { delete map[t]; changed = true; }
    }
    if (changed) save(map);
  },

  /** @returns {string|undefined} the (first) tag pointing at a path */
  tagForPath(path) {
    const map = load();
    return Object.keys(map).find(t => map[t] === path);
  },

  /** @returns {{tag:string, path:string}[]} */
  list() {
    return Object.entries(load()).map(([tag, path]) => ({ tag, path }));
  },
};
