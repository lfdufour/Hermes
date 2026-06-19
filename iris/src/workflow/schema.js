/**
 * workflow/schema.js — Workflow node schema + validation for Iris.
 *
 * Node types: input | llm | tool | condition | loop | output.
 * Exports: validate(workflow) -> {ok, errors}, DEFAULT_CHAT_WORKFLOW
 */

/** @typedef {'input'|'llm'|'tool'|'condition'|'loop'|'output'} NodeType */

const VALID_TYPES = new Set(['input', 'llm', 'tool', 'condition', 'loop', 'output']);

// NOTE: Condition operators kept minimal — equality, inequality, truthy/falsy.
// Extend here if the architect needs numeric comparisons etc.
const VALID_OPS = new Set(['==', '!=', 'truthy', 'falsy']);

/**
 * The default chat workflow: a single input -> agent-loop LLM -> output.
 * This is what the chat UI runs. The agent loop (loop.js runAgent) is invoked
 * by the 'llm' node when agentLoop is true.
 */
export const DEFAULT_CHAT_WORKFLOW = [
  { type: 'input', as: 'userMessage' },
  { type: 'llm', tools: '*', agentLoop: true, in: 'userMessage', out: 'answer' },
  { type: 'output', from: 'answer' },
];

/**
 * Validate a workflow definition.
 *
 * Checks:
 * - workflow is a non-empty array
 * - each node has a valid type
 * - each node type has its required fields with correct shapes
 * - referenced variables (in, from, var) are produced by an earlier node
 *   or pre-seeded via an input node
 *
 * @param {object[]} workflow
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validate(workflow) {
  const errors = [];

  if (!Array.isArray(workflow)) {
    return { ok: false, errors: ['Workflow must be an array'] };
  }
  if (workflow.length === 0) {
    return { ok: false, errors: ['Workflow must have at least one node'] };
  }

  // Track variables that have been produced so far (for reference checking)
  const produced = new Set();

  for (let i = 0; i < workflow.length; i++) {
    const node = workflow[i];
    const prefix = `Node[${i}]`;

    if (!node || typeof node !== 'object') {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    if (!VALID_TYPES.has(node.type)) {
      errors.push(`${prefix}: invalid type "${node.type}" (must be one of: ${[...VALID_TYPES].join(', ')})`);
      continue;
    }

    switch (node.type) {
      case 'input':
        if (typeof node.as !== 'string' || node.as.length === 0) {
          errors.push(`${prefix} (input): "as" must be a non-empty string`);
        } else {
          produced.add(node.as);
        }
        break;

      case 'llm':
        if (typeof node.out !== 'string' || node.out.length === 0) {
          errors.push(`${prefix} (llm): "out" must be a non-empty string`);
        }
        if (node.in !== undefined && typeof node.in !== 'string') {
          errors.push(`${prefix} (llm): "in" must be a string if provided`);
        }
        if (node.in && !produced.has(node.in)) {
          errors.push(`${prefix} (llm): references undefined variable "${node.in}"`);
        }
        if (node.out) produced.add(node.out);
        break;

      case 'tool':
        if (typeof node.name !== 'string' || node.name.length === 0) {
          errors.push(`${prefix} (tool): "name" must be a non-empty string`);
        }
        if (typeof node.out !== 'string' || node.out.length === 0) {
          errors.push(`${prefix} (tool): "out" must be a non-empty string`);
        }
        // args is optional; if present must be an object
        if (node.args !== undefined && (typeof node.args !== 'object' || node.args === null)) {
          errors.push(`${prefix} (tool): "args" must be an object if provided`);
        }
        if (node.out) produced.add(node.out);
        break;

      case 'condition':
        if (typeof node.var !== 'string' || node.var.length === 0) {
          errors.push(`${prefix} (condition): "var" must be a non-empty string`);
        }
        if (node.var && !produced.has(node.var)) {
          errors.push(`${prefix} (condition): references undefined variable "${node.var}"`);
        }
        if (!node.op || !VALID_OPS.has(node.op)) {
          errors.push(`${prefix} (condition): "op" must be one of: ${[...VALID_OPS].join(', ')}`);
        }
        // value is required for == and != ops, not for truthy/falsy
        if ((node.op === '==' || node.op === '!=') && node.value === undefined) {
          errors.push(`${prefix} (condition): "value" is required for op "${node.op}"`);
        }
        if (!Array.isArray(node.then)) {
          errors.push(`${prefix} (condition): "then" must be an array of nodes`);
        }
        // else is optional but must be an array if present
        if (node.else !== undefined && !Array.isArray(node.else)) {
          errors.push(`${prefix} (condition): "else" must be an array of nodes if provided`);
        }
        // NOTE: We do not recursively validate sub-nodes for variable references
        // because sub-nodes share the parent context and may produce new variables
        // that aren't visible at the top-level static analysis. This is a known
        // limitation — runtime will catch missing variables.
        break;

      case 'loop':
        // Must have either times or whileVar
        if (node.times === undefined && node.whileVar === undefined) {
          errors.push(`${prefix} (loop): must have either "times" (number) or "whileVar" (string)`);
        }
        if (node.times !== undefined && (typeof node.times !== 'number' || node.times < 0)) {
          errors.push(`${prefix} (loop): "times" must be a non-negative number`);
        }
        if (node.whileVar !== undefined && typeof node.whileVar !== 'string') {
          errors.push(`${prefix} (loop): "whileVar" must be a string`);
        }
        if (!Array.isArray(node.body)) {
          errors.push(`${prefix} (loop): "body" must be an array of nodes`);
        }
        break;

      case 'output':
        if (typeof node.from !== 'string' || node.from.length === 0) {
          errors.push(`${prefix} (output): "from" must be a non-empty string`);
        }
        if (node.from && !produced.has(node.from)) {
          errors.push(`${prefix} (output): references undefined variable "${node.from}"`);
        }
        break;
    }
  }

  return { ok: errors.length === 0, errors };
}
