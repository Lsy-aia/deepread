# Offline test tooling

Run the whole DeepRead pipeline inside Zotero without real MinerU / LLM services. Node built-ins and Python 3 stdlib only.

## 1. Build fixtures (git-ignored output in `test/fixtures/demo/`)

```
python3 test/build-fixture.py
```

Needs `.port-src/vibero/demo-paper-vibedb.json` and `demo-paper.pdf`. Produces `demo_content_list.json`
(MinerU-style content list, 99 items / 13 pages), `full.md`, `demo-paper.pdf` (import this PDF into Zotero) and
`mineru-result.zip` (files at the zip root + `images/` with 1x1 JPEG placeholders).

## 2. Fake servers

```
node test/fake-mineru.mjs [--port 18765]
node test/fake-openai.mjs [--port 18766] [--no-json-schema] [--delay-ms N]
```

- fake-mineru: self-hosted `POST /file_parse` (returns the zip), `GET /docs`, `GET /openapi.json`; official v4 emulation
  (`POST /api/v4/file-urls/batch` needs `Authorization: Bearer test-token`, `PUT /upload/b1`,
  `GET /api/v4/extract-results/batch/b1` goes waiting-file -> pending -> running x2 -> done, `GET /zip/b1`).
  Poll counter resets whenever a new batch is requested.
- fake-openai: `POST /v1/chat/completions`, `GET /v1/models`. Recognises page summary, author filter, article summary and
  outline prompts (zh and en) and returns valid JSON; anything else is a short markdown answer containing `$E=mc^2$` and
  `(p. 2)` (SSE when `stream: true`). `--no-json-schema` answers 400 (mentioning `response_format`) to `json_schema`
  requests, to test the fallback; `--delay-ms` delays each response. One log line per request.

## 3. DeepRead settings

- LLM: base URL `http://127.0.0.1:18766/v1`, model `fake`, API key anything.
- Parser, self-hosted: provider `selfhost`, URL `http://127.0.0.1:18765`.
- Parser, official: provider `mineru`, `parser.mineruBaseURL=http://127.0.0.1:18765`, token `test-token`
  (any other token gets `{code:-10002,msg:"token invalid"}`).
- Use the demo PDF `test/fixtures/demo/demo-paper.pdf` as the Zotero attachment.
