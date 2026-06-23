/**
 * cases.js — IndexedDB CRUD for Cases; export/import JSON backup.
 *
 * Backed by IndexedDB database "hermes-examiner", object store "cases" with keyPath "id".
 * All IDB access is encapsulated here so pure-logic modules stay node-testable.
 */

// NOTE: DB_VERSION starts at 1. If the schema needs migration later (e.g. adding indexes),
// bump this and handle onupgradeneeded transitions.
const DB_NAME = 'hermes-examiner';
const STORE_NAME = 'cases';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let db = null;

/**
 * Open (or create) the IndexedDB database.
 * Resolves once the DB is ready; rejects on error.
 * Safe to call multiple times — returns immediately if already initialized.
 * @returns {Promise<void>}
 */
function init() {
  if (db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve();
    };
    request.onerror = (event) => {
      reject(new Error(`IndexedDB open failed: ${event.target.error}`));
    };
  });
}

/**
 * Helper: run a transaction and return a promise for the request result.
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest} fn
 * @returns {Promise<any>}
 */
function withStore(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('casesStore not initialized — call init() first'));
      return;
    }
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * List all cases as lightweight summaries, sorted newest-first.
 * @returns {Promise<{id:string, title:string, updatedAt:string}[]>}
 */
async function list() {
  const all = await withStore('readonly', (store) => store.getAll());
  // NOTE: Using in-memory sort rather than an IDB index on updatedAt.
  // For typical examiner workloads (tens of cases) this is fine; an index
  // would add upgrade complexity for negligible gain.
  return all
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/**
 * Get a single case by id.
 * @param {string} id
 * @returns {Promise<import('../types.js').Case|null>}
 */
async function get(id) {
  const result = await withStore('readonly', (store) => store.get(id));
  return result ?? null;
}

/**
 * Upsert a case. Always bumps updatedAt to current ISO timestamp.
 * @param {import('../types.js').Case} caseObj
 * @returns {Promise<void>}
 */
async function save(caseObj) {
  caseObj.updatedAt = new Date().toISOString();
  await withStore('readwrite', (store) => store.put(caseObj));
}

/**
 * Delete a case by id. No-op if the id doesn't exist.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function remove(id) {
  await withStore('readwrite', (store) => store.delete(id));
}

/**
 * Generate a v4-style UUID, with fallback for environments without crypto.randomUUID.
 * @returns {string}
 */
function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // NOTE: Fallback for older browsers / non-secure contexts. Uses Math.random —
  // not cryptographically secure, but sufficient for local case IDs.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Factory: create a new empty Case with all required fields initialized.
 * Does NOT persist — caller should follow with save().
 * @param {{title: string}} opts
 * @returns {import('../types.js').Case}
 */
function newCase({ title }) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    createdAt: now,
    updatedAt: now,
    source: { claims: '', description: '' },
    meta: {},
    table: { claims: [], features: [] },
    documents: [],
    mappings: {},
    summaries: {},
    settings: { modelId: '' },
  };
}

/**
 * Serialize a Case to a JSON string for backup/export.
 * @param {import('../types.js').Case} caseObj
 * @returns {string}
 */
function exportJSON(caseObj) {
  // NOTE: Pretty-print with 2-space indent for human readability of backups.
  return JSON.stringify(caseObj, null, 2);
}

/**
 * Deserialize a JSON string back to a Case object.
 * Performs basic shape validation (id + title must be present).
 * @param {string} json
 * @returns {import('../types.js').Case}
 * @throws {Error} if JSON is invalid or missing required fields
 */
function importJSON(json) {
  const obj = JSON.parse(json);
  if (!obj || typeof obj.id !== 'string' || typeof obj.title !== 'string') {
    throw new Error('Invalid case JSON: missing required "id" or "title" field');
  }
  // NOTE: We trust the structure if id+title are present. A full schema validator
  // would be heavy for this client-side tool; corrupt data would surface in the UI
  // and can be fixed by re-importing a good backup.
  return obj;
}

/**
 * The public casesStore API — single object gathering all CRUD + utility methods.
 */
export const casesStore = {
  init,
  list,
  get,
  save,
  remove,
  newCase,
  exportJSON,
  importJSON,
};
