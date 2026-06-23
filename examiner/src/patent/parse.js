/**
 * parse.js — Extract structured text from Google Patents HTML and segment
 * into labeled passages suitable for EPO citation.
 *
 * Exports: parsePatentHtml, segmentPassages.
 *
 * Uses browser DOMParser for real HTML; segmentPassages is pure string logic
 * so it is node-testable with fixtures.
 *
 * Verified HTML structure (2025-07 Google Patents):
 *
 * Description:
 *   <section itemprop="description" itemscope>
 *     <div itemprop="content" html>
 *       <!-- Variant A (older patents, e.g. DE): <description> with <p> children -->
 *       <!-- Variant B (US pub apps): <ul class="description"> with <li> children,
 *            each containing <para-num num="[0001]"> and <div class="description-line"> -->
 *
 * Claims:
 *   <section itemprop="claims" itemscope>
 *     <div itemprop="content" html>
 *       <!-- Variant A: <claims> with <claim num="1"> > <claim-text> -->
 *       <!-- Variant B: <div class="claims"> with <div class="claim"> with
 *            <div class="claim-text">, num attr on inner div, <claim-ref> for refs -->
 *
 * Title: <span itemprop="title"> (inside the article)
 */

/**
 * Parse full Google Patents HTML into a PriorArtDoc.
 * Uses DOMParser (available in browsers; in Node tests, pass small HTML fixtures).
 *
 * @param {string} number - normalized patent number
 * @param {string} html - raw HTML string from Google Patents
 * @returns {import('../types.js').PriorArtDoc}
 */
export function parsePatentHtml(number, html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const title = extractTitle(doc);
  const description = extractDescription(doc);
  const claims = extractClaims(doc);

  const passages = [
    ...segmentPassages(description, 'description'),
    ...segmentPassages(claims, 'claims'),
  ];

  const url = `https://patents.google.com/patent/${encodeURIComponent(number)}/en`;

  return {
    id: number,
    number,
    url,
    status: 'loaded',
    title: title || undefined,
    description,
    claims,
    passages,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Extract the patent title from the DOM.
 * @param {Document} doc
 * @returns {string}
 */
function extractTitle(doc) {
  // Primary: <span itemprop="title">
  const titleEl = doc.querySelector('[itemprop="title"]');
  if (titleEl) {
    return titleEl.textContent.trim();
  }
  // Fallback: <title> tag, stripping " - Google Patents" suffix
  const titleTag = doc.querySelector('title');
  if (titleTag) {
    return titleTag.textContent.replace(/\s*-\s*Google Patents\s*$/, '').trim();
  }
  return '';
}

/**
 * Extract description text from the DOM.
 * Handles both older <description><p> format and modern <ul class="description"><li> format.
 * For translated patents, we extract only the translated (English) text,
 * not the original-language source text (hidden in google-src-text spans).
 *
 * @param {Document} doc
 * @returns {string}
 */
function extractDescription(doc) {
  const section = doc.querySelector('section[itemprop="description"]');
  if (!section) return '';

  const contentDiv = section.querySelector('[itemprop="content"]');
  if (!contentDiv) return section.textContent.trim();

  // Remove google-src-text spans (original language in translated patents)
  // so we only get the English translation text.
  removeSourceTextSpans(contentDiv);

  // Variant B (US-style): <ul class="description"> with <li> containing
  // <para-num num="[0001]"> and <div class="description-line">
  const paraNumEls = contentDiv.querySelectorAll('para-num');
  if (paraNumEls.length > 0) {
    return extractUSDescription(contentDiv);
  }

  // Variant A (older/EP/DE style): <description> or plain <p> elements
  return extractLegacyDescription(contentDiv);
}

/**
 * Remove <span class="google-src-text"> elements (original language in
 * machine-translated patents) so textContent gives only English.
 * @param {Element} root
 */
function removeSourceTextSpans(root) {
  const srcSpans = root.querySelectorAll('span.google-src-text');
  for (const span of srcSpans) {
    span.remove();
  }
}

/**
 * Extract US-style description with paragraph numbers.
 * @param {Element} contentDiv
 * @returns {string}
 */
function extractUSDescription(contentDiv) {
  const parts = [];

  // Also capture <heading> elements as section markers
  const children = contentDiv.querySelectorAll('li, heading');
  for (const el of children) {
    if (el.tagName === 'HEADING' || el.localName === 'heading') {
      const headingText = el.textContent.trim();
      if (headingText) {
        parts.push(headingText);
      }
      continue;
    }

    // It's a <li> — look for para-num and description-line
    const paraNum = el.querySelector('para-num');
    const descLine = el.querySelector('.description-line');

    const numStr = paraNum?.getAttribute('num') || '';
    const text = (descLine || el).textContent.trim();
    if (text) {
      // Prefix with paragraph number if available (e.g. "[0001] Some text...")
      parts.push(numStr ? `${numStr} ${text}` : text);
    }
  }

  return parts.join('\n\n');
}

/**
 * Extract older-format description (DE, EP, etc.) — plain <p> elements
 * inside a <description> element or directly in the content div.
 * @param {Element} contentDiv
 * @returns {string}
 */
function extractLegacyDescription(contentDiv) {
  const paragraphs = contentDiv.querySelectorAll('p');
  if (paragraphs.length === 0) {
    return contentDiv.textContent.trim();
  }

  const parts = [];
  for (const p of paragraphs) {
    const text = p.textContent.trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Extract claims text from the DOM.
 * Handles both <claim num="N"> format and <div class="claim"> format.
 * @param {Document} doc
 * @returns {string}
 */
function extractClaims(doc) {
  const section = doc.querySelector('section[itemprop="claims"]');
  if (!section) return '';

  const contentDiv = section.querySelector('[itemprop="content"]');
  if (!contentDiv) return section.textContent.trim();

  removeSourceTextSpans(contentDiv);

  // Variant A: <claim num="1"> elements (older patents like DE)
  const claimEls = contentDiv.querySelectorAll('claim[num]');
  if (claimEls.length > 0) {
    const parts = [];
    for (const claim of claimEls) {
      const text = claim.textContent.trim();
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  // Variant B: <div class="claim"> elements (US style)
  const claimDivs = contentDiv.querySelectorAll('div.claim > div.claim');
  if (claimDivs.length > 0) {
    const parts = [];
    for (const div of claimDivs) {
      const text = div.textContent.trim();
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join('\n\n');
  }

  // Variant B fallback: any div with id starting with CLM-
  const clmDivs = contentDiv.querySelectorAll('div[id^="CLM-"]');
  if (clmDivs.length > 0) {
    const parts = [];
    for (const div of clmDivs) {
      const text = div.textContent.trim();
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join('\n\n');
  }

  // Final fallback: use all text
  return contentDiv.textContent.trim();
}

/**
 * Segment a block of text into labeled passages.
 *
 * For description text:
 *   - If paragraph numbers like [0001], [0023] are present, split on them.
 *   - Otherwise fall back to paragraph splitting with sequential ¶N labels.
 *
 * For claims text:
 *   - Detect "N." claim numbering at line/paragraph starts.
 *   - Label each as "claim N".
 *
 * @param {string} text - full section text
 * @param {'description'|'claims'} section
 * @returns {import('../types.js').Passage[]}
 */
export function segmentPassages(text, section) {
  if (!text || !text.trim()) return [];

  if (section === 'claims') {
    return segmentClaims(text);
  }

  return segmentDescription(text);
}

/**
 * Segment description text into passages.
 * @param {string} text
 * @returns {import('../types.js').Passage[]}
 */
function segmentDescription(text) {
  // Check for [00xx]-style paragraph numbers (common in US/EP publications)
  // Pattern: [0001], [0023], etc. — typically 4 digits in brackets
  const paraNumPattern = /\[(\d{4})\]/g;
  const hasParaNums = paraNumPattern.test(text);

  if (hasParaNums) {
    return segmentByParaNums(text);
  }

  // Fallback: split on double newlines (paragraph breaks)
  return segmentByParagraphs(text);
}

/**
 * Segment description text by [00xx] paragraph numbers.
 * @param {string} text
 * @returns {import('../types.js').Passage[]}
 */
function segmentByParaNums(text) {
  // Split on paragraph number markers, keeping the markers
  const parts = text.split(/(?=\[\d{4}\])/);
  const passages = [];

  for (const part of parts) {
    const match = part.match(/^\[(\d{4})\]\s*/);
    if (match) {
      const label = `[${match[1]}]`;
      const body = part.slice(match[0].length).trim();
      if (body) {
        passages.push({
          index: passages.length,
          label,
          text: body,
          section: 'description',
        });
      }
    } else {
      // Text before the first paragraph number — include if non-trivial
      const trimmed = part.trim();
      if (trimmed && trimmed.length > 10) {
        passages.push({
          index: passages.length,
          label: '[0000]',
          text: trimmed,
          section: 'description',
        });
      }
    }
  }

  return passages;
}

/**
 * Segment text by paragraph breaks with sequential labels.
 * Used when no [00xx] numbers are present (older DE/EP patents).
 * @param {string} text
 * @returns {import('../types.js').Passage[]}
 */
function segmentByParagraphs(text) {
  // Split on double newlines or more
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  const passages = [];

  for (let i = 0; i < paragraphs.length; i++) {
    passages.push({
      index: passages.length,
      label: `¶${i + 1}`,   // ¶1, ¶2, ...
      text: paragraphs[i],
      section: 'description',
    });
  }

  return passages;
}

/**
 * Segment claims text into individual claims.
 *
 * Detects claim boundaries by looking for lines starting with a number
 * followed by a period (e.g. "1. A method..." or "12. The device of claim 1...").
 *
 * @param {string} text
 * @returns {import('../types.js').Passage[]}
 */
function segmentClaims(text) {
  // NOTE: Claims can start with "N." at beginning of line or after a double-newline.
  // We split on claim number patterns, being careful not to split on internal
  // numbered lists (e.g. "step (1)..."). The pattern requires the number to be
  // at the start of a line or after whitespace.
  const claimPattern = /(?:^|\n\n|\n)(\d{1,3})\.\s/g;
  let match;

  // Collect all claim start positions
  const starts = [];
  while ((match = claimPattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    // Heuristic: claims are numbered sequentially, and claim 1 should be first or close to it.
    // Accept if it's the first match or the number is >= previous.
    if (starts.length === 0 || num > (starts[starts.length - 1]?.num || 0)) {
      starts.push({
        num,
        // The actual claim text starts after "N. "
        startOfMatch: match.index + (match[0].startsWith('\n') ? (match[0].startsWith('\n\n') ? 2 : 1) : 0),
        startOfText: match.index + match[0].length,
      });
    }
  }

  if (starts.length === 0) {
    // No numbered claims found — treat entire text as a single claim passage
    const trimmed = text.trim();
    if (trimmed) {
      return [{
        index: 0,
        label: 'claim 1',
        text: trimmed,
        section: 'claims',
      }];
    }
    return [];
  }

  const passages = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].startOfMatch : text.length;
    const claimText = text.slice(starts[i].startOfMatch, end).trim();
    // Remove the leading "N. " from the text if present
    const cleaned = claimText.replace(/^\d{1,3}\.\s*/, '').trim();
    if (cleaned) {
      passages.push({
        index: passages.length,
        label: `claim ${starts[i].num}`,
        text: cleaned,
        section: 'claims',
      });
    }
  }

  return passages;
}
