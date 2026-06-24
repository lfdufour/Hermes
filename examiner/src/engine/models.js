/**
 * engine/models.js — Local model registry for Hermes Patent Examiner.
 *
 * Local-only inference via the reused Iris transformers.js worker. The Qwen /
 * Llama presets are ungated text CausalLM ONNX builds with a single q4f16 file,
 * so a plain `dtype` string works and they run on a wide range of devices.
 *
 * The Gemma 4 E2B/E4B presets are different: they are MULTIMODAL, component-split
 * ONNX repos (embed_tokens / decoder_model_merged / vision_encoder / audio_encoder),
 * so `dtype` MUST be a per-component object naming the suffix that actually exists
 * in the repo (decoder/embed/audio are q2f16, vision is fp16). Passing a single
 * 'q4f16' string 404s because no such file exists. These need WebGPU (f16) and the
 * worker loads them via AutoModelForImageTextToText (text-only inputs); they offer
 * a very large context window (up to 256K tokens) which is useful for full-document
 * feature mapping. A Qwen model stays the default for broad device support.
 */

/** @typedef {{ id:string, label:string, repo:string, dtype:(string|Object<string,string>), note:string, light:boolean }} ModelPreset */

/** Per-component dtype for the Gemma 4 QAT-mobile multimodal ONNX repos. The
 *  suffixes match the files actually published in onnx-community/gemma-4-*-ONNX. */
const GEMMA4_DTYPE = {
  embed_tokens: 'q2f16',
  audio_encoder: 'q2f16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q2f16',
};

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
    label: 'Gemma 4 E2B (QAT-mobile, WebGPU)',
    repo: 'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX',
    dtype: GEMMA4_DTYPE,
    note: 'High quality, 256K context — great for full-document mapping. Requires WebGPU (f16).',
    light: false,
  },
  {
    id: 'gemma4-e4b',
    label: 'Gemma 4 E4B (QAT-mobile, WebGPU)',
    repo: 'onnx-community/gemma-4-E4B-it-qat-mobile-ONNX',
    dtype: GEMMA4_DTYPE,
    note: 'Highest quality; largest VRAM. 256K context. Requires WebGPU (f16).',
    light: false,
  },
];

export const DEFAULT_MODEL_ID = 'qwen2.5-1.5b';

/** @param {string} id @returns {ModelPreset|undefined} */
export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}
