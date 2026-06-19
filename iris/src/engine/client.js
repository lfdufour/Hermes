/**
 * engine/client.js -- Main-thread RPC client wrapping the engine worker.
 *
 * Exports: EngineClient (extends EventTarget)
 *
 * All methods return Promises that resolve when the worker responds with a
 * matching id. Streaming methods (load, generate) accept callbacks for
 * intermediate events (onProgress, onToken).
 */

let _nextId = 0;

/** Generate a unique request id. */
function nextId() {
  return `rpc_${++_nextId}_${Date.now()}`;
}

export class EngineClient extends EventTarget {
  /** @type {Worker} */
  #worker;

  /** @type {Map<string, {resolve:Function, reject:Function, onProgress?:Function, onToken?:Function}>} */
  #pending = new Map();

  constructor() {
    super();
    this.#worker = new Worker(
      new URL('./worker.js', import.meta.url),
      { type: 'module' }
    );
    this.#worker.onmessage = (e) => this.#handleMessage(e.data);
    this.#worker.onerror = (e) => {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: e.message } }));
    };
  }

  // ---------- Internal message handler ----------

  #handleMessage({ id, type, payload }) {
    const pending = this.#pending.get(id);

    switch (type) {
      // -- Streaming / intermediate events --
      case 'progress':
        if (pending?.onProgress) pending.onProgress(payload);
        this.dispatchEvent(new CustomEvent('progress', { detail: payload }));
        break;

      case 'token':
        if (pending?.onToken) pending.onToken(payload);
        this.dispatchEvent(new CustomEvent('token', { detail: payload }));
        break;

      // -- Terminal responses (resolve the Promise) --
      case 'loaded':
        this.#resolve(id, payload);
        break;

      case 'ok':
        this.#resolve(id, payload);
        break;

      case 'templated':
        this.#resolve(id, payload);
        break;

      case 'generated':
        this.#resolve(id, payload);
        break;

      case 'decoded':
        this.#resolve(id, payload);
        break;

      case 'tokenizerInfo':
        this.#resolve(id, payload);
        break;

      case 'storage':
        this.#resolve(id, payload);
        break;

      case 'error':
        this.#reject(id, new Error(payload.message));
        this.dispatchEvent(new CustomEvent('error', { detail: payload }));
        break;

      default:
        console.warn('[EngineClient] Unknown message type:', type, payload);
    }
  }

  #resolve(id, value) {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.resolve(value);
    }
  }

  #reject(id, error) {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  // ---------- Internal RPC sender ----------

  /**
   * Send a message to the worker and return a Promise for the response.
   * @param {string} type
   * @param {object} payload
   * @param {{onProgress?:Function, onToken?:Function}} [callbacks]
   * @returns {Promise<any>}
   */
  #send(type, payload, callbacks = {}) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, ...callbacks });
      this.#worker.postMessage({ id, type, payload });
    });
  }

  // ---------- Public API ----------

  /**
   * Load a model from the HF Hub.
   * @param {{repo:string, dtype?:string, device?:string, onProgress?:Function}} opts
   * @returns {Promise<void>}
   */
  async load({ repo, dtype, device, onProgress }) {
    await this.#send('load', { repo, dtype, device }, { onProgress });
  }

  /**
   * Unload the current model and free resources.
   * @returns {Promise<void>}
   */
  async unload() {
    await this.#send('unload', {});
  }

  /**
   * Apply the chat template to produce input_ids and a rendered prompt string.
   * @param {{messages:Message[], tools?:ToolSpec[], thinking?:boolean}} opts
   * @returns {Promise<{input_ids:number[], rendered:string}>}
   */
  async applyChatTemplate({ messages, tools, thinking }) {
    return this.#send('applyChatTemplate', { messages, tools, thinking });
  }

  /**
   * Generate text from input_ids, streaming tokens via onToken callback.
   * @param {{input_ids:number[], genConfig?:GenConfig, onToken?:Function}} opts
   * @returns {Promise<{outputText:string, stats:{tokens:number, ms:number, tokensPerSec:number}}>}
   */
  generate({ input_ids, genConfig, onToken }) {
    return this.#send('generate', { input_ids, genConfig }, { onToken });
  }

  /**
   * Cancel the current in-flight generate call.
   */
  cancel() {
    // Fire-and-forget; no need to await the 'ok' response
    const id = nextId();
    this.#worker.postMessage({ id, type: 'cancel', payload: {} });
  }

  /**
   * Decode token IDs back to text.
   * @param {number[]|number[][]} ids
   * @returns {Promise<{text:string|string[]}>}
   */
  async decode(ids) {
    return this.#send('decode', { ids });
  }

  /**
   * Storage operations: estimate, persist, list, clear.
   * @param {'estimate'|'persist'|'list'|'clear'} op
   * @param {string} [repo]
   * @returns {Promise<{result:any}>}
   */
  async storage(op, repo) {
    return this.#send('storage', { op, repo });
  }

  /**
   * Get tokenizer metadata (chat_template, added_tokens, specials).
   * Useful for runtime verification of thinking/tool control tokens.
   * @returns {Promise<{chat_template:string|null, added_tokens:string[], specials:object|null}>}
   */
  async tokenizerInfo() {
    return this.#send('tokenizerInfo', {});
  }
}
