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
 * @typedef {{id:'E2B'|'E4B', label:string, repo:string, dtype:(string|Object)}} ModelPreset */

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

// Gemma 4 ONNX repos store each submodule separately, each at its own
// quantization. A single dtype string makes transformers.js request that dtype
// for ALL submodules, which 404s when a module isn't published at it. So we use
// a per-module dtype map. The values below are VERIFIED against the actual files
// in onnx-community/gemma-4-E2B-it-qat-mobile-ONNX/onnx (these QAT-mobile builds
// are 2-bit: q2f16 for embed/decoder/audio, fp16 for vision). The text-only
// causal-LM path loads only embed_tokens + decoder_model_merged (low RAM);
// vision/audio keys apply only if the multimodal fallback path is taken.
// If a load 404s on onnx/NAME_DTYPE.onnx, edit NAME's dtype in Model > Advanced.
const DEFAULT_DTYPE = {
  embed_tokens: 'q2f16',
  decoder_model_merged: 'q2f16',
  audio_encoder: 'q2f16',
  vision_encoder: 'fp16',
};

export const MODELS = [
  { id:'E2B', label:'Gemma 4 E2B (QAT-mobile)', repo:'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX', dtype:{ ...DEFAULT_DTYPE } },
  { id:'E4B', label:'Gemma 4 E4B (QAT-mobile)', repo:'onnx-community/gemma-4-E4B-it-qat-mobile-ONNX', dtype:{ ...DEFAULT_DTYPE } },
];
