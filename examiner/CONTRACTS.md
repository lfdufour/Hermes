# Hermes — Patent Examiner's Assistant — Implementation Contracts

**Read this fully before coding.** It is the single source of truth for the data model, module
APIs, EPO methodology, and prompt expectations. If a contract here is unworkable, stop and flag it
in your final report — do not silently diverge.

Hermes is being re-tuned from a general assistant into an **EPO-style patent-examiner helper**. It
runs **fully client-side**: the only network traffic allowed is **inbound** retrieval of public
patent documents (Google Patents). No prompts, claims, or analysis ever leave the device.

## Hard rules for every agent
- **Vanilla ES modules. No framework, no bundler, no `npm install`.** Runtime model dependency is
  `@huggingface/transformers` v3, imported **only inside the reused Iris worker** — you do not touch it.
- Target: **Chromium + WebGPU (with WASM fallback), served over http(s)** (localhost / GitHub Pages),
  **not `file://`**.
- **Only create/edit files inside `examiner/`.** Never modify `iris/` or the repo-root Hermes
  (`index.html`, `README.md`, `ARCHITECTURE.md`, `LICENSE`, `.nojekyll`). You may **import** from
  `../iris/src/engine/` read-only.
- **Do not run git. Do not commit or push.** The architect integrates and commits.
- Each module is an ES module with **named exports exactly as specified**.
- **No LLM tool-calls.** The app orchestrates everything (fetch, storage, table filling)
  deterministically. The model is called only for two cognitive tasks (feature extraction, feature
  mapping) via `engine/infer.js`, which returns parsed JSON.
- Keep code small and readable, with function-level comments. No external asset files (no
  images/fonts/CDN CSS); all styles live in `examiner/index.html` or `examiner/src/styles.css`.
- Where you make a judgment call, leave a short `// NOTE:` explaining what and why.
- **Self-check:** any pure-logic module ships a `*.test.mjs` that runs under `node <file>` (zero deps),
  prints PASS/FAIL, and exits non-zero on failure. State in your report what you verified vs. what
  needs in-browser validation.

## File layout (everything under `examiner/`)
```
examiner/
  index.html                 # shell: theme CSS + container divs + <script type=module src=src/main.js>
  src/
    main.js                  # bootstrap: instantiate engine + store, wire UI
    types.js                 # JSDoc typedefs only — shared vocabulary (PROVIDED)
    engine/
      models.js              # local model registry (PROVIDED)
      infer.js               # generic local inference + JSON structured output (PROVIDED)
    patent/                  # AGENT: patents
      fetch.js               # Google Patents fetch via CORS proxy + paste fallback
      parse.js               # extract description/claims, segment into labeled passages
      retrieve.js            # lexical passage retrieval for a feature
      patent.test.mjs        # tests for parse + retrieve (pure logic)
    features/                # AGENT: cognition
      extract.js             # Step 1: claims(+desc) -> FeatureTable (EPO feature analysis)
      table.js               # FeatureTable helpers: numbering, dependency context, validation
      prompts.js             # EPO-aligned prompt templates (extraction + mapping)
      cognition.test.mjs     # tests for table.js + JSON parsing helpers (pure logic)
    mapping/                 # AGENT: cognition
      map.js                 # Step 2: per feature x document -> CellResult; per-doc summary
    store/                   # AGENT: storage
      cases.js               # IndexedDB CRUD for Cases; export/import JSON
      exportReport.js        # matrix -> CSV / Markdown (examiner search-report style)
      store.test.mjs         # tests for exportReport (pure logic; mock IDB)
    ui/                      # AGENT: ui
      app.js                 # top controller + view routing + model bar
      step1View.js           # claims/description input -> table
      tableView.js           # editable feature-table grid
      step2View.js           # patent input, fetch status, run mapping, progressive matrix, export
      casesView.js           # saved-cases browser
  CONTRACTS.md  (this file)
```

## Reused Iris engine (do not modify; import read-only)
`../iris/src/engine/client.js` exports `EngineClient`:
- `new EngineClient()` — spawns the transformers.js module worker.
- `await load({ repo, dtype, device, onProgress })` — `onProgress({file,loaded,total,pct})`.
- `await applyChatTemplate({ messages, thinking })` → `{ input_ids, rendered }` (tokenizer's own
  template; works for Qwen/Llama/Gemma). Pass `thinking:false` for examiner work.
- `generate({ input_ids, genConfig, onToken })` → `Promise<{ outputText, stats }>`.
- `cancel()`, `await unload()`, `await storage(op, repo)`.

`engine/infer.js` (PROVIDED) wraps this so agents never touch the worker directly.

---

## Shared data model (authoritative — see `src/types.js` for JSDoc)

```
Case {
  id, title, createdAt, updatedAt,
  source:   { claims:string, description:string },   // raw Step-1 input
  meta:     { applicant?, applicationNo?, category? },
  table:    FeatureTable,                              // Step-1 output; EDITABLE then FROZEN
  documents: PriorArtDoc[],                            // Step-2 fetched patents
  mappings: { [docId]: { [featureId]: CellResult } },  // Step-2 results — SEPARATE from table
  summaries:{ [docId]: DocSummary },
  settings: { modelId, proxy? }
}

FeatureTable {
  claims:   ClaimMeta[]   // { num:number, type:'independent'|'dependent', dependsOn:number[],
                          //   category:'product'|'process'|'use'|null, twoPart:boolean }
  features: Feature[]
}

Feature {
  id:string,              // EPO-style numbering, e.g. "1.1" (claim 1, feature 1)
  claim:number,           // owning claim number
  type:'independent'|'dependent',
  dependsOn:number[],     // claim numbers the owning claim depends on
  text:string,            // verbatim atomic technical feature (one limitation)
  portion:'preamble'|'characterizing'|null,  // two-part form, Rule 43(1) EPC
  refSigns:string[],      // reference numerals from drawings, Rule 43(7) (non-limiting)
  category:'product'|'process'|'use'|null,
  note?:string            // examiner interpretation / broadest-reasonable meaning (editable)
}

PriorArtDoc {
  id:string,              // normalized number, e.g. "DE19728057C2"
  number:string, url:string,
  status:'pending'|'loaded'|'failed'|'pasted',
  title?:string, description:string, claims:string,
  passages:Passage[],     // segmented description+claims with citation labels
  fetchedAt?:string,
  searchCategory?:'X'|'Y'|'A'   // examiner search-report category (auto-suggested, editable)
}

Passage { index:number, label:string, text:string, section:'description'|'claims' }
   // label e.g. "[0023]" or "col. 3, ll. 5-12" or "p.4 l.10" or "claim 3"; best-effort.

CellResult {
  featureId:string,
  verdict:'Y'|'N'|'P',    // disclosed / not disclosed / partial (implicit/ambiguous)
  citations:{ label:string, quote:string }[],   // verbatim, copied from passages
  explanation:string,     // concise reasoned mapping incl. dependency context
  status:'pending'|'running'|'done'|'error',
  error?:string
}

DocSummary {
  disclosedCount:number, partialCount:number, totalCount:number,
  independentFullyDisclosed:boolean,   // all features of independent claim(s) present -> novelty-destroying
  noveltyVerdict:string,               // short narrative
  suggestedCategory:'X'|'Y'|'A'
}
```

---

## EPO methodology to implement (this is what makes the tool "educated")

### Step 1 — Feature analysis (extraction)
- **Decompose each claim into atomic technical features** — one technical limitation per feature.
- **Number features examiner-style:** claim N → `N.1, N.2, …` in textual order.
- **Independent vs dependent:** detect "according to claim X" / "of claim X" → `type:'dependent'`,
  `dependsOn:[X,…]`. A dependent claim implicitly **inherits** all features of the claims it depends
  on — record `dependsOn` so Step 2 can supply that context (do not duplicate inherited features as rows).
- **Two-part form (Rule 43(1) EPC):** if a claim contains "characterized in that/by" (or
  "the improvement comprising"), features before it are `portion:'preamble'` (presumed known from the
  prior art), features after are `portion:'characterizing'` (the asserted contribution). If the claim
  is not in two-part form, `portion:null` and `twoPart:false`.
- **Reference signs (Rule 43(7)):** capture parenthetical numerals/letters (e.g. "(12)", "(3a)") into
  `refSigns`; they are **not limiting** — keep them out of the feature `text` meaning but record them.
- **Claim category:** product/apparatus vs process/method vs use, from claim wording.
- Output **strict JSON** matching `FeatureTable`. To stay reliable on small models, extraction is
  orchestrated **one claim at a time** by `extract.js` (small prompts), then assembled + re-numbered.

### Step 2 — Feature mapping / novelty matrix
- For each `(feature, document)`: assess whether the feature is **"directly and unambiguously
  derivable"** from the document (EPO novelty standard; explicit *or* clearly implicit disclosure).
  - `Y` = disclosed; `P` = partially/implicitly/ambiguously disclosed; `N` = not disclosed.
- **Citations are mandatory for Y/P:** verbatim quote(s) copied exactly from the provided passages,
  each with its passage `label`. Never invent passages or labels.
- **Explanation:** concise reasoned mapping; must take the feature's **dependency context** into
  account (the independent-claim features a dependent feature builds on).
- **Per-document summary:** count disclosed/partial; if **all** independent-claim features are `Y`,
  set `independentFullyDisclosed:true` (novelty-destroying → category `X`). If it discloses many but
  not all features / is relevant in combination → `Y`. Otherwise background → `A`. Provide a short
  `noveltyVerdict` narrative.
- The **frozen feature table is never modified** by Step 2. Mappings live in `Case.mappings[docId]`.

---

## Module contracts

### `engine/models.js` (PROVIDED) — `MODELS`, `DEFAULT_MODEL_ID`, `getModel(id)`.

### `engine/infer.js` (PROVIDED)
```
createInference({ engine }) -> {
  setModelLoaded(bool), isReady(),
  // Run a chat completion; returns raw text.
  complete({ system, user, genConfig, signal, onToken }) -> Promise<string>
  // Run and parse a single JSON object/array out of the model output (tolerant repair).
  completeJSON({ system, user, schemaHint, genConfig, signal }) -> Promise<any>
}
parseJSONLoose(text) -> any|null   // exported helper: extract+repair first JSON value in a string
```
Agents call `infer.completeJSON(...)`; they never call the engine worker directly.

### `patent/fetch.js`
```
normalizeNumber(input) -> string                 // strip spaces, uppercase, e.g. "de 19728057 c2" -> "DE19728057C2"
buildPatentUrl(number) -> string                 // https://patents.google.com/patent/NUMBER/en
DEFAULT_PROXIES: string[]                         // CORS proxy URL templates ("{url}" placeholder)
fetchPatent(number, { proxies?, signal }) -> Promise<{ ok, number, url, html?, error? }>
   // tries proxies in order; resolves ok:false (never throws) with a human error on total failure.
parsePasted(number, text) -> PriorArtDoc          // build a 'pasted' doc from manual text
```
- **CORS:** end-user browsers cannot fetch patents.google.com directly. Use proxy templates (verify a
  working one against `DE19728057C2`); leave them editable in settings. Patent data is public.

### `patent/parse.js`
```
parsePatentHtml(number, html) -> PriorArtDoc      // extract title + description + claims patent-text, segment passages
segmentPassages(text, section) -> Passage[]       // split into labeled passages ([00xx]/col-line/claim n)
```
- Google Patents exposes the body inside elements like `<section itemprop="description">` and
  `<section itemprop="claims">` (and/or `patent-text` nodes with `name="description"` / `name="claims"`).
  **Verify the real structure** by fetching `DE19728057C2` (use WebFetch); handle both shapes; fall
  back to paragraph splitting with sequential labels when no paragraph numbers exist.

### `patent/retrieve.js`
```
topPassages(featureText, passages, { k=6 }) -> Passage[]   // lexical overlap ranking (stopword-filtered TF), deterministic, offline
```

### `features/extract.js`
```
extractFeatureTable({ infer, claims, description, onProgress, signal }) -> Promise<FeatureTable>
   // orchestrates per-claim extraction via infer.completeJSON, assembles + renumbers via table.js.
   // onProgress({ claim, total }) for UI ticks.
```
### `features/table.js`
```
renumber(features) -> Feature[]                  // assign N.M ids per claim
dependencyContext(feature, table) -> string      // text of inherited independent-claim features
validateTable(table) -> { ok, errors }
splitClaimsIntoUnits(claimsText) -> {num, text}[] // split a claims blob into individual claims (heuristic)
```
### `features/prompts.js`
```
extractionPrompt({ claimText, claimNumber, allClaimsContext }) -> { system, user }
mappingPrompt({ feature, dependencyContext, passages }) -> { system, user }
```
- Prompts must demand **strict JSON only**, no prose, matching the schemas. Provide a compact shape
  example in the prompt. Mapping prompt instructs: quote verbatim from the numbered passages, use their
  labels, apply the "directly and unambiguously derivable" standard, output Y/N/P.

### `mapping/map.js`
```
mapFeature({ infer, feature, table, doc, signal }) -> Promise<CellResult>
mapDocument({ infer, table, doc, onCell, signal }) -> Promise<{ cells, summary }>
   // iterates features; calls retrieve.topPassages then infer; emits onCell(cellResult) progressively.
summarize(table, cells) -> DocSummary
```

### `store/cases.js`
```
casesStore = {
  init() -> Promise<void>,
  list() -> Promise<{id,title,updatedAt}[]>,
  get(id) -> Promise<Case|null>,
  save(case) -> Promise<void>,         // upserts; bumps updatedAt
  remove(id) -> Promise<void>,
  newCase({title}) -> Case             // factory with ids/timestamps
}
```
- IndexedDB (db `hermes-examiner`, store `cases`). Cases can be large (full patent text) → not localStorage.

### `store/exportReport.js`
```
toCSV(case) -> string        // features x documents matrix (verdict + citations + explanation)
toMarkdown(case) -> string   // examiner search-report style table
```

### `ui/` (see Aesthetic below)
- `app.js` owns the DOM, instantiates `EngineClient` + `createInference` + `casesStore`, renders the
  **model bar** (pick model → load with progress + device indicator), and routes between views:
  **Cases**, **Step 1 (Build Table)**, **Step 2 (Mapping)**.
- `step1View`: claims textarea (required) + collapsible description textarea + "Analyze claims →
  feature table"; per-claim progress; then renders `tableView`; Save case (title prompt).
- `tableView`: editable grid (columns: Feature ID, Claim, Type, Depends on, Portion, Ref signs,
  Feature text, Note); inline edit, add/delete/reorder rows, "Re-number", a legend explaining the EPO
  conventions, and "Freeze & continue to mapping".
- `step2View`: patent-number chips input + Fetch (per-patent status chips: loaded ✓ / failed ✗ →
  inline paste box / pasted) + "Run feature mapping". Renders the **matrix**: sticky left = frozen
  features; per document a 3-column group (Verdict | Citations | Explanation). Cells fill
  **progressively** with a shimmer→fade; verdict color+icon coded (Y green ✓, P amber ◐, N red ✗,
  never color-only). Click a cell → expandable card (full citations w/ labels + explanation +
  dependency context). Per-document footer = `DocSummary` with editable search category. Export CSV /
  Markdown / Print.
- `casesView`: list/open/delete saved cases.

## Aesthetic — "patent office" theme (in `index.html` / `styles.css`)
- Authoritative, document-like: paper surfaces, ink-blue primary, restrained accents, a system **serif**
  for headings (e.g. `Georgia, "Times New Roman", serif` — no web fonts), system sans for body/UI.
- Verdict palette (with icons, not color alone): Y `#15803d`, P `#b45309`, N `#b91c1c`.
- Subtle motion only: fade/slide-in for views, a cell **shimmer** placeholder while a mapping cell is
  running, progress bars for model load + per-claim/per-cell. Respect `prefers-reduced-motion`.
- Clean, dense, legible tables; sticky headers and sticky feature column for the matrix.
```
```
