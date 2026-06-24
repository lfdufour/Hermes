/**
 * engine/models.js — Local model registry for Hermes Patent Examiner.
 *
 * Local-only inference via the reused Iris transformers.js worker. The Qwen /
 * Llama presets are ungated text CausalLM ONNX builds with a single q4f16 file,
 * so a plain `dtype` string works and they run on a wide range of devices.
 *
 * The Gemma 4 E2B preset is different: its QAT-mobile weights use a 2-bit
 * block-quantized embed table (GatherBlockQuantized) that the onnxruntime-web
 * inside transformers.js cannot run. It therefore uses `engine: 'gemma4'`, a
 * dedicated WebGPU runtime (see engine/gemma4.js) that ships its own kernels.
 * It requires WebGPU and offers a very large context window (256K tokens),
 * useful for full-document feature mapping. A Qwen model stays the default for
 * broad device support.
 */

/**
 * @typedef {{ id:string, label:string, repo:string, dtype?:(string|Object<string,string>),
 *   context:number, note:string, light:boolean, engine?:('transformers'|'gemma4') }} ModelPreset
 * `engine` selects the runtime: 'transformers' (default — the Iris worker) or
 * 'gemma4' (the bespoke WebGPU runtime for Gemma 4's block-quantized weights).
 */

/** @type {ModelPreset[]} */
export const MODELS = [
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen2.5 1.5B Instruct (recommended)',
    repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
    dtype: 'q4f16',
    context: 32768,
    note: 'Best default: strong instruction-following + JSON, broad device support.',
    light: true,
  },
  {
    id: 'qwen2.5-0.5b',
    label: 'Qwen2.5 0.5B Instruct (ultra-light)',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    dtype: 'q4f16',
    context: 32768,
    note: 'Smallest footprint for low-RAM devices; lower quality on long mappings.',
    light: true,
  },
  {
    id: 'llama3.2-1b',
    label: 'Llama 3.2 1B Instruct',
    repo: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    dtype: 'q4f16',
    context: 131072,
    note: 'Solid lightweight alternative.',
    light: true,
  },
  {
    id: 'gemma4-e2b',
    label: 'Gemma 4 E2B (WebGPU, dedicated runtime)',
    repo: 'google/gemma-4-E2B-it-qat-mobile-transformers',
    engine: 'gemma4',
    context: 262144,
    note: 'High quality, 256K context — great for full-document mapping. Uses a dedicated WebGPU runtime (custom kernels); requires WebGPU. Larger download.',
    light: false,
  },
];

export const DEFAULT_MODEL_ID = 'qwen2.5-1.5b';

/** @param {string} id @returns {ModelPreset|undefined} */
export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}
