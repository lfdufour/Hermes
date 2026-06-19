/**
 * fileManager.js -- OPFS file browser for Iris.
 *
 * Lists files via vfs.listFiles, supports Upload (io.uploadFiles -> vfs.writeFile),
 * drag-drop (io.attachDropZone), and Download (vfs.readFile -> io.saveDownload).
 * Refreshes after tool runs.
 *
 * Exports: createFileManager
 */

import { uploadFiles, attachDropZone, saveDownload } from '../tools/io.js';

/**
 * Create the file manager UI.
 *
 * @param {HTMLElement} container - The DOM element to render into.
 * @param {{ vfs: import('../tools/vfs.js').vfs,
 *           fileTags?: import('../tools/fileTags.js').fileTags }} deps
 * @returns {{ refresh: () => Promise<void> }}
 */
export function createFileManager(container, { vfs, fileTags }) {
  if (!container) {
    return { refresh: async () => {} };
  }

  container.innerHTML = `
    <div class="file-manager">
      <h3 class="panel-title">Files (OPFS)</h3>
      <div class="fm-toolbar">
        <button id="fm-upload-btn" class="btn-primary btn-sm">Upload</button>
        <button id="fm-refresh-btn" class="btn-sm">Refresh</button>
      </div>
      <div id="fm-dropzone" class="fm-dropzone">
        Drop files here or use Upload
      </div>
      <div id="fm-file-list" class="fm-file-list"></div>
    </div>
  `;

  const uploadBtn = container.querySelector('#fm-upload-btn');
  const refreshBtn = container.querySelector('#fm-refresh-btn');
  const dropzone = container.querySelector('#fm-dropzone');
  const fileListEl = container.querySelector('#fm-file-list');

  /**
   * Refresh the file list display.
   */
  async function refresh() {
    if (!fileListEl) return;

    try {
      const entries = await vfs.listFiles('/');
      if (entries.length === 0) {
        fileListEl.innerHTML = '<div class="fm-empty">No files yet.</div>';
        return;
      }

      fileListEl.innerHTML = '';
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'fm-file-row';

        const icon = entry.kind === 'directory' ? '[dir]' : '[file]';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'fm-file-name';
        nameSpan.textContent = `${icon} ${entry.name}`;
        row.appendChild(nameSpan);

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'fm-file-size';
        sizeSpan.textContent = entry.kind === 'file' ? formatSize(entry.size) : '';
        row.appendChild(sizeSpan);

        if (entry.kind === 'file') {
          const dlBtn = document.createElement('button');
          dlBtn.className = 'btn-sm fm-dl-btn';
          dlBtn.textContent = 'Download';
          dlBtn.addEventListener('click', async () => {
            try {
              const data = await vfs.readFile(entry.path);
              await saveDownload(entry.name, data);
            } catch (e) {
              console.error('Download failed:', e);
            }
          });
          row.appendChild(dlBtn);
        }

        fileListEl.appendChild(row);

        // Tag editor: lets the user alias a file so it can be referenced by tag
        // in chat and read/written by the model via read_file/write_file {tag}.
        if (entry.kind === 'file' && fileTags) {
          const tagRow = document.createElement('div');
          tagRow.className = 'fm-tag-row';
          const tagInput = document.createElement('input');
          tagInput.className = 'fm-tag-input';
          tagInput.type = 'text';
          tagInput.spellcheck = false;
          tagInput.placeholder = 'tag (e.g. report)';
          tagInput.value = fileTags.tagForPath(entry.path) || '';
          const commit = () => {
            const prev = fileTags.tagForPath(entry.path);
            const next = tagInput.value.trim();
            if (prev && prev !== next) fileTags.removeTag(prev);
            if (next) fileTags.set(next, entry.path);
            else if (prev) fileTags.removeTag(prev);
          };
          tagInput.addEventListener('change', commit);
          tagInput.addEventListener('blur', commit);
          const tagLabel = document.createElement('span');
          tagLabel.className = 'fm-tag-label';
          tagLabel.textContent = 'tag:';
          tagRow.appendChild(tagLabel);
          tagRow.appendChild(tagInput);
          fileListEl.appendChild(tagRow);
        }
      }
    } catch (e) {
      fileListEl.innerHTML = `<div class="fm-empty">Error listing files: ${e.message}</div>`;
    }
  }

  /**
   * Handle uploaded files: write each to VFS and refresh.
   * @param {File[]} files
   */
  async function handleUploadedFiles(files) {
    for (const file of files) {
      try {
        const content = await file.text();
        await vfs.writeFile('/' + file.name, content);
      } catch (e) {
        console.error('Upload failed for', file.name, e);
      }
    }
    await refresh();
  }

  // Upload button
  if (uploadBtn) {
    uploadBtn.addEventListener('click', async () => {
      const files = await uploadFiles();
      if (files.length > 0) {
        await handleUploadedFiles(files);
      }
    });
  }

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refresh();
    });
  }

  // Drag-drop zone
  if (dropzone) {
    attachDropZone(dropzone, async (files) => {
      await handleUploadedFiles(files);
    });
  }

  // Initial load
  refresh();

  return { refresh };
}

/**
 * Format bytes as a human-readable size string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
