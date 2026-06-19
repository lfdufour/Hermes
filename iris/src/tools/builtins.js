/**
 * builtins.js — Built-in tools for Iris.
 *
 * Registers: read_file, write_file, list_files, delete_file, calculator, now.
 * The calculator uses a recursive-descent parser — NO eval/Function.
 *
 * Exports: registerBuiltins, evaluate (calculator function, exported for testing)
 */

// ---------------------------------------------------------------------------
// Safe math expression evaluator — recursive-descent parser
// Supports: + - * / % ^ ( ) unary minus, decimal numbers
// Precedence (low→high): +- , */ % , ^ (right-assoc), unary -
// ---------------------------------------------------------------------------

/**
 * Tokenize a math expression string into numbers, operators, and parentheses.
 * @param {string} expr
 * @returns {Array<{type:string, value:string|number}>}
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }

    // Number (integer or decimal)
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = '';
      let hasDot = false;
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
        if (expr[i] === '.') {
          if (hasDot) throw new Error('Invalid number: multiple decimal points');
          hasDot = true;
        }
        num += expr[i++];
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    if ('+-*/%^()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    throw new Error(`Unexpected character: "${ch}"`);
  }
  return tokens;
}

/**
 * Evaluate a math expression string safely (no eval).
 * @param {string} expr
 * @returns {number}
 */
export function evaluate(expr) {
  if (typeof expr !== 'string') throw new Error('Expression must be a string');
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('Empty expression');

  const tokens = tokenize(trimmed);
  let pos = 0;

  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function consume() { return tokens[pos++]; }

  // Grammar:
  //   expr     → term (('+' | '-') term)*
  //   term     → power (('*' | '/' | '%') power)*
  //   power    → unary ('^' power)?       — right-associative
  //   unary    → '-' unary | primary
  //   primary  → NUMBER | '(' expr ')'

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parsePower();
    while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parsePower();
      if (op === '*') left = left * right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left = left / right;
      } else {
        if (right === 0) throw new Error('Modulo by zero');
        left = left % right;
      }
    }
    return left;
  }

  function parsePower() {
    const base = parseUnary();
    if (peek() && peek().value === '^') {
      consume();
      // Right-associative: parse power recursively
      const exp = parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary() {
    if (peek() && peek().value === '-') {
      consume();
      return -parseUnary();
    }
    if (peek() && peek().value === '+') {
      consume();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.type === 'number') {
      consume();
      return tok.value;
    }

    if (tok.value === '(') {
      consume(); // eat '('
      const val = parseExpr();
      const closing = consume();
      if (!closing || closing.value !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      return val;
    }

    throw new Error(`Unexpected token: "${tok.value}"`);
  }

  const result = parseExpr();

  // Ensure all tokens consumed
  if (pos < tokens.length) {
    throw new Error(`Unexpected token after expression: "${tokens[pos].value}"`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Built-in tool definitions
// ---------------------------------------------------------------------------

/**
 * Resolve a tool's target file to a VFS path, accepting either an explicit
 * `path` or a `tag` (resolved via the tag registry). Tags let the user refer to
 * uploaded files by a friendly name in chat.
 * @param {{path?:string, tag?:string}} args
 * @param {import('./fileTags.js').fileTags} [fileTags]
 * @returns {string}
 */
function resolveTarget(args, fileTags) {
  if (args && args.tag) {
    const path = fileTags && fileTags.get(args.tag);
    if (!path) throw new Error(`No file is tagged "${args.tag}". Use list_tagged_files to see available tags.`);
    return path;
  }
  if (args && args.path) return args.path;
  throw new Error('Provide a file "path" or a "tag".');
}

/**
 * Register all built-in tools on the given registry.
 * @param {import('./registry.js').ToolRegistry} registry
 * @param {{ vfs: import('./vfs.js').vfs, fileTags?: import('./fileTags.js').fileTags }} deps
 */
export function registerBuiltins(registry, { vfs, fileTags }) {
  registry.register({
    name: 'read_file',
    description: 'Read a file from the virtual filesystem. Identify it by "path", or by "tag" to read a file the user tagged (e.g. {"tag":"report"}).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        tag: { type: 'string', description: 'Tag of an uploaded file to read (alternative to path)' },
      },
    },
    async run(args) {
      return await vfs.readFile(resolveTarget(args, fileTags));
    },
  });

  registry.register({
    name: 'write_file',
    description: 'Write content to a file in the virtual filesystem (creating directories as needed). Target it by "path", or by "tag" to overwrite a file the user tagged (e.g. {"tag":"notes","content":"..."}).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        tag: { type: 'string', description: 'Tag of an uploaded file to overwrite (alternative to path)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['content'],
    },
    async run(args) {
      const target = resolveTarget(args, fileTags);
      await vfs.writeFile(target, args.content);
      return `Wrote ${args.content.length} bytes to ${target}`;
    },
  });

  registry.register({
    name: 'list_files',
    description: 'List files and directories in the virtual filesystem.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path to list (default: root)' },
      },
    },
    async run(args) {
      return await vfs.listFiles(args.dir || '/');
    },
  });

  registry.register({
    name: 'list_tagged_files',
    description: 'List the uploaded files that have a tag name, so you can read or write them by tag.',
    parameters: { type: 'object', properties: {} },
    async run() {
      if (!fileTags) return [];
      const out = [];
      for (const { tag, path } of fileTags.list()) {
        let size = 0;
        try { size = (await vfs.stat(path)).size; } catch (_) { /* file may be gone */ }
        out.push({ tag, path, size });
      }
      return out;
    },
  });

  registry.register({
    name: 'delete_file',
    description: 'Delete a file from the virtual filesystem, by "path" or by "tag".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete' },
        tag: { type: 'string', description: 'Tag of an uploaded file to delete (alternative to path)' },
      },
    },
    async run(args) {
      const target = resolveTarget(args, fileTags);
      await vfs.deleteFile(target);
      if (fileTags) fileTags.removeByPath(target);
      return `Deleted ${target}`;
    },
  });

  registry.register({
    name: 'calculator',
    description: 'Evaluate a mathematical expression. Supports +, -, *, /, %, ^ (power), parentheses, and decimal numbers.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression to evaluate' },
      },
      required: ['expression'],
    },
    async run(args) {
      return evaluate(args.expression);
    },
  });

  registry.register({
    name: 'now',
    description: 'Return the current date and time as an ISO 8601 string.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async run() {
      return new Date().toISOString();
    },
  });
}
