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
