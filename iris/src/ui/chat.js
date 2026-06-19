/**
 * chat.js -- Chat transcript + composer for Iris.
 *
 * Renders user/assistant messages in a scrollable area.
 * Composer: textarea + Send + Stop buttons. Enter to send, Shift+Enter for newline.
 *
 * Exports: createChat
 */

/**
 * Create the chat UI bound to DOM elements.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.messagesContainer - Scrollable area for messages.
 * @param {HTMLTextAreaElement} opts.inputEl - The composer textarea.
 * @param {HTMLButtonElement} opts.sendBtn - Send button.
 * @param {HTMLButtonElement} opts.stopBtn - Stop button.
 * @param {(text: string) => void} opts.onSend - Callback when user sends a message.
 * @param {() => void} opts.onStop - Callback when user clicks Stop.
 * @returns {{ addUserMessage: Function, addAssistantMessage: Function,
 *            getInspectorContainer: Function, setGenerating: Function, clear: Function }}
 */
export function createChat({ messagesContainer, inputEl, sendBtn, stopBtn, onSend, onStop }) {

  // Wire Send button
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      send();
    });
  }

  // Wire Stop button
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (onStop) onStop();
    });
  }

  // Enter to send, Shift+Enter for newline
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  function send() {
    if (!inputEl) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    if (onSend) onSend(text);
  }

  /**
   * Scroll the messages container to the bottom.
   */
  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  /**
   * Add a user message bubble to the transcript.
   * Returns the bubble element.
   * @param {string} text
   * @returns {HTMLElement}
   */
  function addUserMessage(text) {
    if (!messagesContainer) return document.createElement('div');

    const bubble = document.createElement('div');
    bubble.className = 'msg msg-user';
    bubble.textContent = text;
    messagesContainer.appendChild(bubble);

    // Create an inspector container for this turn (placed after the user message)
    const inspectorContainer = document.createElement('div');
    inspectorContainer.className = 'inspector-turn';
    messagesContainer.appendChild(inspectorContainer);

    scrollToBottom();
    return inspectorContainer;
  }

  /**
   * Add a completed assistant message bubble.
   * @param {string} text
   */
  function addAssistantMessage(text) {
    if (!messagesContainer) return;

    const bubble = document.createElement('div');
    bubble.className = 'msg msg-assistant';
    bubble.textContent = text;
    messagesContainer.appendChild(bubble);
    scrollToBottom();
  }

  /**
   * Set generating state (show/hide Stop, disable/enable Send).
   * @param {boolean} generating
   */
  function setGenerating(generating) {
    if (sendBtn) sendBtn.disabled = generating;
    if (stopBtn) stopBtn.style.display = generating ? 'inline-block' : 'none';
    if (inputEl) inputEl.disabled = generating;
  }

  /**
   * Clear all messages from the transcript.
   */
  function clear() {
    if (messagesContainer) messagesContainer.innerHTML = '';
  }

  // Initial state
  setGenerating(false);

  return {
    addUserMessage,
    addAssistantMessage,
    setGenerating,
    clear,
    scrollToBottom,
  };
}
