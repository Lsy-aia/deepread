// Tests for DeepRead.Guide. Run: node test/questions.test.mjs
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
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/guide.js"]) {
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

const G = ctx.DeepRead.Guide;

const data = [
  { pageIndex: 0, paragraphs: [
    { paragraphIndex: 0, paragraphType: "title", paragraphText: "Intro" },
    { paragraphIndex: 1, paragraphType: "text", paragraphText: "We study X." },
    { paragraphIndex: 2, paragraphType: "image", paragraphText: "Fig. 1: overview" },
    { paragraphIndex: 3, paragraphType: "equation", paragraphText: "x_{k} = \\alpha y" },
    { paragraphIndex: 4, paragraphType: "equation", paragraphText: "plain eq" },
  ] },
  { pageIndex: 2, paragraphs: [{ paragraphIndex: 1, paragraphType: "text", paragraphText: "Later." }] },
];
const keys = ["p_0_0", "p_0_1", "p_0_2", "p_0_3", "p_2_1"];
const blocks = keys.map((k) => ({ key: k, label: "x", summary: "s ".repeat(100) }));
const user = (a) => a.messages.at(-1).content;

await test("paperMarkdown", () => {
  const md = G.paperMarkdown(data, { title: "T" });
  assert.equal(md, [
    "# T", "## Intro", "[p. 1 ¶2] We study X.", "> Fig. 1: overview", "$$x_{k} = \\alpha y$$", "plain eq", "[p. 3 ¶2] Later.",
  ].join("\n\n"));
});

await test("agentPrompt with skills", () => {
  const p = G.agentPrompt({ workdir: "/w", pdfPath: "/a/b.pdf", skills: [{ name: "nature-paper-xray", path: "/s/x/SKILL.md" }, { name: "nature-paper-card", path: "/s/c/SKILL.md" }], targetLang: "en" });
  for (const s of ["/w", "/a/b.pdf", "/s/x/SKILL.md", "/s/c/SKILL.md", "paper.md", "xray.md", "paper-card.md", "DEEPREAD_DONE", "English", "[p. 3 ¶2]"]) assert.ok(p.includes(s), s);
  assert.ok(!p.includes("01 basic information"));
});

await test("agentPrompt without skills has built-in instructions", () => {
  const p = G.agentPrompt({ workdir: "/w", pdfPath: "/a/b.pdf", skills: [], targetLang: "zh" });
  for (const s of ["01 basic information", "16 research ideas", "load-bearing", "DEEPREAD_DONE", "xray.md", "paper-card.md"]) assert.ok(p.includes(s), s);
});

await test("writeWithApi: JSON reply, marker, config, clipping", async () => {
  handler = () => ({ content: JSON.stringify({ xray: " X ", card: "C" }) });
  const big = [{ pageIndex: 0, paragraphs: [{ paragraphIndex: 0, paragraphType: "text", paragraphText: "START" + "a".repeat(500) + "END" }] }];
  const out = await G.writeWithApi({ hierarchicalData: big, title: "T", targetLang: "en", config: { model: "m" }, skillsText: "S".repeat(20000), maxChars: 200 });
  assert.deepEqual(plain(out), { xray: "X", card: "C" });
  const a = requests[0];
  assert.deepEqual(plain(a.config), { model: "m" });
  const u = user(a);
  const paper = u.split("Paper (Markdown):\n")[1];
  assert.ok(paper.length <= 260 && paper.includes("# T") && paper.includes("END") && paper.includes("clipped"));
  assert.ok(u.includes("Skill guidance") && u.split("S").length - 1 <= 12100);
  assert.match(a.system, /in English/);
});

await test("writeWithApi: Markdown reply goes to xray", async () => {
  handler = () => ({ content: "# Just markdown\n\ntext" });
  const out = await G.writeWithApi({ hierarchicalData: data, title: "T" });
  assert.deepEqual(plain(out), { xray: "# Just markdown\n\ntext", card: "" });
});

await test("writeWithApi: abort", async () => {
  const ac = new AbortController();
  ac.abort();
  handler = () => ({ content: "{}" });
  await assert.rejects(G.writeWithApi({ hierarchicalData: data, signal: ac.signal }), (e) => e.name === "AbortError");
  assert.equal(requests.length, 0);
});

const raw = {
  type: "bogus",
  position: {
    claim: " C ",
    path: Array.from({ length: 9 }, (_, i) => ({ step: `s${i}`, text: i === 0 ? "see p. 3 ¶2 and [p. 1 ¶2]" : "t", basis: i === 1 ? "weird" : "source", keys: ["p_0_1", "p_0_1", "nope"] })),
    focus: ["a", "", " b "],
    order: [{ text: "x", minutes: "12", keys: "p_0_0" }],
    questions: Array.from({ length: 8 }, (_, i) => `q${i}`),
  },
  method: {
    components: [{ name: "n", verdict: "what", basis: "b", keys: keys }, { name: "m", verdict: "decorative" }],
    formulas: [{ latex: "x", symbols: [{ symbol: "x" }], example: "e" }],
  },
  evidence: {
    chain: [{ claim: "c", status: "?", keys: [] }],
    checks: [{ text: "c", effect: "zzz", state: "zzz" }],
    hedges: [{ quote: "q", strength: "zzz" }],
  },
  takeaway: { summary: "s", ideas: [{ title: "i" }] },
};

await test("normalize: enums, keys, caps, missing steps", () => {
  const g = plain(G.normalize(raw, keys));
  assert.equal(g.type, "other");
  assert.equal(g.position.claim, "C");
  assert.equal(g.position.path.length, 6);
  assert.deepEqual(g.position.path[0].keys, ["p_0_1", "p_2_1"]);
  assert.equal(g.position.path[1].basis, "pending");
  assert.deepEqual(g.position.focus, ["a", "b"]);
  assert.equal(g.position.questions.length, 5);
  assert.deepEqual(g.position.order[0], { text: "x", minutes: 12, keys: ["p_0_0"] });
  assert.equal(g.method.components[0].verdict, "pending");
  assert.equal(g.method.components[0].keys.length, 5);
  assert.equal(g.method.components[1].verdict, "decorative");
  assert.equal(g.evidence.chain[0].status, "pending");
  assert.equal(g.evidence.checks[0].effect, "wording");
  assert.equal(g.evidence.checks[0].state, "open");
  assert.equal(g.evidence.hedges[0].strength, "hedged");
  assert.deepEqual(g.skeleton, { moves: [], terms: [] });
  assert.deepEqual(g.takeaway.learned, []);
  const empty = plain(G.normalize(null, []));
  assert.deepEqual(empty.evidence.chain, []);
  assert.equal(empty.method.insight.core, "");
});

await test("normalize: max 6 keys per item", () => {
  const many = Array.from({ length: 10 }, (_, i) => `p_0_${i}`);
  const g = G.normalize({ method: { components: [{ name: "n", keys: many }] } }, many);
  assert.equal(g.method.components[0].keys.length, 6);
});

await test("structure: prompt, markers, blocks budget, result", async () => {
  handler = () => ({ content: JSON.stringify(raw) });
  const many = Array.from({ length: 600 }, (_, i) => ({ key: `p_1_${i}`, label: `p. 2 ¶${i + 1}`, summary: "z".repeat(300) }));
  const g = await G.structure({ markdown: { xray: "X".repeat(50000), card: "card [p. 1 ¶2]" }, blocks: [...blocks, ...many], paperContext: "CTX", targetLang: "en", config: { model: "m" } });
  const a = requests[0];
  const u = user(a);
  assert.match(u, /Guide source \(Markdown\):\n/);
  assert.match(u, /Paper blocks \(JSON\):\n\{/);
  assert.match(u, /Paper context:\nCTX/);
  assert.match(a.system, /in English/);
  assert.deepEqual(plain(a.responseFormat), { type: "json_object" });
  assert.deepEqual(plain(a.config), { model: "m" });
  const src = u.split("Guide source (Markdown):\n")[1].split("\n\nPaper blocks (JSON):")[0];
  assert.ok(src.length < 40000 + 40000 && src.length > 40000);
  const sent = JSON.parse(u.split("Paper blocks (JSON):\n")[1]).blocks;
  assert.ok(sent.length > 5 && sent.length < 605);
  assert.ok(JSON.stringify(sent).length <= 30000);
  assert.ok(sent.every((b) => b.summary.length <= 120));
  assert.equal(sent[0].key, "p_0_0");
  assert.equal(g.position.path.length, 6);
  assert.equal(g.method.components[0].verdict, "pending");
});

await test("structure: retries once, then fails; abort", async () => {
  let n = 0;
  handler = () => { n++; if (n === 1) throw new Error("boom"); return { content: JSON.stringify(raw) }; };
  const g = await G.structure({ markdown: { xray: "x", card: "" }, blocks });
  assert.equal(requests.length, 2);
  assert.equal(g.position.claim, "C");
  requests.length = 0;
  handler = () => ({ content: "not json" });
  await assert.rejects(G.structure({ markdown: { xray: "x", card: "" }, blocks }));
  assert.equal(requests.length, 2);
  requests.length = 0;
  const ac = new AbortController();
  handler = () => { ac.abort(); throw new Error("x"); };
  await assert.rejects(G.structure({ markdown: { xray: "x", card: "" }, blocks, signal: ac.signal }), (e) => e.name === "AbortError");
  assert.equal(requests.length, 1);
});

const card16 = Array.from({ length: 16 }, (_, i) => `## ${String(i + 1).padStart(2, "0")} Section ${i + 1}\n\nbody ${i + 1}`).join("\n\n");

await test("parseImported: JSON, card Markdown, xray Markdown", () => {
  const j = G.parseImported(JSON.stringify({ ...raw, markdown: { xray: "X", card: "C" } }), keys);
  assert.equal(j.guide.position.claim, "C");
  assert.deepEqual(plain(j.markdown), { xray: "X", card: "C" });
  const c = G.parseImported(card16, keys);
  assert.equal(c.guide, null);
  assert.equal(c.markdown.xray, "");
  assert.ok(c.markdown.card.includes("Section 16"));
  assert.equal(G.parseImported("# My Paper Card\n\nhi", keys).markdown.card !== "", true);
  assert.equal(G.parseImported("# 精读卡\n\nx", keys).markdown.card !== "", true);
  const x = G.parseImported("# Xray\n\n## 1 Intro\n\ntext", keys);
  assert.equal(x.markdown.card, "");
  assert.ok(x.markdown.xray.includes("Intro"));
});

await test("cardSections: zh, en and numbering styles", () => {
  const s = G.cardSections("intro\n\n## 01 基本信息\n\nA\nB\n\n### 02. One-sentence summary\n\nC\n\n## 2 研究问题\n\nD\n\n## 2024 Year\n\nz");
  assert.deepEqual(plain(s), [
    { number: "01", title: "基本信息", body: "A\nB" },
    { number: "02", title: "One-sentence summary", body: "C" },
    { number: "02", title: "研究问题", body: "D\n\n## 2024 Year\n\nz" },
  ]);
  assert.equal(G.cardSections(card16).length, 16);
});

await test("toNoteHTML escapes and has sections", () => {
  const guide = G.normalize({
    position: { claim: "claim <b>" },
    takeaway: { summary: "Sum & <script>", learned: ["l1"] },
    method: { components: [{ name: "N", verdict: "load-bearing", basis: "b" }] },
  }, []);
  const html = G.toNoteHTML(guide, { xray: "", card: "## 01 Info\n\n**bold** and `code` <i>\n\n- a\n- b" }, { title: "Ti<tle" });
  assert.ok(html.includes("<h1>Ti&lt;tle</h1>"));
  assert.ok(html.includes("Sum &amp; &lt;script&gt;"));
  assert.ok(!html.includes("<script>") && !html.includes("<i>"));
  assert.ok(html.includes("<strong>bold</strong>") && html.includes("<code>code</code>") && html.includes("<li>a</li>"));
  assert.ok(html.includes("<h3>01 Info</h3>"));
  for (const n of ["①", "②", "③", "④", "⑤"]) assert.ok(html.includes(n));
});

await test("notesForKey", () => {
  const guide = G.normalize({
    skeleton: { moves: [{ role: "claim", text: "M", keys: ["p_0_1"] }, { role: "background", text: "B", keys: ["p_0_1"] }] },
    method: { components: [{ name: "N", verdict: "decorative", basis: "why", keys: ["p_0_1"] }] },
    evidence: { chain: [{ claim: "CL", status: "partial", keys: ["p_0_1"] }], hedges: [{ quote: "likely", strength: "speculative", keys: ["p_0_1"] }] },
  }, keys);
  const n = plain(G.notesForKey(guide, "p_0_1"));
  assert.deepEqual(n.map((x) => x.kind), ["component", "hedge", "claim", "move"]);
  assert.equal(n[0].label, "装饰");
  assert.equal(n[1].text, "likely");
  assert.equal(n[3].label, "主张");
  assert.deepEqual(plain(G.notesForKey(guide, "p_9_9")), []);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
