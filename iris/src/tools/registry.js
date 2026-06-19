/**
 * registry.js — Tool registry for Iris.
 *
 * Manages tool registration, lookup, and invocation with timing and error
 * handling. invoke() ALWAYS returns a ToolResult — it never throws.
 *
 * Exports: ToolRegistry
 */

/**
 * @typedef {{name:string, description:string, parameters:object, run:(args:object, ctx:object)=>Promise<any>}} Tool
 * @typedef {{tool_call_id:string, name:string, ok:boolean, value:any, error?:string, ms:number}} ToolResult
 * @typedef {{name:string, description:string, parameters:object}} ToolSpec
 */

let _idCounter = 0;

function _generateId() {
  return `tc_${Date.now()}_${++_idCounter}`;
}

export class ToolRegistry {
  /** @type {Map<string, Tool>} */
  #tools = new Map();

  /**
   * Register a tool. Throws if a tool with the same name already exists.
   * @param {Tool} tool
   */
  register(tool) {
    if (!tool || !tool.name) {
      throw new Error('Tool must have a name');
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    if (typeof tool.run !== 'function') {
      throw new Error(`Tool "${tool.name}" must have a run() function`);
    }
    this.#tools.set(tool.name, tool);
  }

  /**
   * Return specs (name, description, parameters) for all registered tools.
   * @returns {ToolSpec[]}
   */
  list() {
    const specs = [];
    for (const t of this.#tools.values()) {
      specs.push({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      });
    }
    return specs;
  }

  /**
   * Check whether a tool with the given name is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#tools.has(name);
  }

  /**
   * Invoke a tool by name. NEVER throws — always returns a ToolResult.
   * @param {string} name
   * @param {object} args
   * @param {object} [ctx] - Optional context (may include tool_call_id, etc.)
   * @returns {Promise<ToolResult>}
   */
  async invoke(name, args, ctx = {}) {
    const tool_call_id = ctx.tool_call_id || args?.tool_call_id || _generateId();
    const start = performance.now();

    if (!this.#tools.has(name)) {
      return {
        tool_call_id,
        name,
        ok: false,
        value: null,
        error: `Unknown tool: "${name}"`,
        ms: Math.round(performance.now() - start),
      };
    }

    try {
      const tool = this.#tools.get(name);
      const value = await tool.run(args, ctx);
      return {
        tool_call_id,
        name,
        ok: true,
        value,
        ms: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        tool_call_id,
        name,
        ok: false,
        value: null,
        error: err?.message || String(err),
        ms: Math.round(performance.now() - start),
      };
    }
  }
}
