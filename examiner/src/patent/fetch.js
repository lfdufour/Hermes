/**
 * fetch.js — Patent fetching via CORS proxies + paste fallback.
 *
 * Exports: normalizeNumber, buildPatentUrl, DEFAULT_PROXIES, fetchPatent, parsePasted.
 *
 * End-user browsers cannot fetch patents.google.com directly (CORS).
 * We route through public CORS proxy templates. Patent data is public domain.
 */

import { parsePatentHtml, segmentPassages } from './parse.js';

/**
 * Strip spaces, dots, dashes and uppercase a patent number string.
 * "de 197 280 57 c2" -> "DE19728057C2"
 * @param {string} input - raw user input
 * @returns {string} normalized patent number
 */
export function normalizeNumber(input) {
  return input.replace(/[\s.\-/]+/g, '').toUpperCase();
}

/**
 * Build the canonical Google Patents URL for a normalized number.
 * @param {string} number - normalized patent number (e.g. "DE19728057C2")
 * @returns {string} full URL
 */
export function buildPatentUrl(number) {
  return `https://patents.google.com/patent/${encodeURIComponent(number)}/en`;
}

/**
 * Default CORS proxy URL templates.
 * Each must contain a `{url}` placeholder that will be replaced with
 * the URL-encoded target URL.
 *
 * NOTE: allorigins is the most reliable public proxy as of mid-2025.
 * corsproxy.io and codetabs work intermittently. Users can override
 * via settings. These are tried in order; the first success wins.
 */
export const DEFAULT_PROXIES = [
  'https://api.allorigins.win/raw?url={url}',
  'https://corsproxy.io/?url={url}',
  'https://api.codetabs.com/v1/proxy?quest={url}',
  'https://thingproxy.freeboard.io/fetch/{url}',
  'https://api.allorigins.win/get?url={url}',
];

/** Per-proxy attempt timeout (ms). Public proxies often accept a connection
 *  then stall; without this a single dead proxy blocks the whole fallback chain. */
const PROXY_TIMEOUT_MS = 15000;

/**
 * Fetch a patent's HTML from Google Patents via CORS proxies.
 * Tries each proxy in order. NEVER throws — resolves with ok:false on total failure.
 *
 * @param {string} number - raw or normalized patent number
 * @param {Object} [opts]
 * @param {string[]} [opts.proxies] - proxy URL templates (default: DEFAULT_PROXIES)
 * @param {AbortSignal} [opts.signal] - optional abort signal
 * @returns {Promise<{ok:boolean, number:string, url:string, html?:string, error?:string}>}
 */
export async function fetchPatent(number, { proxies, signal } = {}) {
  const norm = normalizeNumber(number);
  const url = buildPatentUrl(norm);
  const proxyList = proxies || DEFAULT_PROXIES;
  const errors = [];

  for (const template of proxyList) {
    if (signal?.aborted) {
      return { ok: false, number: norm, url, error: 'Fetch aborted by user.' };
    }

    const proxyUrl = template.replace('{url}', encodeURIComponent(url));
    const label = template.split(/[?/]/)[2] || template; // host for error messages

    // Per-attempt timeout: abort this fetch if it stalls, while still honouring
    // a user-initiated abort on the outer signal.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
    const onOuterAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const resp = await fetch(proxyUrl, {
        signal: ctrl.signal,
        headers: { 'Accept': 'text/html' },
      });
      if (!resp.ok) {
        errors.push(`${label}: HTTP ${resp.status}`);
        continue;
      }
      let html = await resp.text();

      // The allorigins "/get" endpoint wraps the page in JSON {contents:"..."}.
      if (template.includes('/get?')) {
        try { html = JSON.parse(html).contents || ''; } catch (_) { /* leave as-is */ }
      }

      // Sanity check: Google Patents pages contain itemprop="description"
      // or a <description> element. A blank/error page won't.
      if (html.length < 500 || (!html.includes('itemprop="description"') && !html.includes('<description'))) {
        errors.push(`${label}: response too short or not a patent page`);
        continue;
      }

      return { ok: true, number: norm, url, html };
    } catch (err) {
      // A timeout shows up as an AbortError on ctrl.signal; distinguish it from
      // a user abort (outer signal).
      if (signal?.aborted) {
        return { ok: false, number: norm, url, error: 'Fetch aborted by user.' };
      }
      if (err.name === 'AbortError') {
        errors.push(`${label}: timed out after ${PROXY_TIMEOUT_MS / 1000}s`);
      } else {
        errors.push(`${label}: ${err.message}`);
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  return {
    ok: false,
    number: norm,
    url,
    error: `All proxies failed for ${norm}. ${errors.join(' | ')}`,
  };
}

/**
 * Build a PriorArtDoc from manually pasted text (paste fallback).
 * The user pastes description + claims as plain text when fetch fails.
 *
 * @param {string} number - raw or normalized patent number
 * @param {string} text - pasted full text (description + claims together)
 * @returns {import('../types.js').PriorArtDoc}
 */
export function parsePasted(number, text) {
  const norm = normalizeNumber(number);
  const url = buildPatentUrl(norm);

  // NOTE: We attempt to split pasted text into description and claims
  // using a heuristic: look for a line starting with "Claims" or a
  // numbered claim pattern like "1. A method..." near the end.
  let description = text;
  let claims = '';

  // Try to find a "Claims" header
  const claimsHeaderMatch = text.match(/\n\s*(Claims|CLAIMS)\s*\n/);
  if (claimsHeaderMatch) {
    const idx = claimsHeaderMatch.index;
    description = text.slice(0, idx).trim();
    claims = text.slice(idx + claimsHeaderMatch[0].length).trim();
  }

  const passages = [
    ...segmentPassages(description, 'description'),
    ...segmentPassages(claims, 'claims'),
  ];

  return {
    id: norm,
    number: norm,
    url,
    status: 'pasted',
    title: undefined,
    description,
    claims,
    passages,
    fetchedAt: new Date().toISOString(),
  };
}
