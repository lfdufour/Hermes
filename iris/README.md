# Iris

Iris is an in-browser chat over Google's **Gemma 4** (E2B / E4B, QAT-mobile) that runs **fully
client-side** via [transformers.js](https://github.com/huggingface/transformers.js) + **WebGPU** — no
server, no API keys, nothing leaves your machine. Its distinguishing feature is an **Unsloth-style
debugging Inspector** that exposes the model's internal **thinking**, **tool calls**, and **tool
results** inline, so you can see exactly what the model is doing. Built-in tools include an in-browser
**filesystem** (OPFS) so the model can read and write files you upload and download. Weights download
once and are **cached by the browser** across reloads.

Iris is a sibling to **Hermes** — it lives in this repo under `iris/` but is an independent app and does
not touch Hermes.

## Status

Implemented and unit-tested (Node) end-to-end at the logic layer (protocol, tools, agent loop,
workflow). The in-browser path (WebGPU model load, OPFS, live streaming) needs its **first validation in
Chrome** — see *Validate it* below.

## Requirements

- A Chromium-based browser (Chrome / Edge) **113+ with WebGPU**.
- Served over **http(s), not `file://`** (ES-module workers + OPFS need a real origin) — same as Hermes.
- First load downloads the model (E2B QAT-mobile is the smallest, ~couple GB); later loads use the cache.

## Run it

From the repo root:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/iris/>. Pick a model (**E2B** is the low-RAM default), click **Load**, wait
for the download progress, then chat. (Also deployable on GitHub Pages at `/Hermes/iris/`.)

## Using it

- Type a message; the answer streams in.
- The **Inspector** under each message shows: a *"N tool calls"* summary, a collapsible **Thinking**
  block (live), expandable **tool calls** with their arguments + results, and the final answer.
- Toggle **Debug** (top bar) to also see the verbatim prompt sent to the model, the raw token stream,
  and per-step timings / tokens-per-sec.
- **Tools**: the model can `read_file` / `write_file` / `list_files` / `delete_file` against an
  in-browser filesystem (OPFS), plus `calculator` / `now`. Use the **File** panel to upload files
  (drag-drop) and download what the model writes.
- **Settings**: temperature, top_p, max tokens, thinking on/off, system prompt (persisted locally).
- **Storage** panel: see cache usage, request *persistent* storage (so weights aren't evicted), or
  clear the cache.

## Validate it (first in-browser run — what to check)

1. **Caching**: after the first load, reload the page — the second load should be near-instant. Use the
   Storage panel → *Keep cached (persist)* to avoid eviction.
2. **Streaming**: thinking + answer stream into the Inspector.
3. **Tools**: try *"use the calculator to compute 19*23"* or *"write a file notes.txt containing hello,
   then read it back"* — confirm the tool call + result appear and the file shows in the File panel.
4. **If thinking/tool parsing looks off**: open **Debug** → check the rendered prompt and the tokenizer
   info dump. The Gemma-4 control tokens in `src/protocol/gemma.js` are marked `// VERIFY` and may need
   to match the tokenizer's actual special tokens (shown by the `tokenizerInfo` dump). This is the most
   likely first adjustment.

## Known seams / caveats

- **Model loading** tries the text-only causal-LM head first and falls back to the multimodal class
  (`src/engine/worker.js`, the single documented seam). Gemma 4 is multimodal; Iris only ever feeds text.
- **transformers.js** is loaded from a CDN (jsDelivr, latest v3) inside the worker.
- **Single-file build**: Iris currently runs as `index.html` + ES modules + a module worker (served). A
  single self-contained `index.html` (inlined worker/modules) is a planned finishing step, deferred
  until in-browser behavior is confirmed.
- **Workflows**: a headless workflow runner (`src/workflow/`) is in place (chat is the default
  workflow); a visual builder is future work.

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) (design + rationale) and [`CONTRACTS.md`](./CONTRACTS.md)
(module APIs). Unit tests:

```bash
node src/protocol/gemma.test.mjs
node src/tools/tools.test.mjs
node src/agent/loop.test.mjs
node src/workflow/workflow.test.mjs
```
