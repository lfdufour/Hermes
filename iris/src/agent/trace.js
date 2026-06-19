/**
 * trace.js — Trace event bus for Iris agent loop.
 *
 * Emits TraceEvent objects as CustomEvent details on the 'trace' channel.
 * UI and tests subscribe via addEventListener('trace', e => e.detail).
 *
 * Exports: TraceBus
 */

export class TraceBus extends EventTarget {
  /**
   * Emit a TraceEvent to all 'trace' listeners.
   * @param {TraceEvent} ev
   */
  emit(ev) {
    this.dispatchEvent(new CustomEvent('trace', { detail: ev }));
  }
}

/**
 * Subscribe to all trace events. Returns an unsubscribe function.
 * @param {TraceBus} bus
 * @param {(ev: TraceEvent) => void} fn
 * @returns {() => void}
 */
export function onTrace(bus, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener('trace', handler);
  return () => bus.removeEventListener('trace', handler);
}
