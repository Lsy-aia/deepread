// Tests for DeepRead.ReadFlow against test/fake-readflow.mjs. Run: node test/readflow.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeReadFlow } from "./fake-readflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");
const pdfPath = path.join(root, "test/fixtures/demo/demo-paper.pdf");
const pdfBytes = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : Buffer.from("%PDF-1.4\n%%EOF\n");

const logs = [];
const { server, state } = createFakeReadFlow({ apiKey: "retain-pdf-desktop", pollsPerStage: 2, log: (l) => logs.push(l) });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const prefs = {
  "readflow.baseURL": `http://127.0.0.1:${port}`,
  "readflow.apiKey": "retain-pdf-desktop",
  "readflow.ocrProvider": "local",
  "readflow.defaultMode": "dual",
};
let llm = { baseURL: "http://llm.invalid/v1", apiKey: "sk-SECRET-123", model: "m1" };
const logLines = [];
const sandbox = {
  fetch, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout, console, URL, FormData, Blob, Uint8Array,
  Zotero: { debug() {}, locale: "en-US", Prefs: { get() {} } },
  IOUtils: { read: async (p) => new Uint8Array(fs.readFileSync(p)) },
  PathUtils: { filename: (p) => path.basename(p) },
  DeepRead: {},
};
const ctx = vm.createContext(sandbox);
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/readflow.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const DR = sandbox.DeepRead;
DR.log = (...a) => logLines.push(a.join(" "));
let lang = "zh";
DR.prefs = { get: (k) => prefs[k], llmConfig: () => llm, language: () => lang };
const RF = DR.ReadFlow;
RF.POLL_INTERVAL_MS = 5;

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name, "\n", e); process.exitCode = 1; }
};
const lastJob = () => [...state.jobs.values()].at(-1);
const tmp = path.join(os.tmpdir(), `rf-test-${process.pid}.pdf`);
fs.writeFileSync(tmp, pdfBytes);

await test("testConnection OK", async () => {
  const r = await RF.testConnection();
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^OK \(/);
});

await test("testConnection: not running", async () => {
  const r = await RF.testConnection({ ...RF.config(), baseURL: "http://127.0.0.1:1" });
  assert.equal(r.ok, false);
  assert.match(r.message, /not running|未启动|无法连接/);
});

await test("testConnection: API key rejected (40100)", async () => {
  const r = await RF.testConnection({ ...RF.config(), apiKey: "wrong" });
  assert.equal(r.ok, false);
  assert.match(r.message, /rejected|拒绝/);
});

await test("testConnection: unknown OCR provider lists accepted values", async () => {
  const r = await RF.testConnection({ ...RF.config(), ocrProvider: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.message, /mineru, paddle, local/);
});

await test("translatePDF dual: full flow, phases, credential_ref, render_mode dual", async () => {
  const events = [];
  const out = await RF.translatePDF({ filePath: tmp, mode: "dual", sourceLang: "auto", onStatus: (s) => events.push(s) });
  assert.ok(out.pdfBytes instanceof Uint8Array || out.pdfBytes.constructor.name === "Uint8Array");
  assert.deepEqual(Buffer.from(out.pdfBytes), pdfBytes);
  assert.equal(out.fileName, path.basename(tmp).replace(/\.pdf$/, "") + "-dual.pdf");
  assert.ok(out.jobId);
  const job = lastJob();
  assert.equal(job.request.render.render_mode, "dual");
  assert.equal(job.request.workflow, "book");
  assert.equal(job.request.ocr.provider, "local");
  assert.equal(job.request.ocr.language, undefined); // auto
  assert.equal(job.request.translation.model, "m1");
  assert.equal(job.request.translation.base_url, "http://llm.invalid/v1");
  assert.ok(job.request.translation.credential_ref.startsWith("cred_"));
  assert.equal(job.request.translation.api_key, undefined);
  const phases = [...new Set(events.map((e) => e.phase))];
  assert.deepEqual(phases, ["upload", "queued", "ocr", "translate", "render", "download"]);
  const pcts = events.map((e) => e.percent);
  assert.deepEqual([...pcts].sort((a, b) => a - b), pcts, "percent is monotonic");
  assert.equal(pcts.at(-1), 100);
});

await test("credential reused/updated, secret never logged", async () => {
  const before = state.credentials.size;
  assert.equal(before, 1);
  const [ref, c0] = [...state.credentials][0];
  assert.equal(c0.label, "deepread-llm");
  llm = { ...llm, apiKey: "sk-ROTATED-456" };
  await RF.translatePDF({ filePath: tmp, mode: "inplace", sourceLang: "en" });
  assert.equal(state.credentials.size, 1);
  assert.equal(state.credentials.get(ref).secret, "sk-ROTATED-456");
  assert.equal(state.credentials.get(ref).revision, 2);
  const job = lastJob();
  assert.equal(job.request.render.render_mode, "auto");
  assert.equal(job.request.ocr.language, "en");
  const all = logLines.join("\n") + logs.join("\n");
  assert.ok(!all.includes("sk-SECRET-123") && !all.includes("sk-ROTATED-456"));
  assert.ok(all.includes("render_mode=dual") && all.includes("render_mode=auto"));
});

await test("empty LLM key uses placeholder; non-zh target adds a language rule", async () => {
  llm = { ...llm, apiKey: "" };
  lang = "en";
  await RF.translatePDF({ filePath: tmp, mode: "dual", targetLang: "en" });
  const [, c] = [...state.credentials][0];
  assert.equal(c.secret, RF.NO_KEY_PLACEHOLDER);
  assert.match(lastJob().request.translation.custom_rules_text, /English/);
  lang = "zh";
  await RF.translatePDF({ filePath: tmp, mode: "dual" });
  assert.equal(lastJob().request.translation.custom_rules_text, undefined);
});

await test("failed job surfaces failure message", async () => {
  llm = { ...llm, model: "fake-fail" };
  await assert.rejects(RF.translatePDF({ filePath: tmp, mode: "dual" }), (e) => {
    assert.match(e.message, /ReadFlow job failed at stage "translating"/);
    assert.match(e.message, /HTTP 401/);
    assert.match(e.message, /suggestion: Check the LLM API key/);
    return true;
  });
});

await test("abort cancels the ReadFlow job", async () => {
  llm = { ...llm, model: "fake-slow" };
  const ac = new AbortController();
  const p = RF.translatePDF({ filePath: tmp, mode: "dual", signal: ac.signal, onStatus: (s) => { if (s.phase === "translate") ac.abort(); } });
  await assert.rejects(p, (e) => e.name === "AbortError");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lastJob().status, "canceled");
});

await test("cancel(jobId) uses POST /cancel", async () => {
  llm = { ...llm, model: "fake-slow" };
  const ac = new AbortController();
  let id;
  const p = RF.translatePDF({ filePath: tmp, signal: ac.signal, onStatus: (s) => { if (s.phase === "ocr") { id = lastJob().id; ac.abort(); } } });
  await assert.rejects(p);
  const j = lastJob();
  j.status = "running";
  await RF.cancel(id);
  assert.equal(j.status, "canceled");
});

await test("API errors name the step, status and body", async () => {
  llm = { ...llm, model: "m1" };
  prefs["readflow.ocrProvider"] = "bogus";
  await assert.rejects(RF.translatePDF({ filePath: tmp, mode: "dual" }), (e) => {
    assert.match(e.message, /ReadFlow create job failed: HTTP 400/);
    assert.match(e.message, /unsupported ocr.provider: bogus/);
    return true;
  });
  prefs["readflow.ocrProvider"] = "local";
  prefs["readflow.apiKey"] = "bad";
  await assert.rejects(RF.translatePDF({ filePath: tmp }), (e) => {
    assert.match(e.message, /upload PDF failed: HTTP 401/);
    assert.equal(e.status, 401);
    return true;
  });
  prefs["readflow.apiKey"] = "retain-pdf-desktop";
});

fs.rmSync(tmp, { force: true });
server.close();
console.log(`${passed} passed`);
