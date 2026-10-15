// Tests for DeepRead.Glossary. Run: node test/glossary.test.mjs
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
ctx.DeepRead.prefs = { language: () => "zh", llmConfig: () => ({ baseURL: "x", model: "m", concurrency: 8 }) };
ctx.DeepRead.LLM = {
  async complete(args) {
    requests.push(args);
    return handler(args, requests.length);
  },
};
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/glossary.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects from the vm realm have a foreign prototype

let failures = 0;
async function test(name, fn) {
  requests.length = 0;
  try {
    await fn();
    console.log(`PASS ${name}`);
  }
  catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${e.stack || e}`);
  }
}

const G = ctx.DeepRead.Glossary;

const blk = (i, extra = {}) => ({ key: `p_0_${i}`, label: `p. 1 ¶${i}`, summary: `sum ${i}`, explanation: `exp ${i}`, role: "method", text: `text ${i}`, ...extra });
const blocks = [0, 1, 2].map((i) => blk(i));

const reply = {
  symbols: [
    { symbol: "\\epsilon_\\theta", forms: ["εθ", "ε_θ", "epsilon_theta", "εθ", " "], meaning: "噪声预测网络", key: "p_0_1" },
    { symbol: "x", forms: [], meaning: "数据", key: "nope" },
    { symbol: "z", forms: [], meaning: "" },
    { symbol: "", meaning: "empty" },
    "junk",
  ],
  terms: [
    { term: " self-attention ", aliases: ["intra-attention", "Self-Attention", "intra-attention"], definition: "自注意力", key: "p_0_0" },
    { term: "DDPM", aliases: [], definition: "扩散模型", key: "p_0_2" },
    { term: "empty", definition: "" },
  ],
};

await test("build: prompt, marker, language, request options", async () => {
  handler = () => ({ content: JSON.stringify(reply) });
  await G.build({ blocks, paperContext: "CTX", targetLang: "en" });
  const a = requests[0];
  const user = a.messages.at(-1).content;
  assert.match(user, /Paper blocks for the glossary \(JSON\):\n\{/);
  assert.match(user, /Paper context:\nCTX/);
  assert.match(a.system, /in English/);
  assert.deepEqual(plain(a.responseFormat), { type: "json_object" });
  assert.equal(JSON.parse(user.split("(JSON):\n")[1]).blocks.length, 3);
});

await test("budget: tail dropped, text only without summary/explanation", async () => {
  handler = () => ({ content: JSON.stringify(reply) });
  const many = [blk(0, { summary: "", explanation: "", text: "t".repeat(900) }), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => blk(i))];
  await G.build({ blocks: many, maxChars: 1000 });
  const items = JSON.parse(requests[0].messages.at(-1).content.split("(JSON):\n")[1]).blocks;
  assert.ok(items.length > 1 && items.length < 9);
  assert.equal(items[0].text.length, 600);
  assert.ok(items.slice(1).every((b) => !("text" in b)));
});

await test("build: normalization, ids, key validation, dedupe", async () => {
  handler = () => ({ content: "<think>x</think>```json\n" + JSON.stringify(reply) + "\n```" });
  const g = plain(await G.build({ blocks }));
  assert.deepEqual(g.symbols, [
    { id: "s1", symbol: "\\epsilon_\\theta", forms: ["εθ", "ε_θ", "epsilon_theta"], meaning: "噪声预测网络", key: "p_0_1" },
    { id: "s2", symbol: "x", forms: [], meaning: "数据", key: "" },
  ]);
  assert.deepEqual(g.terms, [
    { id: "t1", term: "self-attention", aliases: ["intra-attention"], definition: "自注意力", key: "p_0_0" },
    { id: "t2", term: "DDPM", aliases: [], definition: "扩散模型", key: "p_0_2" },
  ]);
});

await test("build: retry once, abort, garbage", async () => {
  handler = (a, n) => { if (n === 1) throw new Error("boom"); return { content: JSON.stringify(reply) }; };
  assert.equal((await G.build({ blocks })).symbols.length, 2);
  assert.equal(requests.length, 2);
  requests.length = 0;
  handler = () => { const e = new Error("x"); e.name = "AbortError"; throw e; };
  await assert.rejects(() => G.build({ blocks }), (e) => e.name === "AbortError");
  assert.equal(requests.length, 1);
  handler = () => ({ content: "nope" });
  assert.deepEqual(plain(await G.build({ blocks })), { symbols: [], terms: [] });
});

const gl = G._parse(JSON.stringify({
  symbols: [
    { symbol: "\\epsilon_\\theta", forms: ["εθ", "ε_θ", "epsilon_theta"], meaning: "noise net", key: "" },
    { symbol: "\\epsilon", forms: ["ε"], meaning: "noise", key: "" },
    { symbol: "x", forms: ["x"], meaning: "data", key: "" },
    { symbol: "x_k", forms: ["xk"], meaning: "data at step k", key: "" },
    { symbol: "T_a", forms: [], meaning: "ambient", key: "" },
    { symbol: "a", forms: ["a"], meaning: "scalar", key: "" },
    { symbol: "d_k", forms: ["dk"], meaning: "key dim", key: "" },
    { symbol: "\\alpha_t", forms: [], meaning: "schedule", key: "" },
  ],
  terms: [],
}), []);
const sym = (t) => G.matchSymbol(t, gl)?.symbol ?? null;

await test("matchSymbol: positives", () => {
  assert.equal(sym("εθ"), "\\epsilon_\\theta");
  assert.equal(sym("εθ(xk,k)"), "\\epsilon_\\theta"); // longest form wins over ε
  assert.equal(sym("ε_θ"), "\\epsilon_\\theta");
  assert.equal(sym("epsilon_theta"), "\\epsilon_\\theta");
  assert.equal(sym("ε"), "\\epsilon");
  assert.equal(sym("ε,"), "\\epsilon");
  assert.equal(sym("Ta"), "T_a");
  assert.equal(sym("dk"), "d_k");
  assert.equal(sym("d_k)"), "d_k");
  assert.equal(sym("αt"), "\\alpha_t"); // LaTeX-only symbol, form derived from the LaTeX
  assert.equal(sym("α_t"), "\\alpha_t");
  assert.equal(sym("ϵ"), "\\epsilon"); // lunate variant folds to ε
});

await test("matchSymbol: negatives and single Latin letters", () => {
  assert.equal(sym("x"), "x");
  assert.equal(sym("xk"), "x_k"); // not "x"
  assert.equal(sym("x,"), "x");
  assert.equal(sym("xy"), null);
  assert.equal(sym("xk2"), null);
  assert.equal(sym("εx"), null); // ε followed by a letter is not ε(...)
  assert.equal(sym("a"), null); // English article, never a symbol
  assert.equal(sym("A"), null);
  assert.equal(sym("data"), null);
  assert.equal(sym("Tab"), null);
  assert.equal(sym(""), null);
  assert.equal(G.matchSymbol("x", { symbols: [], terms: [] }), null);
  assert.equal(G.matchSymbol("x", null), null);
});

const tg = G._parse(JSON.stringify({
  symbols: [],
  terms: [
    { term: "self-attention", aliases: ["intra-attention"], definition: "d1", key: "" },
    { term: "attention", aliases: [], definition: "d2", key: "" },
    { term: "Denoising Diffusion Probabilistic Model", aliases: ["DDPM"], definition: "d3", key: "" },
    { term: "Transformer", aliases: [], definition: "d4", key: "" },
  ],
}), []);
const at = (text, sub, nth = 0) => {
  let i = -1;
  for (let n = 0; n <= nth; n++) i = text.indexOf(sub, i + 1);
  const r = G.termAt(text, i, tg);
  return r && { id: r.entry.id, text: text.slice(r.start, r.end) };
};

await test("termAt: longest, multi-word, alias, case, hyphen", () => {
  const t = "We use Self-Attention and attention; DDPM and ddpm; the denoising diffusion probabilistic models; self attention; Transformers.";
  assert.deepEqual(at(t, "Attention"), { id: "t1", text: "Self-Attention" }); // longest covers the offset
  assert.deepEqual(at(t, "Self"), { id: "t1", text: "Self-Attention" });
  assert.deepEqual(at(t, "attention;"), { id: "t2", text: "attention" });
  assert.deepEqual(at(t, "DDPM"), { id: "t3", text: "DDPM" });
  assert.equal(at(t, "ddpm"), null); // abbreviations are case-sensitive
  assert.deepEqual(at(t, "diffusion"), { id: "t3", text: "denoising diffusion probabilistic models" });
  assert.deepEqual(at(t, "self attention", 0), { id: "t1", text: "self attention" });
  assert.deepEqual(at(t, "Transformers"), { id: "t4", text: "Transformers" });
  assert.deepEqual(at("an intra-\nattention layer", "intra"), { id: "t1", text: "intra-\nattention" });
});

await test("termAt: whole word and offsets", () => {
  assert.equal(at("multiattention heads", "attention"), null);
  assert.equal(at("attentions", "attentions").id, "t2");
  assert.equal(at("attentional", "attentional"), null);
  assert.equal(at("the attention here", "the"), null);
  assert.equal(G.termAt("", 0, tg), null);
  assert.equal(G.termAt("attention", 99, tg), null);
  assert.equal(G.termAt("attention", 0, { symbols: [], terms: [] }), null);
});

await test("occurrences: symbols and terms", () => {
  const bs = [
    { key: "a", text: "We predict εθ(xk,k) at each step." },
    { key: "b", text: "The scores xk are large; a is a scalar." },
    { key: "c", text: "Self-Attention, also called intra-attention, is used." },
    { key: "d", text: "d_k is the key dimension, so dk grows." },
    { key: "e", text: "" },
    { key: "f", text: "multi-head attention and DDPM." },
  ];
  const find = (arr, pred) => arr.find(pred);
  const eps = find(gl.symbols, (s) => s.symbol === "\\epsilon_\\theta");
  assert.deepEqual(plain(G.occurrences(eps, bs)), ["a"]);
  assert.deepEqual(plain(G.occurrences(find(gl.symbols, (s) => s.symbol === "x"), bs)), []); // "xk" is not "x"
  assert.deepEqual(plain(G.occurrences(find(gl.symbols, (s) => s.symbol === "x_k"), bs)), ["a", "b"]);
  assert.deepEqual(plain(G.occurrences(find(gl.symbols, (s) => s.symbol === "d_k"), bs)), ["d"]);
  assert.deepEqual(plain(G.occurrences(find(gl.symbols, (s) => s.symbol === "a"), bs)), []);
  assert.deepEqual(plain(G.occurrences(tg.terms[0], bs)), ["c"]);
  assert.deepEqual(plain(G.occurrences(tg.terms[1], bs)), ["c", "f"]);
  assert.deepEqual(plain(G.occurrences(tg.terms[2], bs)), ["f"]);
  assert.deepEqual(plain(G.occurrences(null, bs)), []);
});

if (failures) {
  console.log(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all glossary tests passed");
