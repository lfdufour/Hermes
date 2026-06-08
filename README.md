# Hermes

**[Try it live on GitHub Pages →](https://lfdufour.github.io/Hermes/)**

A personal AI assistant that runs entirely in your browser from a single HTML file. **Offline processing** means all speech-to-text, language model reasoning, and orchestration happen locally on your machine via WebGPU and WebAssembly — nothing about your prompts or conversations leaves your device unless you explicitly request it. **Online** capabilities let you perform web searches and optionally call cloud models when you choose, with every network request shown transparently in the Network ledger.

## Features

- **Local in-browser LLMs**: Run models directly via WebLLM and WebGPU. Built-in model manager to load, unload, and switch between multiple models without restarting.
- **Voice input**: Speech-to-text powered by Whisper (via transformers.js), supporting French and English with a language toggle.
- **Web search**: Grounded search via Google Gemini (Google runs the search; results are processed locally). Support for alternative search providers.
- **Optional cloud models**: Bring-your-own-key support for OpenAI-compatible endpoints or Gemini, to try multiple options or fall back to cloud when needed.
- **Agentic command layer**: Type or speak commands; the system interprets them and can take actions via tools: web search, fetch URLs, switch language/model, remember/recall facts, calculate, and more.
- **Local persistence**: Settings, API keys, and conversation history are stored only in your browser's localStorage.
- **Text-to-speech**: Optional local synthesis of responses.
- **Network ledger**: A transparent log of every outbound request, so you know what's leaving your device.

## Requirements & Browser Support

- **Browser**: A recent Chromium-based browser (Chrome, Edge) with WebGPU enabled. Firefox support is limited due to WebGPU.
- **WebGPU**: Required for local models and voice input. Check browser console for warnings if unavailable.
- **Microphone**: Optional, but needed for voice input. You will be prompted for permission.
- **Secure context**: Due to ES-module imports and microphone access, Hermes must be served over `http://localhost` or `https://`, not via `file://`.

## Running Hermes

### Locally (recommended for first-time setup)

Serve the HTML file over a local web server rather than opening it as a file. For example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser and navigate to `index.html`.

Alternatively, use Node.js:

```bash
npx http-server
```

### First run

On first load, the app will download model weights (often several GB) and cache them in your browser's local storage and IndexedDB. This can take several minutes depending on your internet speed and the model size. Subsequent runs use the cached weights and start much faster.

### Hosting online

If you want to serve Hermes from a public URL, use HTTPS and be aware that:
- Model weights are large and may take time to download on first visit.
- Each user's browser will cache weights separately.
- Users' conversations and keys stay in their browsers; you (the host) do not see them.

## API Keys

Some features require API keys, which are entered in the Hermes UI and stored **only in your browser's localStorage**. They are sent **only to their respective provider endpoints**.

### Google Gemini (required for web search and optional cloud model)

1. Visit [Google AI Studio](https://aistudio.google.com) (or search "Google AI Studio").
2. Sign in with a Google account and create a new API key.
3. Paste the key into Hermes' API key settings.

### Alternative search providers

You can optionally configure a Programmable Search Engine (PSE) or other search provider. See the settings UI for options.

### Other cloud model providers

If you want to use OpenAI, Anthropic, or another OpenAI-compatible endpoint, enter your API key and endpoint in the settings. Hermes will use it as a fall-back or alternative to local models.

## Privacy Model

**What stays local:**
- All prompts you type or speak.
- All reasoning by local language models.
- Your conversation history and settings.
- Your API keys (stored in localStorage only).

**What goes out (only when you initiate):**
- Web search queries (to Google, if you search).
- Prompts to cloud models (if you choose to use them).
- URL fetches (if you ask the assistant to look up a URL).

**Network ledger:** Every outbound request is logged in the Network ledger, visible in the UI. You can review what left your device before it happened.

## Usage

1. **Load a model**: Use the Model Manager to select and download a model. This happens once per model; subsequent sessions use the cached version.
2. **Set your language**: Toggle between French and English in settings or via voice. Voice input will transcribe to the selected language.
3. **Type or speak**: Type a prompt or click the microphone to speak. The assistant will respond with local reasoning.
4. **Ask for searches**: Say "search for X" or ask a question like "what's happening in the news today?" to trigger a web search.
5. **Issue commands**: Commands like "remember [fact]", "recall [topic]", "switch to French", "load model Y" are interpreted by the command router.

## Limitations & Troubleshooting

- **WebGPU requirement**: Local models need WebGPU. If not available, you can only use cloud models (requires API key).
- **Model size and bandwidth**: Large models (20 GB+) take significant time to download and cache. Use a stable internet connection.
- **CORS on URL fetches**: The browser cannot fetch arbitrary URLs if the target doesn't allow it. Cross-origin requests may fail.
- **First-load latency**: First use of a new model involves downloading weights. Expect several minutes.
- **Memory limits**: Browser memory is limited; very long conversations or large models may cause slowdowns. Clear history periodically if needed.
- **Offline operation**: Once models are cached, Hermes works fully offline. If you need web search or cloud features, you must be online to fetch fresh results or model responses.

## Roadmap

### Planned: Tree/topic memory

Currently, Hermes maintains a flat conversation history plus a simple remember/recall store. The next major feature is a **tree-structured topic memory**:

- **Unified memory record**: Related conversations (e.g., repeated questions about financial markets, or weather for a location) are grouped under shared topic branches.
- **Context accumulation**: Each topic branch accumulates facts and context over time, so the assistant can recall past discussions and provide continuity.
- **Smart branching**: The system detects topic shifts and creates new branches or merges related queries.
- **User control**: Full visibility and edit access to the memory tree; users can prune, merge, or archive branches.

This will make Hermes more useful for long-running projects, learning, and sustained problem-solving.
