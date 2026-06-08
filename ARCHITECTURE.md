# Architecture

## Design Principles

### Local-first and offline-capable

Hermes is built on the principle that your data and reasoning stay on your machine. The app downloads models and libraries once (cached by the browser) and then operates entirely offline. There is no back-end server; there is no user account or cloud sync. A "Network ledger" makes visible any outbound request, so you are never surprised by what leaves your device.

### Single-file deployment

The entire application is a single `index.html` file. It uses ES-module imports to load libraries and models from CDNs and the browser cache. This trade-off (complexity vs. no build step) allows Hermes to run anywhere a modern browser exists: no installation, no Node.js, no Docker — just open a file.

### Offline-online boundary

- **Offline (deterministic, cached, local)**: speech-to-text, language model inference, command routing, memory lookups, text-to-speech.
- **Online (explicit, user-initiated)**: model weight downloads, web searches, cloud model calls, URL fetches.

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          UI Shell                                │
│  (conversation display, input, model/language selectors, logs)   │
└──────────┬──────────────────────────────────────────────────────┘
           │
    ┌──────▼────────────────────────────────────────────────────┐
    │           Agentic Command / Tool Loop                     │
    │  (routes user input, calls tools, assembles final answer) │
    └──────┬──────────────────────────────────────────────────┘
           │
      ┌────┴────────────────────────────┬──────────────────────┐
      │                                 │                      │
┌─────▼──────────┐ ┌────────────────────▼──┐ ┌────────────────▼──┐
│ Local LLM      │ │  Tool Catalogue       │ │ Voice / Search    │
│ Runtime        │ │                       │ │ / Memory Layer    │
├────────────────┤ ├──────────────────────┤ ├──────────────────┤
│ • WebLLM       │ │ • Web Search         │ │ • Whisper ASR    │
│ • WebGPU       │ │ • URL Fetch          │ │ • TTS            │
│ • Model        │ │ • Calc               │ │ • Remember/Recall│
│   Manager      │ │ • Mem ops            │ │ • Search         │
│ (load/unload)  │ │ • Lang switch        │ │   Providers      │
└────────────────┘ │ • Model switch       │ └──────────────────┘
                   │ • Custom tools       │
                   └──────────────────────┘
       │
   ┌───▼────────────────────────────────┬──────────────────────┐
   │                                    │                      │
┌──▼───────────────────┐ ┌──────────────▼──┐ ┌────────────────▼─┐
│ Cloud Model          │ │ Persistence     │ │ Network Ledger  │
│ Adapters             │ │                 │ │                 │
├──────────────────────┤ ├─────────────────┤ ├─────────────────┤
│ • OpenAI-compat      │ │ • localStorage  │ │ • Request log   │
│ • Gemini             │ │ • IndexedDB     │ │ • Outbound req  │
│ • Custom endpoints   │ │ • Model cache   │ │   tracking      │
└──────────────────────┘ │ • Settings      │ └─────────────────┘
                         │ • History       │
                         │ • Keys (secure) │
                         └─────────────────┘
```

## Key Components

### 1. UI Shell

The web interface presents:
- **Conversation display**: Messages from user and assistant, with tool calls and results shown inline.
- **Input area**: Text box and microphone button.
- **Model selector**: Dropdown to choose from loaded models; button to open Model Manager.
- **Language toggle**: Quick switch between French and English.
- **Settings panel**: API keys, TTS toggle, cache management, history export/clear.
- **Network ledger**: Timeline of outbound requests with status and payload summaries.

### 2. Local LLM Runtime

**WebLLM + WebGPU**: Models run in the browser using WebGPU for hardware acceleration. This is the core of offline capability.

**Model Manager**:
- Lists available models and their cache status.
- Downloads and stores models in IndexedDB (large blobs) and browser cache (tensors).
- Supports hot-swapping: unload one model, load another, without restarting.
- Tracks download progress and storage usage.

### 3. Voice & Sensory Input

**Speech-to-text (Whisper via transformers.js)**:
- Captures audio at 16 kHz mono from the microphone.
- Runs Whisper inference locally (WebAssembly/WASM).
- Supports French and English; language selection affects transcription.
- Latency: typically 1–5 seconds per utterance, depending on hardware.

**Text-to-speech (optional)**:
- Converts assistant responses to speech using browser TTS API or local synthesis.
- User can enable/disable; stored in settings.

### 4. Agentic Command & Tool Loop

The heart of the assistant. Process:

1. **Input stage**: User types or speaks. Text is normalized (lowercased, punctuation cleaned).
2. **Deterministic pre-router**: Checks for simple commands (e.g., "remember X", "switch to French") and routes them without LLM inference.
3. **LLM inference** (if not handled by pre-router): Sends the prompt to the local or cloud model with a tool-calling prompt template.
4. **Tool parsing**: Model output is parsed for tool calls. If the model requests a tool (e.g., `<call_tool name="search" query="X">`), the tool is invoked.
5. **Tool execution**: The app calls the tool (e.g., search, fetch URL, memory lookup) and collects the result.
6. **Result feeding**: The result is returned to the model (in-context) for the next turn.
7. **Final answer**: Once the model produces a non-tool response or max iterations are reached, the answer is displayed.

**Tool catalogue** (expandable):
- **web_search**: Call Google Search via Gemini grounding. Returns snippets and links.
- **fetch_url**: Retrieve and parse the content of a URL (subject to CORS).
- **remember**: Store a fact in memory. Updates the local store and notifies the memory system.
- **recall**: Query the memory system for relevant past facts.
- **calculate**: Evaluate a mathematical expression.
- **switch_language**: Change voice language to FR or EN.
- **switch_model**: Load a different language model.
- **search_provider_toggle**: Switch between search providers.

### 5. Search Provider Abstraction

**Primary: Google Gemini grounding**
- Google performs the search; we receive results.
- Requires a Gemini API key.

**Alternatives** (pluggable):
- Programmable Search Engine (PSE) with custom search engine ID.
- Other providers (Brave, etc.) via custom adapters.

Results are parsed locally; the app decides what to show the user.

### 6. Cloud Model Adapters

If the local model is unavailable or the user prefers a cloud fallback:

- **OpenAI-compatible**: Accepts any endpoint that matches the OpenAI API (e.g., LM Studio, Ollama, vLLM).
- **Gemini**: Native Gemini API calls.
- **Other**: Extensible; new providers can be added.

Each adapter stores the API key securely (localStorage only, never sent to the app's servers because there are none).

### 7. Conversation & Memory Store

**Flat history** (current):
- Array of `{ role, content, timestamp, tools_used }` objects.
- Stored in localStorage.
- Exported as JSON or markdown for backup.

**Remember/recall system** (current):
- Simple key-value store in localStorage.
- User can `remember [fact]` and `recall [query]`.
- Facts are indexed and retrieved by substring matching.

**Future: Tree-structured topic memory**
- See "Future Work" below.

### 8. Persistence

All data is stored in the browser:

- **localStorage**: Small, key-value data (settings, API keys, flat conversation history).
- **IndexedDB**: Large blobs (model weights, cached downloads).
- **Browser cache**: HTTP caching of library files and models (via CDN headers).

No data is sent to any server. Users can:
- **Export**: Download conversation history as JSON or markdown.
- **Clear**: Wipe localStorage and IndexedDB selectively (history, cache, keys).
- **Import**: Upload a previously exported conversation.

### 9. Network Ledger

Every outbound HTTP/HTTPS request is logged:

- **Request details**: Timestamp, method, URL (with sensitive query params masked).
- **Response status**: 200, 404, etc.
- **Payload size**: Bytes sent and received.
- **User notification**: Request shown in ledger before or immediately after.

This provides transparency without blocking requests (trusting the user to review and act).

## Single-File Trade-Offs

### Why one file?

- **Portability**: Copy one file anywhere; no build step, no node_modules, no server setup.
- **Simplicity**: For small teams, reduces deployment friction.
- **Hackability**: Users can fork and modify a single file; changes are visible.

### Costs

- **Complexity**: Module loading, dynamic imports, and error handling are more manual.
- **Caching strategy**: Model weights and library files are cached separately by the browser; not bundled.
- **Large initial payload**: The HTML file references many ES modules and model weights, so first load is slow. (Mitigated by browser caching.)
- **No tree-shaking or optimization**: Every library pulled from a CDN is downloaded in full; no bundler to remove unused code.

## Tool-Calling Protocol

The app implements a deterministic protocol for model tool calls:

### Format (in model prompt)

```
If you need to use a tool, output:
<call_tool name="tool_name">
  <param name="key">value</param>
  ...
</call_tool>

Then, after the tool result is provided, continue your response.
```

### Execution

1. Model generates a tool call.
2. App parses the XML (or custom format, depending on model).
3. App invokes the tool with the given parameters.
4. Tool result is either:
   - Returned inline: `<tool_result>...</tool_result>` and fed back to the model for continuation.
   - Used to update state: (e.g., memory, language, model switch) and the response is generated locally.
5. Model continues or ends.

## Why This Architecture?

- **Privacy first**: No server involvement means no logging, no tracking, no data retention.
- **Offline resilience**: Works without internet after first model download.
- **User agency**: Transparent network activity; no hidden requests.
- **Extensibility**: New tools and models are added without changing the app's core.
- **Single-file simplicity**: Lower barrier to self-hosting or forking.

---

## Future Work

### Tree-Structured Topic Memory

The next evolution beyond flat history and simple remember/recall.

**Schema outline**:

```json
{
  "topics": [
    {
      "id": "uuid",
      "title": "Financial markets trends",
      "created": "2025-03-01T12:00:00Z",
      "last_updated": "2025-06-08T14:30:00Z",
      "context": "Accumulated facts, key dates, trends discussed",
      "children": [
        {
          "id": "uuid",
          "title": "Tech stocks",
          "context": "...",
          "conversations": [
            { "timestamp": "...", "query": "...", "summary": "..." }
          ]
        }
      ],
      "conversations": [
        { "timestamp": "...", "query": "...", "summary": "..." }
      ]
    }
  ]
}
```

**Behavior**:

- When a user asks a question, the system infers related topics (via embedding similarity or keyword matching).
- If a match is found, the relevant topic context is loaded into the system prompt, so the assistant has continuity.
- New facts are folded into the topic's context.
- Users can view the topic tree, edit branches, and manually reorganize.

**Benefits**:

- **Continuity**: Repeated questions about the same subject don't repeat explanations.
- **Deep dives**: Topics accumulate facts over many sessions.
- **Organization**: Users can browse and export by topic.
- **Context reuse**: The assistant learns the user's ongoing interests and priorities.

**Implementation**:

- Embeddings: Either use a local embedding model (via transformers.js) or simple keyword heuristics.
- Storage: Expanded IndexedDB schema to hold the topic tree.
- UI: Visual tree browser; drag-to-merge; double-click to edit topic titles/context.

---

## Glossary

- **WebGPU**: Browser GPU compute API; enables local ML inference.
- **WebAssembly (WASM)**: Browser-based bytecode; used for speech-to-text (Whisper).
- **IndexedDB**: Browser's object-store database; used for large blobs (models).
- **localStorage**: Browser's key-value store; used for settings and small data.
- **ES modules**: JavaScript modular import/export; Hermes loads libraries via `import`.
- **CORS**: Cross-Origin Resource Sharing; browser policy that blocks some URL fetches.
- **Tool call**: Request from the model for the app to execute an action (search, memory, etc.).
- **Grounding**: Providing external context (web search results) to the model prompt.
