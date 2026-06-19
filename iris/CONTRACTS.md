# Iris — Implementation Contracts

**Read this fully before coding.** It is the single source of truth for file layout, shared types, the
worker RPC, and every module's API. Rationale lives in `ARCHITECTURE.md`. If a contract here is
unworkable, stop and flag it — do not silently diverge.

## Hard rules for every agent
- **Vanilla ES modules. No framework, no bundler, no `npm install`.** The only runtime dependency is
  `@huggingface/transformers` v3, imported from a CDN **inside the worker only**.
- Target: **Chromium + WebGPU, served over http(s)** (localhost / GitHub Pages), **not `file://`**.
- **Do not run any git commands. Do not commit or push.** The architect integrates and commits.
- **Only create/edit files inside your assigned set, all under `iris/`.** Never touch repo-root
  `index.html`, `README.md`, `ARCHITECTURE.md`, `LICENSE`, `.nojekyll` — those are **Hermes**.
- **Do not reuse or read Hermes code** for Gemma/tool handling; it is known-messy and out of scope.
- Each module is an ES module with **named exports exactly as specified below**.
- Keep code small, readable, function-level comments. No external asset files (no images/fonts).
- Where you make a judgment call (e.g. how to skip vision/audio submodels), **leave a short `// NOTE:`**
  explaining what you chose and why.

## Dev structure vs final delivery
- **DEV (what you build):** `iris/index.html` loads `iris/src/main.js` via `<script type="module">`.
  Modules import each other by **relative path**. The worker is loaded as
  `new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' })`.
- **DELIVERY (architect does later):** everything is inlined into a single `iris/index.html` (worker
  becomes a Blob URL). Write code so this is mechanical: no reliance on non-JS asset files; all CSS in
  `iris/index.html` (or a single `iris/src/styles.css`). Avoid `import.meta.url` tricks beyond the one
  worker line above.

## File layout
```
iris/
  index.html              # shell: HTML + CSS + <script type="module" src="./src/main.js">
  src/
    types.js              # JSDoc typedefs only (no runtime code) — shared vocabulary
    main.js               # app bootstrap: instantiate modules, wire UI<->agent<->engine
    engine/
      worker.js           # module worker: transformers.js load/generate/decode/storage
      client.js           # main-thread RPC client wrapping the worker
    protocol/
      gemma.js            # buildPrompt + stream parser + parseToolCall
      gemma.test.mjs      # node-runnable unit tests (no deps)
    tools/
      vfs.js              # OPFS-backed filesystem
      io.js               # upload (picker/drag-drop) + download (Blob / File System Access)
      registry.js         # tool registry
      builtins.js         # read_file/write_file/list_files/delete_file/calculator/now
      tools.test.mjs      # node-runnable tests for registry + calculator (pure logic only)
    agent/
      loop.js             # tool-using generation loop
      trace.js            # trace event bus + types
    workflow/
      schema.js           # workflow JSON schema + validation
      runner.js           # headless runner; chat loop expressed as a workflow
      workflow.test.mjs   # node-runnable tests
    ui/
      app.js              # top-level UI controller (owns DOM, subscribes to trace)
      chat.js             # message list + composer
      inspector.js        # the trace/debug timeline (see ARCHITECTURE "Inspector layout")
      modelManager.js     # model picker, load/unload, download progress
      storagePanel.js     # cache list/size/persist/clear
      fileManager.js      # browse OPFS, upload/download
      settings.js         # temperature/top_p/max_new_tokens/thinking/system prompt
    styles.css            # (optional) all styles, or keep them in index.html
  ARCHITECTURE.md  CONTRACTS.md
```

## Shared types  (`src/types.js` — JSDoc only)
```js
/** @typedef {{role:'system'|'user'|'assistant'|'tool', content:string,
 *   tool_calls?:ToolCall[], tool_call_id?:string, thoughts?:string}} Message */
/** @typedef {{name:string, description:string, parameters:object /*JSON-schema*/}} ToolSpec */
/** @typedef {{id:string, name:string, args:object}} ToolCall */
/** @typedef {{tool_call_id:string, name:string, ok:boolean, value:any, error?:string, ms:number}} ToolResult */
/** @typedef {{temperature:number, top_p:number, top_k?:number, max_new_tokens:number,
 *   do_sample:boolean, repetition_penalty?:number}} GenConfig */
/** @typedef {{id:'E2B'|'E4B', label:string, repo:string, dtype:string}} ModelPreset */
/** TraceEvent (discriminated by .type):
 *  {type:'prompt_built', text:string, tokenCount:number}
 *  {type:'thought_delta', delta:string} | {type:'content_delta', delta:string}
 *  {type:'tool_call', call:ToolCall} | {type:'tool_result', result:ToolResult}
 *  {type:'step_done', tokens:number, ms:number, tokensPerSec:number}
 *  {type:'turn_done'} | {type:'error', message:string} */
```

## Model presets
```js
export const MODELS = [
  { id:'E2B', label:'Gemma 4 E2B (QAT-mobile)', repo:'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX', dtype:'q4f16' }, // default
  { id:'E4B', label:'Gemma 4 E4B (QAT-mobile)', repo:'onnx-community/gemma-4-E4B-it-qat-mobile-ONNX', dtype:'q4f16' },
];
```
- Device `'webgpu'`. **Text-only**: load only the language model; do **not** load vision/audio
  submodels. Inspect the repo's `config.json`/file list and pick the loading path that pulls only text
  weights (e.g. a causal-LM path, or per-module dtype that omits encoders). Document the choice with a
  `// NOTE:`. If transformers.js insists on multimodal, load it but never pass image/audio inputs and
  flag the memory caveat.
- transformers.js import (worker): `import { ... } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers';`
  (latest v3 — gemma4 needs a recent version). Set `env.allowLocalModels=false`. Use
  `progress_callback` for download progress. Leave a `// NOTE:` with the version you resolved.

## Worker RPC  (`engine/worker.js` ⇄ `engine/client.js`)
Messages are `{ id, type, payload }`. Requests get a matching response with the same `id`; streaming
emits intermediate events with the same `id`.

Main → Worker:
- `load` `{repo,dtype,device}` → progress events, then `loaded` `{}` or `error`.
- `unload` `{}` → `ok`.
- `applyChatTemplate` `{messages, tools, addGenerationPrompt:true, thinking:boolean}` →
  `templated` `{ input_ids /*transferable or array*/, rendered /*string for Debug view*/ }`.
- `generate` `{input_ids, genConfig}` → stream of `token` `{text, id}`, then
  `generated` `{outputText, stats:{tokens, ms, tokensPerSec}}`, or `error`. Honors `cancel`.
- `decode` `{ids}` → `decoded` `{text}`.
- `cancel` `{}` → stops the in-flight generate.
- `storage` `{op:'estimate'|'persist'|'list'|'clear', repo?}` → `storage` `{result}`.

`engine/client.js` exports a class `EngineClient` (extends `EventTarget`):
```
new EngineClient()                                  // creates the worker
await load({repo,dtype,device, onProgress})         // onProgress({file,loaded,total,pct})
await unload()
await applyChatTemplate({messages,tools,thinking})  // -> {input_ids, rendered}
generate({input_ids, genConfig, onToken})           // -> Promise<{outputText, stats}>; onToken({text,id})
cancel()
await decode(ids)
await storage(op, repo?)                             // estimate|persist|list|clear
```

## protocol/gemma.js  (the highest-risk module)
```
buildMessagesForPrompt(messages, {thinking}) -> Message[]   // applies multi-turn thought rule
toolSpecsToTemplate(tools) -> ToolSpec[]                    // pass-through/shape for apply_chat_template
createStreamParser() -> {
  push(textDelta) -> TraceEvent[]   // any of thought_delta|content_delta|tool_call
  end() -> TraceEvent[]             // flush; emit trailing tool_call/content if buffered
}
parseToolCall(raw) -> ToolCall      // tolerant: NAME + JSON args; best-effort JSON repair
splitFinal(outputText) -> {thoughts:string, content:string, tool_calls:ToolCall[]}  // non-streaming parse
```
- **Encoding is done by the tokenizer** via the worker's `applyChatTemplate`; `gemma.js` only (a) shapes
  messages/tools for it and applies the **multi-turn thought rule** (drop thoughts from completed prior
  assistant turns; keep thoughts within a turn that has tool_calls), and (b) **parses** model output.
- Output markers to handle (**VERIFY against the model's `tokenizer_config.json` special tokens; treat
  these as provisional and correct them from the real file**):
  - thinking channel: `<|channel>thought\n … <channel|>`  (also handle empty/missing).
  - tool call: `<|tool_call>call:NAME{ …json… }<tool_call|>`  (also handle multiple, and args JSON that
    uses single quotes / trailing commas → best-effort repair).
- The streaming parser must be robust to markers split across chunk boundaries (buffer partial tokens).
- `gemma.test.mjs` (node, zero deps, `node gemma.test.mjs` prints PASS/FAIL and exits non-zero on fail)
  covers: plain answer; answer+thinking; single tool call; multiple tool calls; tool call without
  thinking; markers split across stream chunks; malformed JSON repair.

## tools/  (VFS + registry + builtins)
```
// vfs.js — OPFS-backed (async). All paths are POSIX-like under an Iris root dir.
vfs = { readFile(path)->string|Uint8Array, writeFile(path,data)->void,
        listFiles(dir='/')->{name,path,size,kind}[], deleteFile(path)->void, stat(path)->{...},
        exists(path)->bool }
// io.js
uploadFiles() -> File[]        // open picker; also export attachDropZone(el, onFiles)
saveDownload(name, data)       // Blob -> download; use showSaveFilePicker when available
// registry.js
class ToolRegistry { register(tool); list()->ToolSpec[]; has(name); async invoke(name,args,ctx)->ToolResult }
//   tool = { name, description, parameters /*JSON-schema*/, run(args, ctx)->Promise<any> }
// builtins.js
registerBuiltins(registry, {vfs}) // adds: read_file{path}, write_file{path,content},
//   list_files{dir?}, delete_file{path}, calculator{expression}, now{}
```
- `invoke` wraps `run` with timing + try/catch → `ToolResult` (never throws to caller).
- `calculator` must be safe (no `eval` of arbitrary JS; parse a math expression). Keep it small.
- `tools.test.mjs` (node): test registry register/list/invoke (with an in-memory fake fs) and the
  calculator. (OPFS itself is browser-only — keep OPFS calls behind `vfs.js`; test the registry against a
  fake `vfs` object so tests run under node.)

## agent/  (loop + trace)
```
// trace.js
class TraceBus extends EventTarget { emit(ev:TraceEvent); }  // UI subscribes via addEventListener('trace', e=>e.detail)
// loop.js
async runAgent({ engine:EngineClient, protocol, registry:ToolRegistry, messages, genConfig,
                 thinking, maxSteps, trace:TraceBus, signal }) -> { messages, finalText }
//   loop: applyChatTemplate -> generate(stream; feed deltas through protocol parser -> trace events)
//         -> splitFinal -> if tool_calls: registry.invoke each (emit tool_result), append assistant
//            (with tool_calls+thoughts) + tool messages, repeat; else append final assistant + finish.
//         Respect maxSteps (default 6) and signal (abort).
```

## workflow/  (future-proofing; build the headless core now)
```
// schema.js: node types input|llm|tool|condition|loop|output; validate(workflow)->{ok,errors}
// runner.js: async runWorkflow(workflow, {engine, protocol, registry, trace, context}) -> context
//   The default chat is workflow [{type:'input'},{type:'llm', tools:'*', agentLoop:true},{type:'output'}]
//   i.e. the agent loop is invoked from the 'llm' node. Keep it minimal but real.
// workflow.test.mjs: validate() happy/sad paths; run a trivial 2-node workflow with a stubbed llm node.
```

## ui/  (see ARCHITECTURE "Inspector layout")
- `app.js` owns the DOM, instantiates EngineClient + ToolRegistry + TraceBus, runs the agent loop on
  send, and subscribes to the trace to render the Inspector inline under each user message.
- Inspector per turn: a "N tool calls" summary; a collapsible **Thinking** block (streams live);
  per-tool-call expandable lines (`Used tool: NAME(args)` → args + result chips; for file tools show
  path + content preview); the final answer. A **Debug** toggle reveals `prompt_built.text`, raw tokens,
  and per-step timings/tokens-per-sec.
- Controls: model picker (E2B default/E4B, load/unload, progress bar from `onProgress`), storage panel
  (estimate/persist/clear), file manager (list OPFS, upload via `io.uploadFiles`/dropzone, download),
  settings (temperature, top_p, max_new_tokens, thinking on/off, system prompt). Clean, minimal CSS.

## Per-agent self-check
- **Runnable (node):** `node <your>.test.mjs` must print PASS and exit 0 (protocol, tools, workflow).
- **Not runnable here (browser/WebGPU/OPFS):** ensure code at least parses (e.g. `node --check file.js`
  for non-module-import files, or import in a tiny node harness that mocks browser globals). State in
  your final report exactly what you verified vs. what needs in-browser validation by the user.
</content>
