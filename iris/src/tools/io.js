/**
 * io.js — File upload (picker / drag-drop) and download helpers for Iris.
 *
 * Browser-only module. Uses File System Access API where available,
 * with fallback to classic <input>/<a download> patterns.
 *
 * Exports: uploadFiles, attachDropZone, saveDownload
 */

/**
 * Open the native file picker and return selected File objects.
 * @param {object} [opts]
 * @param {boolean} [opts.multiple=true]
 * @param {string[]} [opts.accept] - MIME types or extensions, e.g. ['.txt','.json']
 * @returns {Promise<File[]>}
 */
export async function uploadFiles({ multiple = true, accept } = {}) {
  // NOTE: showOpenFilePicker is preferred (returns FileSystemFileHandle[])
  // but is Chromium-only. We fall back to a hidden <input type="file">.
  if (typeof window !== 'undefined' && window.showOpenFilePicker) {
    try {
      const types = accept
        ? [{ description: 'Files', accept: { '*/*': accept } }]
        : undefined;
      const handles = await window.showOpenFilePicker({ multiple, types });
      return Promise.all(handles.map(h => h.getFile()));
    } catch (e) {
      // User cancelled → return empty array
      if (e.name === 'AbortError') return [];
      throw e;
    }
  }

  // Fallback: hidden input element
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (multiple) input.multiple = true;
    if (accept) input.accept = accept.join(',');
    input.addEventListener('change', () => {
      resolve(input.files ? Array.from(input.files) : []);
    });
    // If the user cancels, the change event never fires in some browsers.
    // Use a focus event on the window as a heuristic.
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      // Small delay to let change event fire first if files were selected.
      setTimeout(() => resolve([]), 300);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/**
 * Attach a drag-and-drop zone to an element.
 * @param {HTMLElement} el - The drop target element.
 * @param {(files: File[]) => void} onFiles - Callback with dropped files.
 * @returns {{ detach: () => void }} - Call detach() to remove listeners.
 */
export function attachDropZone(el, onFiles) {
  const prevent = e => { e.preventDefault(); e.stopPropagation(); };

  const onDragOver = e => {
    prevent(e);
    el.classList.add('iris-drop-active');
  };
  const onDragLeave = e => {
    prevent(e);
    el.classList.remove('iris-drop-active');
  };
  const onDrop = e => {
    prevent(e);
    el.classList.remove('iris-drop-active');
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      onFiles(Array.from(files));
    }
  };

  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);

  return {
    detach() {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
    },
  };
}

/**
 * Save data as a download. Uses the File System Access API showSaveFilePicker
 * when available; falls back to creating a temporary <a download> link.
 * @param {string} name - Suggested filename.
 * @param {string|Uint8Array|Blob} data - Content to save.
 */
export async function saveDownload(name, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);

  // Prefer File System Access API (Chromium)
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled
      // Fall through to <a> download
    }
  }

  // Fallback: <a download>
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  // Clean up
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
