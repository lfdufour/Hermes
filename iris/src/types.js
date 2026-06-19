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

/** @typedef {{id:'E2B'|'E4B', label:string, repo:string, dtype:string}} ModelPreset */

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

export const MODELS = [
  { id:'E2B', label:'Gemma 4 E2B (QAT-mobile)', repo:'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX', dtype:'q4f16' },
  { id:'E4B', label:'Gemma 4 E4B (QAT-mobile)', repo:'onnx-community/gemma-4-E4B-it-qat-mobile-ONNX', dtype:'q4f16' },
];
