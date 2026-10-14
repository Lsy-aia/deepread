# DeepRead — developer notes and module contracts

DeepRead is a Zotero 7–10 plugin (bootstrapped, no build step for runtime code). It rebuilds the AI reading features of
"Vibero" (an AGPL fork of Zotero 8): MinerU PDF structure parsing → per-paragraph LLM summary / key points / point
translations → overlays in the PDF reader, plus article summary cards, AI outline and AI chat. All network calls go to
services **the user configures with their own keys**. Never call Vibero/Supabase endpoints.

Primary test target: Zotero 10.0.6 at `~/.local/opt/zotero-10.0.6` (Gecko 140 / Firefox ESR 140 JS engine).

## Runtime code conventions (addon/content/scripts/**)

- Files are loaded with `Services.scriptloader.loadSubScript(url, scope)` in the order listed in
  `addon/content/scripts/index.js`. **No `import`/`export`, no `require`, no ES modules.**
- Every module attaches to the shared namespace object `DeepRead` (e.g. `DeepRead.LLM = {...}`,
  `DeepRead.Pipeline = class Pipeline {...}`). Do not declare top-level `const`/`let`/`class` names other than through
  `DeepRead.*` (top-level lexical names from different files share one scope and collide). Wrapping a file body in an
  IIFE is fine.
- Globals available in the scope: `Zotero, Services, Components, ChromeUtils, Cc, Ci, Cu, IOUtils, PathUtils, fetch,
  URL, URLSearchParams, TextDecoder, TextEncoder, Blob, FormData, AbortController, crypto, btoa, atob, structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval, console`. No `window`/`document` globals — get a document from
  the element you are given or `Zotero.getMainWindow()`.
- Files and dirs: use `IOUtils` / `PathUtils` (async). Zip reading: `nsIZipReader`
  (`Components.Constructor("@mozilla.org/libjar/zip-reader;1", "nsIZipReader", "open")`), files via
  `Zotero.File.pathToFile(path)`.
- Logging: `DeepRead.log(...)` (goes to Zotero debug output). User-facing strings: `DeepRead.t(key, args)`
  (`scripts/l10n.js`), add keys for both `zh` and `en`.
- Prefs: `DeepRead.prefs.get("llm.model")` etc. (keys under `extensions.zotero.deepread.*`, defaults in `addon/prefs.js`).
  Helpers `DeepRead.prefs.llmConfig({chat})` and `DeepRead.prefs.parserConfig()` return normalized config objects.
- Each file starts with a short header comment and `License: AGPL-3.0-or-later`. Code ported from Vibero keeps a note
  `Ported from Vibero (AGPL-3.0, a Zotero fork)`.
- Style: 2-space indent, double quotes in new code (ported code may keep its quoting), semicolons.
- Quick syntax check for any runtime file: `node --check <file>` (it is a script, not a module).

## Module contracts

### DeepRead.LLM — `scripts/services/llm.js`
OpenAI-compatible Chat Completions client (`POST {baseURL}/chat/completions`).

```js
DeepRead.LLM.complete({
  messages,              // [{role, content}]; content may be string or OpenAI content-parts array
  system,                // optional string, prepended as a system message
  responseFormat,        // optional: { type: "json_schema", json_schema: {name, strict, schema} } | { type: "json_object" }
  maxTokens, temperature, signal, timeoutMs, config, // config defaults to DeepRead.prefs.llmConfig()
}) → Promise<{ content: string, usage?: object, raw: object }>

DeepRead.LLM.stream({ messages, system, signal, config, temperature, maxTokens,
                      onDelta(deltaText, fullText) }) → Promise<string /* full text */>

DeepRead.LLM.testConnection(config?) → Promise<{ ok: boolean, message: string }>
DeepRead.LLM.isConfigured(config?) → boolean   // baseURL and model set (apiKey may be empty for local servers)
```
Rules:
- `config.jsonMode` (pref `llm.jsonMode`) decides what is actually sent when a caller passes `responseFormat`:
  `"json_schema"` → send as given; `"json_object"` → always send `{type:"json_object"}`; `"none"` → send nothing.
  If the server answers 400/422 and the body mentions `response_format`/`json_schema`/`json_object`, retry once
  downgraded (json_schema → json_object → none).
- Headers: `Content-Type: application/json`, `Authorization: Bearer <apiKey>` when apiKey is non-empty, plus
  `config.extraHeaders`.
- Errors: throw `Error` whose message contains the HTTP status number (the pipeline checks `message.includes("429")`),
  status text and up to 500 chars of the body; set `error.status`.
- Retries: network errors and 5xx → retry up to 2 times (1s, 3s backoff). 429 → honor `Retry-After` (cap 20s), up to
  3 retries, then throw. Never retry other 4xx.
- `content`: `choices[0].message.content` (string; if array of parts, join text parts). Strip a leading
  `<think>…</think>` block. If `content` is empty but `reasoning_content` exists, do not use reasoning as content.
- Streaming: SSE (`stream: true`), parse `data:` lines, `choices[0].delta.content`, stop on `[DONE]`; support abort.
- Default timeout 240 s for `complete`, none for `stream` (abort via signal).

### DeepRead.Parser — `scripts/services/parser.js`
```js
DeepRead.Parser.parsePDF({ filePath, attachmentKey, onStatus, signal })
  → Promise<{ resultDir: string, contentList: object[], markdown: string }>
DeepRead.Parser.testConnection(config?) → Promise<{ ok, message }>
DeepRead.Parser.isConfigured(config?) → boolean
```
- Providers (pref `parser.provider`): `"mineru"` = official mineru.net API v4 with the user's token;
  `"selfhost"` = MinerU FastAPI (`mineru-api`) or any compatible third-party deployment (`POST {selfHostURL}/file_parse`).
- `resultDir = await DeepRead.Store.resultDirFor(attachmentKey)`; empty it before writing; unzip the result there and
  flatten a single wrapping folder.
- `contentList`: parsed MinerU `*_content_list.json` (bbox values are per-mille 0–1000, top-left origin, `page_idx`
  0-based), then each item gets `id: <index>` added (`{ id: index, ...item }`).
- `markdown`: content of `full.md` (or the first `*.md`), "" if absent.
- `onStatus({ phase, message, extractedPages, totalPages })`, phases: `upload | queued | running | download | extract`.

### DeepRead.Store — `scripts/services/store.js` (done)
`getPaper(key)`, `savePaper(key, itemID, fields)`, `deletePaper(key)`, `getChat(key)`, `saveChat(key, messages)`,
`resultDirFor(key)`. Paper fields: `result_dir, language, content_list, hierarchical_data, article_summary,
block_mapping, sections, markdown, github_url, user_state`.

### DeepRead.Pipeline — `scripts/pipeline/pipeline.js` (+ `summaryManager.js`, `languages.js`, `responseFormats.js`)
Port of Vibero's reader-side pipeline. See `docs/PIPELINE_PORT.md`.

### Reader integration, panes — `scripts/reader/*`, `scripts/panes/*`
Owned by the lead; not part of delegated tasks.

## Item pane / Fluent IDs (locale/<lang>/deepread.ftl)
Section headers use `.label`, sidenav buttons and section buttons use `.tooltiptext`:
`deepread-pane-summary-header`, `deepread-pane-summary-sidenav`, `deepread-pane-outline-header`,
`deepread-pane-outline-sidenav`, `deepread-pane-chat-header`, `deepread-pane-chat-sidenav`,
`deepread-section-button-regenerate`, `deepread-section-button-clear-chat`.

## Testing
- Offline fixtures: `test/fixtures/` (demo paper + MinerU-style content list rebuilt from Vibero's demo data).
- Fake services: `test/fake-openai.mjs` (OpenAI-compatible), `test/fake-mineru.mjs` (MinerU `/file_parse`).
- A separate Zotero profile + data dir is used for testing; never touch the user's real profile
  (`~/.zotero` → `~/Applications/Zotero/profile`) or data dir (`~/Applications/Zotero/data`).

## Zotero 10 / Gecko 140 gotchas (learned the hard way)
- `applications.zotero.update_url` and `strict_max_version` are **required**; otherwise the add-on is rejected
  silently and a sideloaded XPI is deleted from the profile.
- Developer proxy files (a text file with the source path) are detected but never installed; sideload a built XPI.
- Zotero starts plugins sequentially and awaits each `startup()`; never block startup on long work.
- The bootstrap sandbox has no `console`; `bootstrap.js` injects a shim (verbose logs need pref `deepread.debug`).
- `Services.parserUtils` is gone; use `Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils)`.
  HTML fragment parsing is unavailable in the XHTML main window: sanitize → DOMParser → importNode.
- Values resolved from content promises come back as Xrays: pdf.js getters (`page.view`, `getViewport`) are
  invisible until you `.wrappedJSObject` them. Clone arguments into content with `Cu.cloneInto`.
- Listeners added by privileged code to content nodes ignore untrusted (synthetic) events.
- Close `Zotero.DBConnection`s on app quit (`Zotero.addShutdownListener`): a non-empty `-wal` makes Zotero run a
  blocking integrity check with a progress popup on the next start.
- Preference-pane scripts run before the pane fragment is inserted; Zotero then dispatches a non-bubbling
  `load` event on the pane root (listen in the capture phase).

## v0.2 contracts

### Session additions (`reader/session.js`, owned by the lead — use, don't edit)
- `session.flashcards` (array or null until loaded), `await session.loadFlashcards()`,
  `await session.saveFlashcard(card)` → saved card (upsert), `await session.deleteFlashcard(id)`,
  `await session.navigateToFlashcard(card)`, `session.flashcardContext(pageIndex)` → `{ title, abstract, pageText }`.
  Emits `"flashcards"` (payload `{ id }`) after every change.
- `session.githubRepo` ("owner/repo" or null, persisted in papers.github_url), `await session.setGitHubRepo(fullName|null)`
  (emits `"github"`), `await session.paperText(maxChars)` → abstract + parsed text (or Zotero full-text cache).
- `session.askAI({ text, pageIndex })` quotes text into the chat pane; `session.reader.navigate(location)`.
- Pane renderers: `DeepRead.Panes.renderers.<kind> = (ctx) => {}` with `ctx = { body, doc, session, event, h }`.
  Events: `change | progress | ask | chat | chat-delta | flashcards | github`. Return early for events you don't need
  (re-rendering on every progress tick destroys input focus). `h(tag, props, ...children)` = `DeepRead.util.h`.
  Shared helpers: `DeepRead.Markdown.render(doc, text, contextEl)` → sanitized fragment (marked + KaTeX),
  `DeepRead.Markdown.wireLinks(container)`, `DeepRead.Panes.reportError(session, error)`, CSS classes in
  `content/styles/panes.css` (`dr-pane`, `dr-muted`, `dr-error`, `dr-empty`, `dr-primary-button`, `dr-link-button`,
  `dr-clickable`, `dr-markdown`, `dr-chip`). Put new pane CSS in your own stylesheet file and tell the lead.

### DeepRead.Flashcards — `services/flashcards.js`
Card: `{ id, pageIndex, rects: [[x1,y1,x2,y2]] /* PDF coords */, quote, question, answer, color, source:
"selection"|"paragraph"|"manual", createdAt, updatedAt }` (ISO strings).
```js
await DeepRead.Flashcards.init()                 // CREATE TABLE IF NOT EXISTS flashcards (... ) on DeepRead.Store.db
await DeepRead.Flashcards.list(attachmentKey)    // → cards in reading order (DeepRead.Flashcards.sort)
DeepRead.Flashcards.sort(cards)                  // pageIndex asc, then top (max y) desc, then createdAt
await DeepRead.Flashcards.save(attachmentKey, card) // upsert; assigns id "fc_<12 hex>" and timestamps; returns card
await DeepRead.Flashcards.remove(attachmentKey, id)
await DeepRead.Flashcards.generate({ quote, context, signal })  // → { question, answer } via DeepRead.LLM (JSON)
await DeepRead.Flashcards.answer({ question, quote, context, signal }) // → markdown answer string
await DeepRead.Flashcards.exportToNote(parentItem, cards, { title }) // → new child note (HTML) in Zotero
```
`context` = `session.flashcardContext(pageIndex)`; answer language = `DeepRead.PARSE_LANGUAGES[DeepRead.prefs.language()]`.

### DeepRead.GitHub — `services/github.js`
```js
DeepRead.GitHub.parseRepo(urlOrFullName)   // → { owner, repo, fullName, url } | null
DeepRead.GitHub.findReposInText(text)      // → [{ fullName, url, count, firstIndex }] most relevant first
await DeepRead.GitHub.search(title, { signal })  // → [{ fullName, url, description, stars, language, updatedAt }]
await DeepRead.GitHub.getRepo(fullName)    // → { fullName, url, description, stars, forks, language, license, updatedAt, defaultBranch, topics, homepage, archived }
await DeepRead.GitHub.getReadme(fullName)  // → { markdown, htmlURL } | null
await DeepRead.GitHub.listDir(fullName, path = "", ref)   // → [{ name, path, type: "file"|"dir", size }]
await DeepRead.GitHub.getFile(fullName, path, ref)        // → { text, size, truncated, binary, htmlURL }
```
Optional token pref `github.token` (Bearer). Errors name the step, include status; rate limit → message with reset time.

### DeepRead.DeepWiki — `services/deepwiki.js`
Client for DeepWiki's public MCP server (pref `deepwiki.endpoint`, default `https://mcp.deepwiki.com/mcp`):
`callTool(name, args, { signal })` → text; `readWikiStructure(fullName)`, `readWikiContents(fullName)`,
`askQuestion(fullName, question, { signal })`. Handles MCP initialize/session id and JSON or SSE responses.

## v0.3 parser providers (lightweight / local)

`DeepRead.Parser.parsePDF` dispatches on pref `parser.provider`:
`"builtin"` (new default) | `"grobid"` | `"mineru"` | `"selfhost"`. Every provider must return a **MinerU-style
content list**: items in reading order, each `{ type: "text"|"image"|"table"|"equation", text?, text_level? (1 for
titles/headings), bbox: [x0, y0, x1, y1] (per-mille 0–1000 of the page box, TOP-LEFT origin), page_idx (0-based) }`;
images `{ type:"image", img_path:"", image_caption:[...], image_footnote:[] }`, tables `{ type:"table", img_path:"",
table_caption:[...], table_body:"", table_footnote:[] }`, equations `{ type:"equation", text, text_format:"latex"|"text" }`.
Headers, footers, page numbers and marginal stamps (e.g. the rotated arXiv id) are omitted. `Parser` adds `id`.
Per-mille conversion from a PDF rect `[x1,y1,x2,y2]` (bottom-left origin) on a page with view box `[vx0,vy0,vx1,vy1]`:
`x = (X - vx0) / (vx1 - vx0) * 1000`, `y = (vy1 - Y) / (vy1 - vy0) * 1000` (so y0 comes from the rect's top).

### DeepRead.TextLayerParser — `services/textLayerParser.js` (provider "builtin", no service)
```js
await DeepRead.TextLayerParser.parse({ pdfApp, onStatus, signal }) // → { contentList, markdown }
DeepRead.TextLayerParser.buildContentList(pages)                    // pure function (unit-testable)
//   pages = [{ pageIndex, viewBox: [x0,y0,x1,y1], chars: [...] }] as returned by pdfApp.pdfDocument.getPageData
```
`pdfApp` is the session's pdf adapter (`pdfDocument.numPages`, `pdfDocument.getPageData({pageIndex})` → `{ chars,
viewBox }`). Chars (Zotero's structured text): `{ c, u, rect:[x1,y1,x2,y2], fontSize, fontName, bold, italic, baseline,
rotation, spaceAfter, lineBreakAfter, paragraphBreakAfter, inlineRect }`, in reading order (columns handled).

### DeepRead.GrobidParser — `services/grobidParser.js` (provider "grobid", local Docker service)
```js
await DeepRead.GrobidParser.parse({ filePath, config, onStatus, signal }) // → { contentList, markdown }
DeepRead.GrobidParser.teiToContentList(teiXmlString, { DOMParser })       // pure function (unit-testable)
await DeepRead.GrobidParser.testConnection(config)                        // → { ok, message }
```
Config: `parser.grobidURL` (default `http://127.0.0.1:8070`). `POST {url}/api/processFulltextDocument` with
`teiCoordinates` for head, p, s, figure, formula, title; page sizes from `<facsimile><surface>`.

## v0.4: full-document translation through ReadFlow (step 2)

ReadFlow (our RetainPDF-based app, repo `~/Documents/LeoProjetcs/Retainpdf/readflow-maint/ReadFlow`) exposes a local
Rust API (desktop app: `http://127.0.0.1:41000`, header `X-API-Key: retain-pdf-desktop` — a constant in ReadFlow's
open-source `frontend/desktop/main.js`; the same API can be deployed with Docker). API docs: `backend/api/API_SPEC.md`
and `backend/api/docs/api-spec/*.md` (jobs-submission, jobs-query, artifacts, credentials, runtime-and-events).
DeepRead submits a `book` workflow job (OCR/normalize → translate → render) and saves the rendered PDF as a Zotero
attachment. The user chooses the output per run: `"dual"` (side-by-side original | translation, render_mode `dual`)
or `"inplace"` (translation typeset in place, render_mode `auto`). Translation uses **DeepRead's LLM settings**
(`DeepRead.prefs.llmConfig()`: baseURL/model/apiKey).

### DeepRead.ReadFlow — `services/readflow.js`
```js
DeepRead.ReadFlow.config()                     // { baseURL, apiKey, ocrProvider, defaultMode } from prefs readflow.*
await DeepRead.ReadFlow.testConnection(cfg?)   // → { ok, message } (GET /health + an authenticated GET)
await DeepRead.ReadFlow.translatePDF({ filePath, mode: "dual"|"inplace", sourceLang?, targetLang, onStatus, signal })
//   → { pdfBytes: Uint8Array, jobId, fileName }  (upload → create job → poll → download PDF artifact)
//   onStatus({ phase: "upload"|"queued"|"ocr"|"translate"|"render"|"download", percent, message })
await DeepRead.ReadFlow.cancel(jobId)
```
Prefs: `readflow.baseURL` (default `http://127.0.0.1:41000`), `readflow.apiKey` (default `retain-pdf-desktop`),
`readflow.ocrProvider` (default `"local"`), `readflow.defaultMode` (`"dual"`).
