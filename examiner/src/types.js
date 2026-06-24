/**
 * types.js — Shared JSDoc typedefs for Hermes Patent Examiner.
 * No runtime code; this is the shared vocabulary referenced across modules.
 * See CONTRACTS.md for the authoritative data model and EPO methodology.
 */

/** @typedef {'product'|'process'|'use'|null} ClaimCategory */

/**
 * @typedef {Object} Feature
 * @property {string} id                 EPO-style number, e.g. "1.1"
 * @property {number} claim              owning claim number
 * @property {'independent'|'dependent'} type
 * @property {number[]} dependsOn        claim numbers the owning claim depends on
 * @property {string} text               atomic technical feature (one limitation)
 * @property {string} [evidence]         verbatim claim phrase supporting this feature
 * @property {'preamble'|'characterizing'|null} portion  two-part form (Rule 43(1) EPC)
 * @property {string[]} refSigns         reference numerals (Rule 43(7)); non-limiting
 * @property {ClaimCategory} category
 * @property {string} [note]             examiner interpretation (editable)
 */

/**
 * @typedef {Object} ClaimMeta
 * @property {number} num
 * @property {'independent'|'dependent'} type
 * @property {number[]} dependsOn
 * @property {ClaimCategory} category
 * @property {boolean} twoPart
 */

/**
 * @typedef {Object} FeatureTable
 * @property {ClaimMeta[]} claims
 * @property {Feature[]} features
 */

/**
 * @typedef {Object} Passage
 * @property {number} index
 * @property {string} label                 e.g. "[0023]", "col. 3, ll. 5-12", "claim 3"
 * @property {string} text
 * @property {'description'|'claims'} section
 */

/**
 * @typedef {Object} PriorArtDoc
 * @property {string} id                     normalized number, e.g. "DE19728057C2"
 * @property {string} number
 * @property {string} url
 * @property {'pending'|'loaded'|'failed'|'pasted'} status
 * @property {string} [title]
 * @property {string} description
 * @property {string} claims
 * @property {Passage[]} passages
 * @property {string} [fetchedAt]
 * @property {'X'|'Y'|'A'} [searchCategory]
 * @property {string} [error]
 */

/**
 * @typedef {Object} Citation
 * @property {string} label
 * @property {string} quote
 */

/**
 * @typedef {Object} CellResult
 * @property {string} featureId
 * @property {'Y'|'N'|'P'} verdict
 * @property {Citation[]} citations
 * @property {string} explanation
 * @property {'pending'|'running'|'done'|'error'} status
 * @property {string} [error]
 */

/**
 * @typedef {Object} DocSummary
 * @property {number} disclosedCount
 * @property {number} partialCount
 * @property {number} totalCount
 * @property {boolean} independentFullyDisclosed
 * @property {string} noveltyVerdict
 * @property {'X'|'Y'|'A'} suggestedCategory
 */

/**
 * @typedef {Object} Case
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{claims:string, description:string}} source
 * @property {{applicant?:string, applicationNo?:string, category?:ClaimCategory}} meta
 * @property {FeatureTable} table
 * @property {PriorArtDoc[]} documents
 * @property {Object<string, Object<string, CellResult>>} mappings   docId -> featureId -> CellResult
 * @property {Object<string, DocSummary>} summaries                   docId -> summary
 * @property {{modelId:string, proxy?:string}} settings
 */

export {}; // marks this as a module; no runtime exports
