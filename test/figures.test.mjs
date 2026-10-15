// Tests for DeepRead.Figures. Run: node test/figures.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");
const requests = [];
let handler = null;
const ctx = { console, setTimeout, clearTimeout, Zotero: { debug() {}, locale: "zh-CN", Prefs: { get() {} } } };
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.DeepRead = {};
ctx.DeepRead.prefs = { language: () => "zh", llmConfig: () => ({ baseURL: "x", model: "m" }) };
ctx.DeepRead.LLM = { async complete(args) { requests.push(args); return handler(args, requests.length); } };
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/figures.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const F = ctx.DeepRead.Figures;
const plain = (x) => JSON.parse(JSON.stringify(x));

let failures = 0;
async function test(name, fn) {
  requests.length = 0;
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}

const img = (cap, page, bbox) => ({ type: "image", image_caption: cap ? [cap] : [], page_idx: page, bbox });
const tbl = (cap, page, bbox) => ({ type: "table", table_caption: cap ? [cap] : [], page_idx: page, bbox });
const txt = (text, page, bbox = [100, 500, 900, 540]) => ({ type: "text", text, page_idx: page, bbox });

await test("list: demo content list", () => {
  const cl = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/demo/demo_content_list.json"), "utf8"));
  const figs = plain(F.list(cl));
  assert.deepEqual(figs.map((f) => f.id), ["fig_1", "fig_2", "tab_1", "tab_2", "tab_3", "tab_4", "fig_3", "fig_4", "fig_5"]);
  assert.equal(figs[0].label, "图 1");
  assert.equal(figs[2].label, "表 1");
  assert.equal(figs[0].title, "The Transformer - model architecture");
  assert.ok(figs[2].title.length <= 41);
  assert.equal(figs[1].pageIndex, 3);
  const m = F.mentions(F.list(cl), cl);
  assert.ok(m.get("tab_1").length >= 1);
  assert.ok(m.get("fig_1").length >= 1);
});

await test("list: caption number formats, uncaptioned skipped", () => {
  const cl = [
    img("Fig. 3: Overview. More text.", 0, [0, 0, 500, 300]),
    img("Figure 4. Foo", 0, [0, 0, 1, 1]),
    img("Fig 5 | Bar", 1, [0, 0, 1, 1]),
    tbl("TABLE I Results", 1, [0, 0, 1, 1]),
    tbl("Tab. 2 - Ablation", 1, [0, 0, 1, 1]),
    img("", 2, [0, 0, 1, 1]),
    img("No number here", 2, [0, 0, 1, 1]),
  ];
  const figs = plain(F.list(cl));
  assert.deepEqual(figs.map((f) => [f.id, f.label, f.number]), [["fig_3", "图 3", "3"], ["fig_4", "图 4", "4"], ["fig_5", "图 5", "5"], ["tab_I", "表 I", "I"], ["tab_2", "表 2", "2"]]);
  assert.equal(figs[0].title, "Overview");
  assert.equal(figs[0].kind, "figure");
  assert.equal(figs[3].kind, "table");
  assert.equal(figs[3].title, "Results");
});

await test("list: caption in separate text block", () => {
  const cl = [
    img("", 0, [100, 100, 900, 400]),
    txt("Fig. 2: A pipeline.", 0, [100, 420, 900, 440]),
    img("", 1, [100, 300, 900, 600]),
    txt("Table 3: Far away caption", 1, [100, 900, 900, 920]),
    tbl("", 2, [100, 300, 900, 600]),
    txt("Table 1: Above the table", 2, [100, 250, 900, 280]),
  ];
  const figs = plain(F.list(cl));
  assert.deepEqual(figs.map((f) => f.id), ["fig_2", "tab_1"]);
  assert.equal(figs[0].caption, "Fig. 2: A pipeline.");
  const m = F.mentions(F.list(cl), cl);
  assert.equal(m.get("fig_2").length, 0); // the caption block is not a mention
});

await test("mentions: formats and panels", () => {
  const cl = [
    img("Fig. 3: A", 0, [0, 0, 1, 1]),
    img("Figure 4: B", 0, [0, 0, 1, 1]),
    tbl("Table I: C", 0, [0, 0, 1, 1]),
    tbl("Table 2: D", 0, [0, 0, 1, 1]),
    txt("As shown in Figure 3(b), the loss drops. See also Fig 3 (a).", 1),
    txt("Figs. 3 and 4 compare the setups; Fig. 4c is zoomed.", 1),
    txt("Table I lists results and Tab. 2 the ablation.", 2),
    txt("Fig. 3: duplicate caption text must be ignored", 2),
    { type: "text", text: "Introduction Fig. 3", text_level: 1, page_idx: 2, bbox: [0, 0, 1, 1] },
    txt("Nothing about figures here, tablet Figure skip.", 3),
  ];
  const figs = F.list(cl);
  const m = F.mentions(figs, cl);
  const f3 = plain(m.get("fig_3"));
  assert.deepEqual(f3.map((x) => x.panel), ["b", "a", null]);
  assert.equal(f3[0].pageIndex, 1);
  assert.equal(f3[0].blockId, 4);
  assert.match(f3[0].excerpt, /Figure 3\(b\)/);
  assert.ok(f3[0].excerpt.length <= 175);
  const f4 = plain(m.get("fig_4"));
  assert.deepEqual(f4.map((x) => x.panel), [null, "c"].slice(0, f4.length));
  assert.ok(f4.length >= 1);
  assert.equal(m.get("tab_I").length, 1);
  assert.equal(m.get("tab_2").length, 1);
});

const figsFor = (n) => Array.from({ length: n }, (_, i) => ({ id: `fig_${i + 1}`, kind: "figure", label: `图 ${i + 1}`, number: String(i + 1), caption: `Fig. ${i + 1}: cap ${i + 1}` }));
const reply = (user) => {
  const m = /Figures to explain \(JSON\):\n(\{.*\})/.exec(user);
  const figs = JSON.parse(m[1]).figures;
  return JSON.stringify({ figures: figs.map((f) => ({ id: f.id, title: `T ${f.id}`, steps: [{ text: "s1", panel: null }, { text: "s2", panel: "b" }] })) });
};

await test("explain: batches of 6, parsing, prompt shape", async () => {
  handler = (args) => ({ content: "```json\n" + reply(args.messages.at(-1).content) + "\n```" });
  const progress = [];
  const mentions = new Map([["fig_1", [{ pageIndex: 1, blockId: 3, panel: null, excerpt: "see Fig. 1 here" }]]]);
  const out = await F.explain(figsFor(13), { targetLang: "en", mentions, paperContext: "Title: T", onProgress: (p) => progress.push(p), config: { baseURL: "x", model: "m" } });
  assert.equal(requests.length, 3);
  assert.equal(out.size, 13);
  assert.deepEqual(plain(out.get("fig_2")), { title: "T fig_2", steps: [{ text: "s1", panel: null }, { text: "s2", panel: "b" }] });
  assert.equal(requests[0].responseFormat.type, "json_object");
  assert.equal(requests[0].temperature, 0.3);
  assert.match(requests[0].system, /English/);
  const user = requests[0].messages.at(-1).content;
  assert.match(user, /^Figures to explain \(JSON\):$/m);
  assert.match(user, /see Fig\. 1 here/);
  assert.equal(progress.at(-1).done, 13);
});

await test("explain: lenient parsing (think, bare array) and zh fallback", async () => {
  handler = (args) => ({ content: "<think>hmm</think>" + JSON.stringify(JSON.parse(reply(args.messages.at(-1).content)).figures) });
  const out = await F.explain(figsFor(2), { targetLang: "xx" });
  assert.equal(out.size, 2);
  assert.match(requests[0].system, /Simplified Chinese/);
});

await test("explain: retry once, then omit; ignores unknown ids", async () => {
  handler = (args, n) => (n === 1 ? { content: "not json" } : { content: reply(args.messages.at(-1).content).replace("fig_1", "zzz") });
  let out = await F.explain(figsFor(2), {});
  assert.equal(requests.length, 2);
  assert.deepEqual([...out.keys()], ["fig_2"]);
  requests.length = 0;
  handler = () => { throw new Error("500 boom"); };
  out = await F.explain(figsFor(2), {});
  assert.equal(requests.length, 2);
  assert.equal(out.size, 0);
});

await test("explain: abort", async () => {
  const ac = new AbortController();
  handler = () => { ac.abort(); const e = new Error("x"); e.name = "AbortError"; throw e; };
  await assert.rejects(F.explain(figsFor(2), { signal: ac.signal }), { name: "AbortError" });
  const ac2 = new AbortController();
  ac2.abort();
  await assert.rejects(F.explain(figsFor(2), { signal: ac2.signal }), { name: "AbortError" });
});

if (failures) { console.log(`${failures} test(s) failed`); process.exit(1); }
console.log("all figures tests passed");
