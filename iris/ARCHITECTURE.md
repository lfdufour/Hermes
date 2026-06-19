# Iris — Architecture

> Iris is an in-browser chat over **Gemma 4** (E2B / E4B) with **reasoning + tools**, built for
> *inference and debugging* — you see the exact prompt sent, the model's internal **thinking**,
> every **tool call** (name + args), every **tool result**, and the final answer. Tools include
> reading and writing files held **in the browser** (uploaded in, downloaded out). It is designed so
> that **programmable workflows** can be layered on later without re-architecting.
>
> Iris is a sibling of Hermes in this repo. **Hermes is never modified.** Iris is clean-room.

## Design decisions (locked)

| Decision | Choice |
| --- | --- |
| Models | **QAT-mobile only**, `E2B` (default) + `E4B` (switchable). **Text-only** — no vision/audio in v1. |
| Packaging | **No build step.** A single `iris/index.html`, vanilla JS + ES modules from CDN, like Hermes. |
| Codebase | **Clean-room.** Borrow ideas from Hermes, not code. No coupling. |
| Runtime | `@huggingface/transformers` v3, `device:"webgpu"`, `dtype:"q4f16"`. |
| Target | Chromium + WebGPU, served over `localhost` / GitHub Pages (not `file://`). |

Rationale for text-only QAT-mobile default: smallest RAM/VRAM footprint for a limited-RAM laptop.
The standard multimodal builds bundle vision + audio encoders and are intentionally out of scope for
v1; the model layer leaves a seam to add them later (see *Future*).

## Models

| Preset | Repo | Notes |
| --- | --- | --- |
| **E2B QAT-mobile** (default) | `onnx-community/gemma-4-E2B-it-qat-mobile-ONNX` | Lightest; QAT = better quality at low bit-width. |
| **E4B QAT-mobile** | `onnx-community/gemma-4-E4B-it-qat-mobile-ONNX` | Higher quality, more RAM/VRAM. |

- Loaded text-only: the engine must **not** load vision/audio sub-models even if present in the repo
  (verify the exact module set from the model's `config.json` / file listing; load only the language
  decoder + embeddings + LM head). This is a correctness *and* memory requirement.
- `dtype: "q4f16"`, `device: "webgpu"`. Per-module dtype override is available if a sub-module needs it.
- The `webml-community/gemma-4-webgpu-kernels` custom kernels are a **later, optional** speed tweak —
  not a v1 dependency. Baseline is stock transformers.js WebGPU.

## Caching — no multi-GB re-download on refresh

transformers.js already persists model files in the browser (Cache API / IndexedDB), so a refresh
reuses cached weights automatically. On top of that, Iris adds a **Storage panel**:

- List cached models + on-disk sizes (`navigator.storage.estimate()`, plus per-model presence via
  transformers.js `ModelRegistry.is_pipeline_cached*` where available).
- "Keep cached" toggle → `navigator.storage.persist()` to resist eviction of multi-GB weights.
- Per-file **download progress** during first load (from the transformers.js `progress_callback`).
- Per-model **clear cache** button.

Served over `localhost` / Pages (not `file://`) so large-quota storage is reliable.

## Layered architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ UI  (chat pane · Inspector/Trace pane · model mgr · storage · files)  │
└───────────────┬───────────────────────────────────────┬─────────────┘
                │ trace events / commands                │
        ┌───────▼────────┐                       ┌───────▼─────────┐
        │ Agent loop      │  tool calls / results │ Tools + VFS     │
        │ (+ Trace bus)   │◄─────────────────────►│ (OPFS, uploads) │
        └───────┬────────┘                        └─────────────────┘
                │ messages / generate
        ┌───────▼─────────────┐
        │ Protocol (Gemma 4)  │  apply_chat_template + streaming parser
        └───────┬─────────────┘
                │ tokens
        ┌───────▼─────────────┐   postMessage RPC
        │ Engine (Web Worker) │◄───────────────────►  main thread
        │ transformers.js     │
        └───────┬─────────────┘
                │
        ┌───────▼─────────────┐
        │ Storage / cache mgr │
        └─────────────────────┘
```

All layers live inside the single `index.html`. The Web Worker is created from an **inlined Blob**
(`new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})), {type:'module'})`); inside
it, `import` pulls transformers.js from a pinned CDN URL. (If module-worker + CDN import proves
unreliable, fall back to running the engine on the main thread behind the same RPC interface.)

### Module contracts

These are the seams the coding agents build against. Names are normative; signatures are the intent.

**`engine/` (runs in Worker)**
```
loadModel({ repo, dtype, device, onProgress }) -> { ready }
unloadModel()
generate({ inputIds, attentionMask, genConfig, onToken, signal }) -> { outputIds, stats }
tokenizer: applyChatTemplate(messages, { tools, addGenerationPrompt, thinking }) -> inputs
            decode(ids, opts) -> string
storage: estimate() -> {usage,quota}; persist() -> bool; listCached(); clear(repo)
```
RPC: typed `postMessage` request/response + streaming events
(`token`, `progress`, `done`, `error`).

**`protocol/gemma.js`** — Gemma-4 specifics, isolated so the format can change without touching the
rest of the app.
```
buildPrompt(messages, tools, opts) -> inputs            // wraps applyChatTemplate
createStreamParser() -> { push(textDelta) -> Event[], end() -> Event[] }
   // Events: {type:'thought', delta} | {type:'content', delta} | {type:'tool_call', call}
parseToolCall(raw) -> { name, args }                    // tolerant
```
**Gemma-4 format — references & rules.** Getting Gemma calls + tool use right is the riskiest part of
this project, so the protocol layer is built carefully against authoritative sources and validated end
to end early. **Do not reference Hermes' Gemma/tool-call code** — it is known to be messy and is out of
scope. Instead:

- **Primary reference:** Unsloth's Gemma-4 docs and tool-calling guide
  (`unsloth.ai/docs/models/gemma-4`, `unsloth.ai/docs/basics/tool-calling-guide-for-local-llms`),
  Google's Gemma-4 prompt-formatting / function-calling / thinking docs, and — authoritatively — the
  model's own `tokenizer_config.json` chat template.
- **Thinking:** enabled by placing `<|think|>` at the start of the system prompt; the model emits its
  reasoning as a thought channel, e.g. `<|channel>thought\n…<channel|>`, followed by the final answer.
- **Tool calls:** emitted as a tool-call channel, e.g. `<|tool_call>call:NAME{…json args…}<tool_call|>`.
- **Multi-turn:** historical assistant turns keep only their *final response* (thoughts dropped), except
  thoughts are retained *within* a turn that issues tool calls.

The exact token strings above are treated as **to-be-confirmed against the live model files**, not
hardcoded from training memory. Build flow: capture real sample outputs from the loaded model →
write the tolerant parser (handles missing/empty thought blocks, partial streams, multiple tool calls)
→ unit-test it against those captures → validate a full round-trip tool call before building UI on top.
Prefer the tokenizer's own `apply_chat_template` for *encoding* so we don't re-implement the prompt
format; the parser only handles *decoding* the emitted channels.

**`tools/`**
```
registry.register(tool)   tool = { name, description, parameters /*JSON-schema*/, run(args, ctx) -> result }
registry.list() -> toolSpecs   // fed to protocol.buildPrompt({tools})
registry.invoke(name, args, ctx) -> result
vfs (OPFS-backed): read_file, write_file, list_files, delete_file, stat
io: uploadFiles() (drag-drop/picker -> VFS) ; downloadFile(path) (Blob save / File System Access API)
builtins: read_file, write_file, list_files, delete_file, calculator, now  (js_eval optional, sandboxed)
```
Tool shape is intentionally identical to a workflow node's "tool" node (see *Future*).

**`agent/loop.js`**
```
run({ messages, tools, genConfig, onTrace, signal }) -> finalMessage
// loop: buildPrompt -> generate(stream) -> parse -> if tool_calls: invoke + append results + repeat
//       else: finish.  Emits onTrace(event) for every step.
```
**Trace events** (the debug substrate): `prompt_built` (exact text + token count), `thought_delta`,
`content_delta`, `tool_call` (name, args), `tool_result` (value, ms), `step_done`
(tokens, tokens/sec), `turn_done`. Both raw and cleaned message histories are retained.

**`ui/`** — chat pane + **Inspector/Trace** pane rendering the timeline above (collapsible thinking,
pretty-printed tool args/results, the verbatim rendered prompt, raw-token toggle, timings) + model
manager (pick E2B/E4B, load/unload, progress) + storage panel + file manager (browse OPFS,
upload/download) + settings (temperature, top_p, max_new_tokens, thinking on/off, system prompt).

## Conversation / message model

- `messages: { role: 'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?, thoughts? }[]`
- Multi-turn rule (Gemma guidance): keep `thoughts` **within** a turn that issues tool calls; drop
  thoughts from prior *completed* turns when re-rendering the prompt. Store full trace separately so
  the Inspector can still show everything.

## Future — programmable workflows (designed for, not built in v1)

A `Workflow` is a JSON-serializable directed graph of typed nodes over a shared `context` (variables):

- Node types: `input`, `llm` (prompt template + model + thinking/tools config), `tool`, `condition`,
  `loop`/`map`, `output`.
- The chat **agent loop is itself a built-in workflow** (one `llm` node with tools + the agent loop),
  so the workflow runner is exercised from day one even before any visual editor exists.
- v1 deliverable: the schema + a headless runner + run chat through it. Later: a visual node editor and
  a library of saved workflows (persisted to OPFS/localStorage).

This is Iris-specific design (Unsloth has no browser-workflow equivalent); planning it now keeps the
tool/agent interfaces stable.

## Distribution & requirements

- Single file at `iris/index.html` → `https://lfdufour.github.io/Hermes/iris/` on Pages, or
  `python3 -m http.server` locally. Repo root already has `.nojekyll`.
- Chromium-based browser with WebGPU. ~ a few GB of free VRAM for E2B; more for E4B.

## Build plan (coding phase — dispatched after approval)

Opus locks the contracts above, then runs Sonnet/Haiku agents per layer, integrates, and reviews:

1. **Skeleton + Engine + Storage** — `index.html` shell, inlined Blob worker, `loadModel`/`generate`
   streaming for E2B QAT-mobile text-only, download progress, storage panel. *Milestone: tokens stream
   to the page.*
2. **Protocol** — `apply_chat_template` (+ tools + thinking) and the streaming thought/tool_call/content
   parser; exact tokens derived from real model files; unit-tested.
3. **Tools + VFS** — OPFS filesystem, upload/download, registry, built-in file/calc tools.
4. **Agent loop + Trace** — the tool-using loop and trace event bus.
5. **UI / Inspector** — chat + the Unsloth-style debug timeline + model manager + file manager + settings.
6. **Workflow runner** — schema + headless runner; re-express the chat loop as a workflow.

Each agent gets a strict contract (the module interfaces above), a self-check (load model / stream /
call a file tool), and must not touch Hermes files.

## Risks / open items

- **Gemma calls + tool use (highest risk).** This is where the Hermes build got messy, so Iris isolates
  it in `protocol/gemma.js`, follows Unsloth + Google formats + the live tokenizer, captures real outputs,
  unit-tests the parser, and validates a full tool round-trip *before* any UI is layered on. No reuse of
  Hermes' Gemma/tool code.
- **Module worker from Blob + CDN import** under Pages — primary path; main-thread fallback documented.
- **Text-only sub-model loading** for the QAT-mobile multimodal-capable repos — must confirm only the
  language model loads (memory). Verified against the real `config.json` during step 1–2.
- **Multi-GB Cache API quota** — mitigated via `storage.persist()` and the Storage panel; localhost/Pages
  origin (not `file://`).
</content>
</invoke>
