/**
 * app.js -- Top-level UI controller for Iris.
 *
 * Owns DOM refs, instantiates EngineClient + ToolRegistry + TraceBus,
 * holds app state (current model, settings, chat messages), runs the
 * agent loop on send, and renders via sub-modules.
 *
 * Exports: initApp
 */

import { EngineClient } from '../engine/client.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltins } from '../tools/builtins.js';
import { vfs } from '../tools/vfs.js';
import { TraceBus, onTrace } from '../agent/trace.js';
import { runAgent } from '../agent/loop.js';
import { createChat } from './chat.js';
import { createInspector } from './inspector.js';
import { createModelManager } from './modelManager.js';
import { createStoragePanel } from './storagePanel.js';
import { createFileManager } from './fileManager.js';
import { createSettings } from './settings.js';

/**
 * Initialize the Iris application.
 *
 * @param {{ protocol: object }} opts - The Gemma protocol module.
 */
export function initApp({ protocol }) {
  // -- Core instances --
  const engine = new EngineClient();
  const registry = new ToolRegistry();
  registerBuiltins(registry, { vfs });
  const trace = new TraceBus();

  // -- DOM references (defensive null checks throughout) --
  const $ = (sel) => document.querySelector(sel);

  const messagesContainer = $('#chat-messages');
  const inputEl = $('#chat-input');
  const sendBtn = $('#chat-send-btn');
  const stopBtn = $('#chat-stop-btn');
  const modelContainer = $('#model-manager-container');
  const settingsContainer = $('#settings-container');
  const storageContainer = $('#storage-container');
  const fileManagerContainer = $('#file-manager-container');
  const debugToggle = $('#debug-toggle');
  const newChatBtn = $('#new-chat-btn');

  // -- App state --
  let chatHistory = []; // Message[]
  let abortController = null;
  let isGenerating = false;
  let debugMode = false;
  let currentInspector = null;

  // -- Sub-module initialization --

  // Settings
  const settingsModule = createSettings(settingsContainer);
  const { settings } = settingsModule;

  // Model manager
  const modelManager = createModelManager(modelContainer, { engine });

  // Storage panel
  const storagePanel = createStoragePanel(storageContainer, { engine });

  // File manager
  const fileManager = createFileManager(fileManagerContainer, { vfs });

  // Chat
  const chat = createChat({
    messagesContainer,
    inputEl,
    sendBtn,
    stopBtn,
    onSend: handleSend,
    onStop: handleStop,
  });

  // Disable send until model is loaded
  if (sendBtn) sendBtn.disabled = true;
  modelManager.onLoadStateChange((loaded) => {
    if (sendBtn) sendBtn.disabled = !loaded || isGenerating;
  });

  // -- Debug toggle --
  if (debugToggle) {
    debugToggle.addEventListener('change', () => {
      debugMode = debugToggle.checked;
      if (currentInspector) currentInspector.refreshDebug();
    });
  }

  // -- New Chat --
  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      chatHistory = [];
      chat.clear();
      currentInspector = null;
    });
  }

  // -- Send handler --
  async function handleSend(text) {
    if (!modelManager.isLoaded() || isGenerating) return;

    isGenerating = true;
    chat.setGenerating(true);

    // Add user message to history and DOM
    chatHistory.push({ role: 'user', content: text });
    const inspectorContainer = chat.addUserMessage(text);

    // Create inspector for this turn
    currentInspector = createInspector(inspectorContainer, {
      debugEnabled: () => debugMode,
    });

    // Build messages array with system prompt
    const messages = [];
    if (settings.systemPrompt && settings.systemPrompt.trim()) {
      messages.push({ role: 'system', content: settings.systemPrompt.trim() });
    }
    // Add full chat history
    for (const msg of chatHistory) {
      messages.push({ ...msg });
    }

    // Create AbortController for this generation
    abortController = new AbortController();

    // Subscribe to trace events and feed them to the inspector
    const unsubscribe = onTrace(trace, (ev) => {
      if (currentInspector) {
        currentInspector.handleEvent(ev);
      }
      // Auto-scroll on content deltas
      if (ev.type === 'content_delta' || ev.type === 'thought_delta') {
        chat.scrollToBottom();
      }
    });

    try {
      const genConfig = settingsModule.getGenConfig();

      const result = await runAgent({
        engine,
        protocol,
        registry,
        messages,
        genConfig,
        thinking: settings.thinking,
        trace,
        signal: abortController.signal,
      });

      // Append the returned messages to history (skip the system prompt and
      // messages already in chatHistory)
      // The result.messages includes the system + all prior + new messages.
      // We need to extract only the NEW messages appended by runAgent.
      const priorCount = messages.length;
      const newMessages = result.messages.slice(priorCount);
      for (const msg of newMessages) {
        chatHistory.push(msg);
      }

      // Refresh file manager (tools may have changed OPFS)
      fileManager.refresh();

    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Agent run failed:', e);
      }
    } finally {
      unsubscribe();
      isGenerating = false;
      abortController = null;
      chat.setGenerating(false);
      if (sendBtn) sendBtn.disabled = !modelManager.isLoaded();
    }
  }

  // -- Stop handler --
  function handleStop() {
    if (abortController) {
      abortController.abort();
    }
    engine.cancel();
  }
}
