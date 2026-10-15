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

const demoPath = path.join(root, "test/fixtures/demo/demo_content_list.json");
if (!fs.existsSync(demoPath)) console.log("SKIP list: demo content list (test/fixtures/demo not present; run python3 test/build-fixture.py)");
else await test("list: demo content list", () => {
  const cl = JSON.parse(fs.readFileSync(demoPath, "utf8"));
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
  // The far-away "Table 3" block is not attached to the image but is kept as a caption-only entry.
  assert.deepEqual(figs.map((f) => f.id), ["fig_2", "tab_3", "tab_1"]);
  assert.equal(figs[1].captionOnly, true);
  assert.equal(figs[0].caption, "Fig. 2: A pipeline.");
  const m = F.mentions(F.list(cl), cl);
  assert.equal(m.get("fig_2").length, 0); // the caption block is not a mention
});

// ---- new MinerU (chart type, multi-part figures) ----
const vis = (type, capKey, caps, page, bbox) => ({ type, [capKey]: caps, page_idx: page, bbox });
const im = (caps, page, bbox) => vis("image", "image_caption", caps, page, bbox);
const ch = (caps, page, bbox) => vis("chart", "chart_caption", caps, page, bbox);
const tb = (caps, page, bbox) => vis("table", "table_caption", caps, page, bbox);
const dpItems = () => [
  im([], 0, [107, 217, 901, 369]),
  ch([], 0, [312, 220, 593, 369]),
  ch(["Fig. 1: Policy Representations. a) Explicit policy."], 0, [710, 219, 900, 369]),
  txt("Prior work attempts to address this challenge (Fig 1 a) - using mixtures of Gaussians.", 0, [73, 856, 493, 917]),
  im(["Fig. 2: Realworld Benchmarks."], 1, [511, 65, 916, 314]),
  im(["Fig. 3: Diffusion Policy Overview."], 2, [78, 66, 919, 243]),
  im([], 3, [514, 464, 602, 531]),
  im(["Diffusion Policy", "LSTM-GMM"], 3, [617, 460, 705, 534]),
  im(["BET"], 3, [715, 459, 818, 539]),
  im(["IBC", "Fig. 4: Multimodal behavior. At the given state."], 3, [825, 459, 906, 536]),
  ch(["Fig. 5: Velocity v.s. Position Control."], 4, [109, 114, 455, 277]),
  ch(["Fig. 6: Diffusion Policy Ablation Study."], 4, [509, 66, 918, 229]),
  im([], 5, [207, 61, 870, 167]),
  tb([], 5, [89, 167, 906, 268]),
  tb(["TABLE I: Behavior Cloning Benchmark (State Policy).", "TABLE II: Behavior Cloning Benchmark (Visual Policy)."], 5, [86, 333, 903, 415]),
  ch(["Fig. 7: Training Stability."], 5, [78, 468, 488, 625]),
  tb(["TABLE III: Tasks Summary."], 5, [506, 468, 919, 710]),
  im(["Block Push"], 6, [96, 64, 285, 181]),
  im(["Kitchen"], 6, [287, 65, 470, 181]),
  tb(["TABLE IV: Multi-Stage Tasks (State Observation)."], 6, [84, 199, 477, 292]),
  im([], 7, [96, 65, 470, 260]),
  tb(["TABLE V: Realworld Push-T Experiment."], 7, [78, 267, 483, 335]),
  im(["Fig. 8: Realworld Push-T Comparisons."], 8, [78, 71, 918, 373]),
  im(["Fig. 9: Robustness Test for Diffusion Policy."], 8, [76, 446, 491, 630]),
  im([], 8, [526, 448, 898, 619]),
  tb(["Fig. 10: 6DoF Mug Flipping Task."], 8, [519, 626, 901, 667]),
  im([], 9, [76, 65, 490, 234]),
  tb(["Fig. 11: Realworld Sauce Manipulation."], 9, [112, 239, 454, 320]),
  ch(["Fig. 12: Observation Horizon Ablation Study."], 13, [509, 68, 916, 212]),
  ch([], 13, [509, 284, 728, 445]),
  ch(["# Training Demo Episodes\nLSTM-GMM", "Fig. 13: Data Efficiency Ablation Study."], 13, [735, 284, 915, 424]),
  tb(["TABLE VI: Hyperparameters for CNN-based Diffusion Policy."], 14, [78, 66, 918, 234]),
  tb(["TABLE VII: Hyperparameters for Transformer-based Diffusion Policy."], 14, [81, 319, 910, 453]),
];

await test("list: Diffusion Policy sample (chart, multi-part figures)", () => {
  const figs = plain(F.list(dpItems()));
  const by = Object.fromEntries(figs.map((f) => [f.id, f]));
  const ids = figs.map((f) => f.id);
  for (let i = 1; i <= 13; i++) assert.ok(by[`fig_${i}`], `fig_${i}`);
  for (const n of ["I", "III", "IV", "V", "VI", "VII"]) assert.ok(by[`tab_${n}`], `tab_${n}`);
  assert.equal(ids.length, 19);
  assert.deepEqual(by.fig_1.bbox, [107, 217, 901, 369]);
  assert.deepEqual(by.fig_4.bbox, [514, 459, 906, 539]);
  assert.deepEqual(by.fig_13.bbox, [509, 284, 915, 445]);
  assert.equal(by.fig_10.kind, "figure");
  assert.deepEqual(by.fig_10.bbox, [519, 448, 901, 667]);
  assert.match(by.fig_4.caption, /^Fig\. 4:/);
  assert.equal(by.fig_13.caption.startsWith("Fig. 13:"), true);
  assert.equal(by.fig_9.captionOnly, undefined);
  // page 5 uncaptioned image+table (top) are dropped, not merged into TABLE I
  assert.deepEqual(by.tab_I.bbox, [86, 333, 903, 415]);
  const order = figs.map((f) => [f.pageIndex, f.bbox[1], f.bbox[0]]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
});

await test("list: caption not first element, multi-line entry, chart type", () => {
  const figs = plain(F.list([
    ch(["# Training\nLSTM-GMM\nFig. 13: Data efficiency.", "More detail."], 0, [100, 100, 500, 300]),
    im(["IBC", "Figure 2. Foo"], 1, [100, 100, 500, 300]),
    { type: "figure", img_caption: "Fig. 7: String caption", page_idx: 2, bbox: [0, 0, 100, 100] },
    { type: "chart", caption: ["Table 9 | Odd place"], page_idx: 3, bbox: [0, 0, 100, 100] },
  ]));
  assert.deepEqual(figs.map((f) => f.id), ["fig_13", "fig_2", "fig_7", "tab_9"]);
  assert.equal(figs[0].caption, "Fig. 13: Data efficiency. More detail.");
  assert.equal(figs[0].title, "Data efficiency");
  assert.equal(figs[1].caption, "Figure 2. Foo");
  assert.equal(figs[3].kind, "table");
});

await test("list: uncaptioned parts merge only when close and never join two captioned items", () => {
  const figs = plain(F.list([
    im(["Fig. 1: A"], 0, [100, 100, 300, 300]),
    im(["Fig. 2: B"], 0, [340, 100, 500, 300]),
    im([], 0, [315, 100, 330, 300]), // 15 from Fig. 1 on the right? 15 vs 10 -> nearer to Fig. 2 (gap 10)
    im([], 0, [100, 320, 300, 400]), // below Fig. 1, chained
    im([], 0, [100, 420, 300, 500]), // chained via previous part
    im([], 1, [100, 100, 300, 300]), // other page: not merged
  ]));
  const by = Object.fromEntries(figs.map((f) => [f.id, f]));
  assert.deepEqual(by.fig_1.bbox, [100, 100, 300, 500]);
  assert.deepEqual(by.fig_2.bbox, [315, 100, 500, 300]);
  assert.equal(figs.length, 2);
});

await test("list: caption-only text block, no duplicate when a visual exists", () => {
  const cl = [
    im(["Fig. 1: Real figure"], 0, [100, 100, 900, 300]),
    txt("Fig. 1: Real figure", 0, [100, 900, 900, 920]),
    txt("Fig. 9: Only text caption.", 1, [100, 400, 900, 430]),
    txt("Figure 3 shows the results", 1, [100, 500, 900, 530]),
  ];
  const figs = plain(F.list(cl));
  assert.deepEqual(figs.map((f) => f.id), ["fig_1", "fig_9"]);
  assert.equal(figs[0].captionOnly, undefined);
  assert.equal(figs[1].captionOnly, true);
  assert.deepEqual(figs[1].bbox, [100, 400, 900, 430]);
});

await test("list: uncaptioned image far from everything gets no figure; cluster uses union for text caption", () => {
  assert.deepEqual(plain(F.list([
    im(["Fig. 1: A"], 0, [100, 100, 300, 200]),
    im([], 0, [100, 600, 300, 700]),
    txt("Body text far away.", 0, [100, 900, 900, 930]),
  ])).map((f) => f.id), ["fig_1"]);
  const figs = plain(F.list([
    im([], 0, [100, 100, 300, 200]),
    im([], 0, [310, 100, 500, 200]),
    txt("Fig. 6: Caption under the pair.", 0, [100, 250, 900, 270]),
  ]));
  assert.equal(figs.length, 1);
  assert.deepEqual(figs[0].bbox, [100, 100, 500, 200]);
  assert.equal(figs[0].captionOnly, undefined);
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
