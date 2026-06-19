/**
 * vfs.js — OPFS-backed virtual filesystem for Iris.
 *
 * All paths are POSIX-like under an Iris root directory in OPFS.
 * Every OPFS call lives in this file so consumers depend only on the interface.
 *
 * Exports: vfs (singleton with async methods)
 */

// NOTE: This module uses the Origin Private File System (OPFS) API which is
// only available in secure browser contexts. It will parse under Node but
// cannot execute — all browser-dependent code is gated behind the lazy
// _root() helper.

const IRIS_ROOT = 'iris-files';

/**
 * Lazily obtain the Iris root directory handle inside OPFS.
 * Cached after first call.
 */
let _rootHandle = null;
async function _root() {
  if (_rootHandle) return _rootHandle;
  const opfs = await navigator.storage.getDirectory();
  _rootHandle = await opfs.getDirectoryHandle(IRIS_ROOT, { create: true });
  return _rootHandle;
}

/**
 * Resolve a POSIX-like path into an array of segments.
 * Normalises leading/trailing slashes, rejects '..'.
 * @param {string} p
 * @returns {string[]}
 */
function _segments(p) {
  const raw = (p || '/').replace(/\\/g, '/');
  const parts = raw.split('/').filter(s => s && s !== '.');
  if (parts.some(s => s === '..')) {
    throw new Error(`Path traversal not allowed: ${p}`);
  }
  return parts;
}

/**
 * Walk to the parent directory of the last segment, creating intermediate
 * directories when `create` is true.
 * @returns {{ parent: FileSystemDirectoryHandle, name: string }}
 */
async function _resolve(path, { create = false } = {}) {
  const segs = _segments(path);
  if (segs.length === 0) throw new Error('Path is empty');
  const name = segs.pop();
  let dir = await _root();
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return { parent: dir, name };
}

export const vfs = {
  /**
   * Read a file and return its contents as a string (UTF-8) or Uint8Array.
   * @param {string} path
   * @returns {Promise<string|Uint8Array>}
   */
  async readFile(path) {
    const { parent, name } = await _resolve(path);
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    // NOTE: Return as string for text files. Consumers needing binary
    // can use file.arrayBuffer() directly; for Iris tool use, string is
    // the common case.
    return await file.text();
  },

  /**
   * Write data to a file, creating intermediate directories as needed.
   * @param {string} path
   * @param {string|Uint8Array|Blob} data
   */
  async writeFile(path, data) {
    const { parent, name } = await _resolve(path, { create: true });
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  },

  /**
   * List entries in a directory.
   * @param {string} [dir='/']
   * @returns {Promise<{name:string, path:string, size:number, kind:'file'|'directory'}[]>}
   */
  async listFiles(dir = '/') {
    const segs = _segments(dir);
    let handle = await _root();
    for (const seg of segs) {
      handle = await handle.getDirectoryHandle(seg);
    }
    const entries = [];
    const prefix = '/' + segs.join('/');
    const slash = prefix.endsWith('/') ? '' : '/';
    for await (const [entryName, entryHandle] of handle.entries()) {
      const entryPath = prefix + slash + entryName;
      let size = 0;
      if (entryHandle.kind === 'file') {
        const file = await entryHandle.getFile();
        size = file.size;
      }
      entries.push({
        name: entryName,
        path: entryPath,
        size,
        kind: entryHandle.kind,
      });
    }
    return entries;
  },

  /**
   * Delete a file.
   * @param {string} path
   */
  async deleteFile(path) {
    const { parent, name } = await _resolve(path);
    await parent.removeEntry(name);
  },

  /**
   * Get metadata about a file or directory.
   * @param {string} path
   * @returns {Promise<{name:string, kind:'file'|'directory', size:number}>}
   */
  async stat(path) {
    const { parent, name } = await _resolve(path);
    // Try file first, then directory
    try {
      const handle = await parent.getFileHandle(name);
      const file = await handle.getFile();
      return { name, kind: 'file', size: file.size };
    } catch {
      const handle = await parent.getDirectoryHandle(name);
      return { name, kind: handle.kind, size: 0 };
    }
  },

  /**
   * Check whether a path exists.
   * @param {string} path
   * @returns {Promise<boolean>}
   */
  async exists(path) {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  },
};
