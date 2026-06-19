/**
 * types.js -- Shared JSDoc typedefs for Iris.
 *
 * NO runtime code. Import this file only for editor/IDE type inference.
 * These types define the shared vocabulary across engine, protocol, tools,
 * agent, and UI modules.
 */

/** @typedef {{role:'system'|'user'|'assistant'|'tool', content:string,
 *   tool_calls?:ToolCall[], tool_call_id?:string, thoughts?:string}} Message */

/** @typedef {{name:string, description:string, parameters:object}} ToolSpec */

/** @typedef {{id:string, name:string, args:object}} ToolCall */

/** @typedef {{tool_call_id:string, name:string, ok:boolean, value:any, error?:string, ms:number}} ToolResult */

/** @typedef {{temperature:number, top_p:number, top_k?:number, max_new_tokens:number,
 *   do_sample:boolean, repetition_penalty?:number}} GenConfig */

/** dtype may be a single string (e.g. 'q4f16') or a per-module map
 *  (e.g. {embed_tokens:'fp16', decoder_model_merged:'q4f16'}).
 * @typedef {{id:string, label:string, repo:string, dtype:(string|Object)}} ModelPreset */

/**
 * TraceEvent (discriminated by .type):
 * @typedef {{type:'prompt_built', text:string, tokenCount:number}
 *  | {type:'thought_delta', delta:string}
 *  | {type:'content_delta', delta:string}
 *  | {type:'tool_call', call:ToolCall}
 *  | {type:'tool_result', result:ToolResult}
 *  | {type:'step_done', tokens:number, ms:number, tokensPerSec:number}
 *  | {type:'turn_done'}
 *  | {type:'error', message:string}} TraceEvent */

/** @typedef {{file:string, loaded:number, total:number, pct:number}} ProgressEvent */

// Per-module dtype map for the split Gemma 4 layout (each submodule is a
// separate ONNX file at its own quantization). Verified against the qat-mobile
// repo: embed/decoder/audio are 2-bit (q2f16), vision is fp16.
//
// WARNING: these qat-mobile weights are 2-BIT. onnxruntime-web's quantized
// kernels (GatherBlockQuantized etc.) only implement 4-bit and 8-bit, so the
// 2-bit weights FAIL in-browser with:
//   "GatherBlockQuantized ... 'bits' must be 4 or 8".
// They run on LiteRT/MediaPipe, not onnxruntime-web. To actually run Gemma 4 in
// the browser we need a 4-bit (q4f16) export; point repo+dtype at one via the
// Model > Advanced panel once such a repo is identified.
const DEFAULT_DTYPE = {
  embed_tokens: 'q2f16',
  decoder_model_merged: 'q2f16',
  audio_encoder: 'q2f16',
  vision_encoder: 'fp16',
};

export const MODELS = [
  // --- Light, browser-runnable models for exercising the UI end-to-end. ---
  // Single-file ONNX (dtype is a plain STRING) using 4-bit/8-bit quantization
  // that onnxruntime-web supports on BOTH WebGPU and WASM. The chat template
  // and tokenizer come from each repo, so the generic loader handles them with
  // no code changes -- only the Gemma-4-specific thinking/tool token parsing is
  // inert on these. If a load 404s on onnx/model_DTYPE.onnx, change dtype in
  // Model > Advanced (e.g. q4, q8, q4f16, fp16, or fp32 for the unquantized file).
  { id:'G3-270M', label:'Gemma 3 270M-it (UI test)', repo:'onnx-community/gemma-3-270m-it-ONNX', dtype:'q4' },
  { id:'Q25-05B', label:'Qwen2.5 0.5B-it (UI test, reliable)', repo:'onnx-community/Qwen2.5-0.5B-Instruct', dtype:'q4f16' },

  // --- Full Gemma 4 (multimodal). 2-bit qat-mobile: see WARNING above; these
  // currently do NOT run in onnxruntime-web. Kept for when a 4-bit export lands. ---
  { id:'E2B', label:'Gemma 4 E2B (qat-mobile, 2-bit — not browser-runnable yet)', repo:'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX', dtype:{ ...DEFAULT_DTYPE } },
  { id:'E4B', label:'Gemma 4 E4B (qat-mobile, 2-bit — not browser-runnable yet)', repo:'onnx-community/gemma-4-E4B-it-qat-mobile-ONNX', dtype:{ ...DEFAULT_DTYPE } },
];
