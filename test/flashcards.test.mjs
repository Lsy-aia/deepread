// Tests for DeepRead.Flashcards (service only). Run: node test/flashcards.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

// ---- fake DB (just the SQL the service uses) ----
const rows = new Map();
const db = {
  async queryAsync(sql, params = []) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE /i.test(s)) return [];
    if (/^INSERT OR REPLACE INTO flashcards/i.test(s)) {
      const [id, attachment_key, data, created_at, updated_at] = params;
      rows.set(id, { id, attachment_key, data, created_at, updated_at });
      return [];
    }
    if (/^SELECT data FROM flashcards WHERE attachment_key = \?/i.test(s)) {
      return [...rows.values()].filter((r) => r.attachment_key === params[0]).map((r) => ({ data: r.data }));
    }
    if (/^DELETE FROM flashcards WHERE id = \? AND attachment_key = \?/i.test(s)) {
      const r = rows.get(params[0]);
      if (r && r.attachment_key === params[1]) rows.delete(params[0]);
      return [];
    }
    throw new Error(`unexpected SQL: ${s}`);
  },
  async valueQueryAsync() { return null; },
};

let nextReply = "";
let lastRequest = null;
const ctx = {
  console, crypto, setTimeout, clearTimeout,
  Zotero: { debug() {}, locale: "zh-CN", Prefs: { get() {} } },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.DeepRead = {};
ctx.DeepRead.prefs = { language: () => "zh", llmConfig: () => ({ baseURL: "x", model: "m" }) };
ctx.DeepRead.Store = { db };
ctx.DeepRead.LLM = { async complete(args) { lastRequest = args; return { content: nextReply }; } };

for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/flashcards.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const FC = ctx.DeepRead.Flashcards;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  }
  catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${e.stack || e}`);
  }
}

await FC.init();

await test("save assigns id/timestamps and upserts", async () => {
  const a = await FC.save("1_AAAA", { pageIndex: 2, rects: [[10, 100, 50, 120]], quote: " q ", question: " Why? ", answer: "A", source: "selection" });
  assert.match(a.id, /^fc_[0-9a-f]{12}$/);
  assert.ok(a.createdAt && a.updatedAt);
  assert.equal(a.question, "Why?");
  assert.equal(a.quote, "q");
  const b = await FC.save("1_AAAA", { ...a, answer: "B" });
  assert.equal(b.id, a.id);
  assert.equal(b.createdAt, a.createdAt);
  assert.equal(rows.size, 1);
  assert.equal((await FC.list("1_AAAA"))[0].answer, "B");
});

await test("validation rejects bad cards", async () => {
  await assert.rejects(FC.save("k", { pageIndex: -1, rects: [], quote: "q", question: "x" }));
  await assert.rejects(FC.save("k", { pageIndex: 1.5, rects: [], quote: "q", question: "x" }));
  await assert.rejects(FC.save("k", { pageIndex: 0, rects: [[1, 2, 3]], quote: "q", question: "x" }));
  await assert.rejects(FC.save("k", { pageIndex: 0, rects: [], quote: "", question: "  " }));
  const ok = await FC.save("k", { pageIndex: 0, rects: [], quote: "q", question: "" });
  assert.equal(ok.question, "");
});

await test("list returns reading order", async () => {
  const k = "1_BBBB";
  const lower = await FC.save(k, { pageIndex: 1, rects: [[0, 50, 10, 60]], quote: "lower", question: "l" });
  const upper = await FC.save(k, { pageIndex: 1, rects: [[0, 700, 10, 710]], quote: "upper", question: "u" });
  const first = await FC.save(k, { pageIndex: 0, rects: [[0, 10, 10, 20]], quote: "p0", question: "z" });
  const list = await FC.list(k);
  assert.deepEqual([...list.map((c) => c.id)], [first.id, upper.id, lower.id]);
  assert.equal((await FC.list("nope")).length, 0);
});

await test("remove works", async () => {
  const list = await FC.list("1_BBBB");
  await FC.remove("1_BBBB", list[0].id);
  assert.equal((await FC.list("1_BBBB")).length, 2);
});

await test("generate parses clean JSON", async () => {
  nextReply = '{"question": "Why X?", "answer": "Because $a=b$."}';
  const r = await FC.generate({ quote: "passage", context: { title: "T", abstract: "A", pageText: "P" } });
  assert.deepEqual({ ...r }, { question: "Why X?", answer: "Because $a=b$." });
  assert.equal(lastRequest.responseFormat.type, "json_object");
  assert.equal(lastRequest.temperature, 0.3);
  const text = JSON.stringify(lastRequest);
  assert.ok(text.includes("Simplified Chinese") && text.includes("passage") && text.includes("Title: T"));
});

await test("generate parses fenced JSON", async () => {
  nextReply = 'Sure!\n```json\n{"question": "Q?", "answer": "A."}\n```';
  const r = await FC.generate({ quote: "passage" });
  assert.equal(r.question, "Q?");
  assert.equal(r.answer, "A.");
});

await test("generate throws on malformed reply", async () => {
  nextReply = "I cannot comply";
  await assert.rejects(FC.generate({ quote: "passage" }), /./);
  nextReply = '{"answer": "only"}';
  await assert.rejects(FC.generate({ quote: "passage" }), /./);
});

await test("answer returns text", async () => {
  nextReply = "  The paper says **so**.  ";
  const r = await FC.answer({ question: "Why?", quote: "qq", context: { title: "T" } });
  assert.equal(r, "The paper says **so**.");
  assert.ok(JSON.stringify(lastRequest).includes("Question: Why?"));
});

if (failures) {
  console.log(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all flashcards tests passed");
