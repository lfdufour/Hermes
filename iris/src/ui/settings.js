/**
 * settings.js -- Settings panel for Iris.
 *
 * Controls: temperature, top_p, max_new_tokens, thinking on/off, system prompt.
 * Persists to localStorage under 'iris-settings'.
 *
 * Exports: createSettings
 */

const STORAGE_KEY = 'iris-settings';

const DEFAULTS = {
  temperature: 0.7,
  top_p: 0.9,
  max_new_tokens: 2048,
  thinking: true,
  systemPrompt: 'You are a helpful assistant.',
};

/**
 * Load saved settings from localStorage, merged with defaults.
 * @returns {object}
 */
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (_) { /* ignore parse errors */ }
  return { ...DEFAULTS };
}

/**
 * Save settings to localStorage.
 * @param {object} settings
 */
function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_) { /* ignore quota errors */ }
}

/**
 * Create the settings panel and bind it to a container element.
 * Returns the live settings object (mutated in place by the controls).
 *
 * @param {HTMLElement} container - The DOM element to render into.
 * @returns {{ settings: object, getGenConfig: () => object }}
 */
export function createSettings(container) {
  const settings = loadSettings();

  if (!container) {
    // Defensive: return settings even without DOM
    return {
      settings,
      getGenConfig() {
        return {
          temperature: settings.temperature,
          top_p: settings.top_p,
          max_new_tokens: settings.max_new_tokens,
          do_sample: true,
        };
      },
    };
  }

  container.innerHTML = `
    <div class="settings-panel">
      <h3 class="panel-title">Settings</h3>

      <label class="setting-label">
        Temperature: <span id="settings-temp-val">${settings.temperature}</span>
        <input type="range" id="settings-temperature" min="0" max="2" step="0.05"
               value="${settings.temperature}">
      </label>

      <label class="setting-label">
        Top-p: <span id="settings-topp-val">${settings.top_p}</span>
        <input type="range" id="settings-top-p" min="0" max="1" step="0.05"
               value="${settings.top_p}">
      </label>

      <label class="setting-label">
        Max tokens:
        <input type="number" id="settings-max-tokens" min="1" max="8192" step="1"
               value="${settings.max_new_tokens}" class="setting-number">
      </label>

      <label class="setting-label setting-checkbox">
        <input type="checkbox" id="settings-thinking" ${settings.thinking ? 'checked' : ''}>
        Enable thinking
      </label>

      <label class="setting-label">
        System prompt:
        <textarea id="settings-system-prompt" rows="3"
                  class="setting-textarea">${settings.systemPrompt}</textarea>
      </label>
    </div>
  `;

  // Bind controls
  const tempSlider = container.querySelector('#settings-temperature');
  const tempVal = container.querySelector('#settings-temp-val');
  const topPSlider = container.querySelector('#settings-top-p');
  const topPVal = container.querySelector('#settings-topp-val');
  const maxTokensInput = container.querySelector('#settings-max-tokens');
  const thinkingCheck = container.querySelector('#settings-thinking');
  const sysPromptArea = container.querySelector('#settings-system-prompt');

  if (tempSlider) {
    tempSlider.addEventListener('input', () => {
      settings.temperature = parseFloat(tempSlider.value);
      if (tempVal) tempVal.textContent = settings.temperature.toFixed(2);
      saveSettings(settings);
    });
  }

  if (topPSlider) {
    topPSlider.addEventListener('input', () => {
      settings.top_p = parseFloat(topPSlider.value);
      if (topPVal) topPVal.textContent = settings.top_p.toFixed(2);
      saveSettings(settings);
    });
  }

  if (maxTokensInput) {
    maxTokensInput.addEventListener('change', () => {
      const v = parseInt(maxTokensInput.value, 10);
      if (v > 0) {
        settings.max_new_tokens = v;
        saveSettings(settings);
      }
    });
  }

  if (thinkingCheck) {
    thinkingCheck.addEventListener('change', () => {
      settings.thinking = thinkingCheck.checked;
      saveSettings(settings);
    });
  }

  if (sysPromptArea) {
    sysPromptArea.addEventListener('input', () => {
      settings.systemPrompt = sysPromptArea.value;
      saveSettings(settings);
    });
  }

  return {
    settings,
    /** Build a GenConfig from current settings. */
    getGenConfig() {
      return {
        temperature: settings.temperature,
        top_p: settings.top_p,
        max_new_tokens: settings.max_new_tokens,
        do_sample: true,
      };
    },
  };
}
