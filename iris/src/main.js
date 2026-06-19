/**
 * main.js -- Iris app bootstrap and UI wiring.
 *
 * Minimal smoke-test path: load model, apply chat template, generate with
 * streaming. The full agent loop, Inspector, and tools wiring come later.
 */

import { EngineClient } from './engine/client.js';
import { MODELS } from './types.js';

// ---------- DOM references ----------

const $ = (sel) => document.querySelector(sel);

const modelSelect   = $('#model-select');
const loadBtn       = $('#load-btn');
const progressBar   = $('#progress-bar');
const progressText  = $('#progress-text');
const systemPrompt  = $('#system-prompt');
const userInput     = $('#user-input');
const sendBtn       = $('#send-btn');
const cancelBtn     = $('#cancel-btn');
const outputArea    = $('#output-area');
const debugPrompt   = $('#debug-prompt');
const debugTokenizer = $('#debug-tokenizer');

// ---------- State ----------

const engine = new EngineClient();
let isLoaded = false;
let isGenerating = false;

// ---------- Populate model picker ----------

MODELS.forEach((m) => {
  const opt = document.createElement('option');
  opt.value = m.id;
  opt.textContent = m.label;
  modelSelect.appendChild(opt);
});
// Default to E2B
modelSelect.value = 'E2B';

// ---------- Load model ----------

loadBtn.addEventListener('click', async () => {
  const preset = MODELS.find((m) => m.id === modelSelect.value);
  if (!preset) return;

  loadBtn.disabled = true;
  loadBtn.textContent = 'Loading...';
  progressBar.value = 0;
  progressBar.style.display = 'block';
  progressText.textContent = 'Starting download...';
  progressText.style.display = 'block';

  try {
    await engine.load({
      repo: preset.repo,
      dtype: preset.dtype,
      device: 'webgpu',
      onProgress: ({ file, loaded, total, pct }) => {
        progressBar.value = pct;
        const loadedMB = (loaded / 1024 / 1024).toFixed(1);
        const totalMB = (total / 1024 / 1024).toFixed(1);
        progressText.textContent = `${file}: ${loadedMB}/${totalMB} MB (${Math.round(pct)}%)`;
      },
    });

    isLoaded = true;
    loadBtn.textContent = 'Loaded';
    progressText.textContent = 'Model loaded successfully.';
    sendBtn.disabled = false;

    // Fetch and display tokenizer info in the Debug block
    try {
      const info = await engine.tokenizerInfo();
      debugTokenizer.textContent = JSON.stringify(info, null, 2);
    } catch (e) {
      debugTokenizer.textContent = 'Failed to get tokenizer info: ' + e.message;
    }
  } catch (e) {
    loadBtn.textContent = 'Load Model';
    loadBtn.disabled = false;
    progressText.textContent = 'Error: ' + e.message;
    console.error('Model load failed:', e);
  }
});

// ---------- Send message ----------

sendBtn.addEventListener('click', handleSend);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

async function handleSend() {
  if (!isLoaded || isGenerating) return;

  const userText = userInput.value.trim();
  if (!userText) return;

  isGenerating = true;
  sendBtn.disabled = true;
  cancelBtn.disabled = false;
  cancelBtn.style.display = 'inline-block';

  // Build messages array
  const messages = [];
  const sys = systemPrompt.value.trim();
  if (sys) {
    messages.push({ role: 'system', content: sys });
  }
  messages.push({ role: 'user', content: userText });

  // Clear output area and show user message
  outputArea.innerHTML = '';
  const userBubble = document.createElement('div');
  userBubble.className = 'msg msg-user';
  userBubble.textContent = userText;
  outputArea.appendChild(userBubble);

  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'msg msg-assistant';
  outputArea.appendChild(assistantBubble);

  try {
    // Apply chat template (with thinking enabled)
    const { input_ids, rendered } = await engine.applyChatTemplate({
      messages,
      thinking: true,
    });

    // Show rendered prompt in Debug
    debugPrompt.textContent = rendered;

    // Generate with streaming
    const { outputText, stats } = await engine.generate({
      input_ids,
      genConfig: {
        max_new_tokens: 2048,
        do_sample: true,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 50,
      },
      onToken: ({ text }) => {
        assistantBubble.textContent += text;
        // Auto-scroll to bottom
        outputArea.scrollTop = outputArea.scrollHeight;
      },
    });

    // Show stats
    const statsEl = document.createElement('div');
    statsEl.className = 'stats';
    statsEl.textContent = `${stats.tokens} tokens in ${(stats.ms / 1000).toFixed(1)}s (${stats.tokensPerSec} tok/s)`;
    outputArea.appendChild(statsEl);

  } catch (e) {
    assistantBubble.textContent += '\n[Error: ' + e.message + ']';
    console.error('Generation failed:', e);
  } finally {
    isGenerating = false;
    sendBtn.disabled = false;
    cancelBtn.disabled = true;
    cancelBtn.style.display = 'none';
    userInput.value = '';
    userInput.focus();
  }
}

// ---------- Cancel ----------

cancelBtn.addEventListener('click', () => {
  engine.cancel();
});

// ---------- Init ----------

sendBtn.disabled = true;
cancelBtn.style.display = 'none';
progressBar.style.display = 'none';
progressText.style.display = 'none';
