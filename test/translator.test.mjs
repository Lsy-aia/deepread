// Tests for DeepRead.Translator (no network). Run: node test/translator.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

let llmImpl = async () => ({ content: "{}" });
let calls = [];
const ctx = { console, setTimeout, clearTimeout, Zotero: { debug() {}, locale: "zh-CN", Prefs: { get() {} } } };
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.DeepRead = {};
ctx.DeepRead.prefs = { language: () => "zh", llmConfig: () => ({ baseURL: "x", model: "m", concurrency: 3 }) };
ctx.DeepRead.LLM = { async complete(args) { calls.push(args); return llmImpl(args); } };
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/translator.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const T = ctx.DeepRead.Translator;
const J = (x) => JSON.parse(JSON.stringify(x)); // detach from the vm realm for deepEqual

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}

// ---- fake LLM helpers ----
const itemsOf = (args) => {
  const content = args.messages[0].content;
  const i = content.indexOf(T.ITEMS_MARKER) + T.ITEMS_MARKER.length;
  const j = content.indexOf("\n\n", i);
  return JSON.parse(content.slice(i, j)).items;
};
const reply = (items, fn) => JSON.stringify({
  translations: items.map((it) => ({ item_id: it.item_id, translated_text: fn(it), decision: "translate" })),
});
const zh = (it) => "译文：" + it.source_text.replace(/[A-Za-z]{3,}/g, (m) => m === "" ? m : "") + " 这是中文翻译内容";
const EN = "This is a long English paragraph that was not translated at all by the model and keeps going on and on.";

await test("buildUnits on demo content list", () => {
  const p = path.join(root, "test/fixtures/demo/demo_content_list.json");
  let list;
  if (fs.existsSync(p)) list = JSON.parse(fs.readFileSync(p, "utf8")).map((x, id) => ({ id, ...x }));
  else list = [
    { id: 0, type: "text", text_level: 1, text: "Intro", page_idx: 0 },
    { id: 1, type: "image", image_caption: ["Figure 1: A"], page_idx: 0 },
    { id: 2, type: "equation", text: "x=1", page_idx: 0 },
    { id: 3, type: "text", text_level: 1, text: "References", page_idx: 1 },
    { id: 4, type: "text", text: "Smith et al. paper", page_idx: 1 },
  ];
  const units = T.buildUnits(list);
  assert.ok(units.length > 0);
  assert.ok(units.some((u) => u.kind === "caption"));
  assert.ok(units.some((u) => u.kind === "title"));
  assert.ok(!units.some((u) => list[u.id].type === "equation"));
  const refIdx = list.findIndex((x) => x.type === "text" && x.text_level === 1 && /^references\b/i.test(x.text));
  if (refIdx >= 0) assert.ok(units.every((u) => u.id < refIdx), "units after References skipped");
  assert.deepEqual(J(units.map((u) => u.id)), J(units.map((u) => u.id)).sort((a, b) => a - b));
});

await test("buildUnits filters noise", () => {
  const units = T.buildUnits([
    { id: 0, type: "text", text: "12 34", page_idx: 0 },
    { id: 1, type: "text", text: "ab", page_idx: 0 },
    { id: 2, type: "image", image_caption: [], page_idx: 0 },
    { id: 3, type: "table", table_caption: ["Table 1:", "Results"], table_body: "<table/>", page_idx: 0 },
    { id: 4, type: "text", text: "Real sentence here.", page_idx: 0 },
    { id: 5, type: "text", text_level: 1, text: "参考文献", page_idx: 1 },
    { id: 6, type: "text", text: "After refs paragraph", page_idx: 1 },
  ]);
  assert.deepEqual(J(units.map((u) => [u.id, u.kind, u.text])), [[3, "caption", "Table 1: Results"], [4, "text", "Real sentence here."]]);
});

await test("protect/restore round trips", () => {
  const cases = [
    "Let $x^2$ be given, then \\alpha and \\mathbf{x} hold.",
    "As shown in [12] and [3, 5–7], see https://example.com/a_b?q=1 or mail me@lab.edu.",
    "Call `foo.bar()` and foo.bar() with run_all v1.2.3 in ./src/main.py.",
    "Cost is $5 and $7 total.",
  ];
  for (const c of cases) {
    const p = T.protect(c);
    assert.equal(T.restore(p.text, p.tokens), c);
  }
  const p = T.protect(cases[0]);
  assert.equal(p.tokens.map((t) => t.original).join("|"), "$x^2$|\\alpha|\\mathbf{x}");
  assert.match(p.tokens[0].token, /^<f1-[0-9a-z]{3}\/>$/);
  const q = T.protect(cases[1]);
  assert.deepEqual(J(q.tokens.map((t) => t.original)), ["[12]", "[3, 5–7]", "https://example.com/a_b?q=1", "me@lab.edu"]);
  const r = T.protect(cases[2]);
  assert.ok(r.tokens.some((t) => t.original === "`foo.bar()`") && r.tokens.some((t) => t.original === "foo.bar()"));
  assert.equal(T.protect(cases[3]).tokens.length, 0, "currency not math");
  // lost / reordered / lenient spacing
  assert.throws(() => T.restore("缺失", p.tokens), /placeholder lost/);
  const [a, b, c] = p.tokens.map((t) => t.token);
  assert.throws(() => T.restore(`${b}${a}${c}`, p.tokens), /reordered/);
  assert.equal(T.restore(`${a.replace("/>", " />")} ${b} ${c}`, p.tokens), "$x^2$ \\alpha \\mathbf{x}");
});

await test("planBatches respects page grouping and char budget", () => {
  const u = (id, page, n) => ({ id, page_idx: page, kind: "text", text: "a".repeat(n) });
  const units = [u(1, 0, 1000), u(2, 0, 1000), u(3, 0, 1000), u(4, 0, 1000), u(5, 1, 10), u(6, 1, 10), u(7, 2, 5000)];
  const b = T.planBatches(units, { maxChars: 3500 });
  assert.deepEqual(J(b.map((x) => x.map((y) => y.id))), [[1, 2, 3], [4], [5, 6], [7]]);
  for (const batch of b) assert.equal(new Set(batch.map((x) => x.page_idx)).size, 1);
});

const mk = (id, page, text) => ({ id, page_idx: page, kind: "text", text });
const SRC = (n) => `Paragraph number ${n} describes the transformer model with attention heads in some detail here.`;

await test("translateUnits: all scenarios (drop, lost placeholder, English, fences) with retries", async () => {
  calls = [];
  const units = [
    mk(1, 0, SRC(1)),
    mk(2, 0, SRC(2)),                                    // dropped on first pass
    mk(3, 0, `Value $x^2$ appears in the paragraph about attention and softmax scaling factors here.`), // lost placeholder first
    mk(4, 0, SRC(4)),                                    // English first
    mk(5, 1, SRC(5)),                                    // fenced JSON
    mk(6, 1, SRC(6)),                                    // always English -> failure
  ];
  const seen = new Map();
  llmImpl = async (args) => {
    const items = itemsOf(args);
    for (const it of items) seen.set(it.item_id, (seen.get(it.item_id) || 0) + 1);
    const out = items.filter((it) => !(it.item_id === "2" && items.length > 1));
    const body = reply(out, (it) => {
      if (it.item_id === "3" && seen.get("3") === 1) return "论文中的值出现在这里的注意力段落里";
      if (it.item_id === "4" && seen.get("4") === 1) return EN;
      if (it.item_id === "6") return EN;
      if (it.item_id === "3") return "值 " + it.source_text.match(/<f1-[0-9a-z]{3}\/>/)[0] + " 出现在关于注意力与缩放因子的段落中";
      return it.source_text.replace(/Paragraph number (\d+).*?(?=<|$)/, "第$1段的中文译文内容") + "";
    });
    if (items.some((it) => it.item_id === "5") && items.length > 1) return { content: "```json\n" + body + "\n```" };
    return { content: body };
  };
  const progress = [];
  const { translations, failures } = await T.translateUnits(units, { targetLang: "zh", onProgress: (p) => progress.push(p), concurrency: 2 });
  assert.equal(translations.get(1), "第1段的中文译文内容");
  assert.equal(translations.get(2), "第2段的中文译文内容");
  assert.match(translations.get(3), /\$x\^2\$/);
  assert.equal(translations.get(3), "值 $x^2$ 出现在关于注意力与缩放因子的段落中");
  assert.equal(translations.get(4), "第4段的中文译文内容");
  assert.equal(translations.get(5), "第5段的中文译文内容");
  assert.equal(translations.get(6), units[5].text, "kept original");
  assert.deepEqual(J(failures.map((f) => f.id)), [6]);
  assert.match(failures[0].reason, /english residue/);
  assert.ok(seen.get("6") === 3, "1 batch + 2 individual retries, got " + seen.get("6"));
  assert.ok(seen.get("2") === 2 && seen.get("4") === 2);
  const last = progress[progress.length - 1];
  assert.equal(last.done, 6); assert.equal(last.total, 6);
  const first = calls[0];
  assert.match(first.system, /科研文献翻译助手/);
  assert.match(first.system, /简体中文/);
  assert.match(first.system, /科技论文默认规则档/);
  assert.equal(first.responseFormat.type, "json_object");
  assert.equal(first.temperature, 0.2);
});

await test("context from same-page neighbours only; en target skips residue check", async () => {
  calls = [];
  llmImpl = async (args) => ({ content: reply(itemsOf(args), (it) => it.source_text) });
  const units = [mk(1, 0, SRC(1)), mk(2, 0, SRC(2)), mk(3, 1, SRC(3))];
  const { translations, failures } = await T.translateUnits(units, { targetLang: "en", concurrency: 1 });
  assert.equal(failures.length, 0);
  assert.equal(translations.size, 3);
  const it = itemsOf(calls[0]);
  assert.equal(it[0].context_before, undefined);
  assert.match(it[0].context_after, /Paragraph number 2/);
  const it3 = itemsOf(calls[1]);
  assert.equal(it3[0].context_before, undefined);
});

await test("request errors retry then record failure; protocol junk rejected", async () => {
  let n = 0;
  llmImpl = async () => { n++; throw new Error("HTTP 500 boom"); };
  const r = await T.translateUnits([mk(1, 0, SRC(1))], { targetLang: "zh", concurrency: 1 });
  assert.equal(n, 3);
  assert.match(r.failures[0].reason, /request failed/);
  llmImpl = async (args) => ({ content: reply(itemsOf(args), () => "```\n中文译文一些内容\n```") });
  const r2 = await T.translateUnits([mk(1, 0, SRC(1))], { targetLang: "zh", concurrency: 1 });
  assert.match(r2.failures[0].reason, /junk/);
});

await test("abort", async () => {
  const ac = new AbortController();
  llmImpl = async (args) => { ac.abort(); return { content: reply(itemsOf(args), () => "中文译文内容很多") }; };
  const units = [mk(1, 0, SRC(1)), mk(2, 1, SRC(2)), mk(3, 2, SRC(3))];
  await assert.rejects(T.translateUnits(units, { targetLang: "zh", signal: ac.signal, concurrency: 1 }), (e) => e.name === "AbortError");
  const pre = new AbortController(); pre.abort();
  await assert.rejects(T.translateUnits(units, { targetLang: "zh", signal: pre.signal }), (e) => e.name === "AbortError");
});

if (failed) { console.log(`${failed} test(s) failed`); process.exit(1); }
console.log("all translator tests passed");
