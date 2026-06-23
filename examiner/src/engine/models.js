/**
 * engine/models.js — Local model registry for Hermes Patent Examiner.
 *
 * Local-only inference via the reused Iris transformers.js worker. All repos are
 * verified to exist on the HF Hub and are loadable with AutoModelForCausalLM +
 * the tokenizer's own chat template (no model-specific protocol needed since we
 * do plain structured prompting, not tool-calls).
 *
 * NOTE: Gemma-4 QAT-mobile weights are f16-only and need WebGPU 'shader-f16';
 * the Iris worker's resolveDevice() falls back to WASM automatically. The Qwen /
 * Llama presets are q4f16 and run on a wider range of devices — hence a Qwen
 * model is the default, since Gemma has device-support issues on some machines.
 */

/** @typedef {{ id:string, label:string, repo:string, dtype:string, note:string, light:boolean }} ModelPreset */

/** @type {ModelPreset[]} */
export const MODELS = [
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen2.5 1.5B Instruct (recommended)',
    repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
    dtype: 'q4f16',
    note: 'Best default: strong instruction-following + JSON, broad device support.',
    light: true,
  },
  {
    id: 'qwen2.5-0.5b',
    label: 'Qwen2.5 0.5B Instruct (ultra-light)',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    dtype: 'q4f16',
    note: 'Smallest footprint for low-RAM devices; lower quality on long mappings.',
    light: true,
  },
  {
    id: 'llama3.2-1b',
    label: 'Llama 3.2 1B Instruct',
    repo: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    dtype: 'q4f16',
    note: 'Solid lightweight alternative.',
    light: true,
  },
  {
    id: 'gemma4-e2b',
    label: 'Gemma 4 E2B (QAT-mobile)',
    repo: 'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX',
    dtype: 'q4f16',
    note: 'High quality but f16-only — needs WebGPU shader-f16 or falls back to slow WASM.',
    light: false,
  },
  {
    id: 'gemma4-e4b',
    label: 'Gemma 4 E4B (QAT-mobile)',
    repo: 'onnx-community/gemma-4-E4B-it-qat-mobile-ONNX',
    dtype: 'q4f16',
    note: 'Highest quality; largest RAM/VRAM. Device-support caveats as E2B.',
    light: false,
  },
];

export const DEFAULT_MODEL_ID = 'qwen2.5-1.5b';

/** @param {string} id @returns {ModelPreset|undefined} */
export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}
