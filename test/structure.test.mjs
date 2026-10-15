// Tests for DeepRead.Structure. Run: node test/structure.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.DeepRead = {};
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/structure.js"), "utf8"), ctx, { filename: "structure.js" });
const S = ctx.DeepRead.Structure;
const plain = (x) => JSON.parse(JSON.stringify(x));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}

const H = (text, page, y) => ({ type: "text", text, text_level: 1, page_idx: page, bbox: [100, y, 500, y + 15] });
const P = (text, page, y) => ({ type: "text", text, page_idx: page, bbox: [100, y, 900, y + 40] });

function monotonic(secs) {
  for (let i = 0; i < secs.length; i++) {
    assert.ok(secs[i].end >= secs[i].start);
    if (i) { assert.ok(secs[i].start >= secs[i - 1].start); assert.equal(secs[i - 1].end, secs[i].start); }
  }
}

test("demo content list (Attention paper)", () => {
  const cl = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/demo/demo_content_list.json"), "utf8"));
  const secs = plain(S.sections(cl));
  assert.deepEqual(secs.map((s) => s.title), ["Abstract", "Introduction", "Background", "Model Architecture", "Why Self-Attention", "Training", "Results", "Conclusion"]);
  assert.deepEqual(secs.map((s) => s.number), [null, "1", "2", "3", "4", "5", "6", "7"]);
  assert.deepEqual(secs.map((s) => s.role), ["front", "intro", "background", "method", "method", "method", "experiment", "discussion"]);
  assert.equal(secs[3].label, "3 模型结构");
  assert.equal(secs[4].label, "4 Why Self-Attention");
  assert.equal(secs[0].start, 0.484);
  assert.equal(secs.at(-1).end, 15);
  monotonic(secs);
  assert.ok(!secs.some((s) => /Attention Is All/.test(s.title)));
});

const diffusion = [
  H("Diffusion Policy: Visuomotor Policy Learning via Action Diffusion", 0, 80),
  H("Abstract", 0, 300),
  H("I. I NTRODUCTION", 0, 600),
  P("Intro text", 0, 650),
  H("II. D IFFUSION P OLICY F ORMULATION", 1, 100),
  H("A. Denoising Diffusion Probabilistic Models", 1, 200),
  H("B) Closed-loop action", 1, 400),
  H("III. K EY D ESIGN", 2, 50),
  H("IV. E XPERIMENTS", 3, 500),
  H("A. Simulation", 3, 700),
  { type: "image", text: "", text_level: 1, image_caption: ["Fig. 1: x"], page_idx: 3, bbox: [0, 800, 100, 900] },
  H("Figure 4: Results overview", 4, 100),
  H("V. C ONCLUSION", 5, 100),
  H("R EFERENCES", 5, 600),
  H("APPENDIX", 7, 100),
];

test("roman numerals, small caps, lettered subsections, title", () => {
  const secs = plain(S.sections(diffusion));
  assert.deepEqual(secs.map((s) => s.title), ["Abstract", "INTRODUCTION", "DIFFUSION POLICY FORMULATION", "KEY DESIGN", "EXPERIMENTS", "CONCLUSION", "REFERENCES", "APPENDIX"]);
  assert.deepEqual(secs.map((s) => s.number), [null, "I", "II", "III", "IV", "V", null, null]);
  assert.deepEqual(secs.map((s) => s.role), ["front", "intro", "method", "method", "experiment", "discussion", "references", "appendix"]);
  assert.equal(secs[1].label, "I 引言");
  assert.equal(secs[2].label, "II DIFFUSION POLICY FORMULATION");
  assert.equal(secs.at(-1).end, 8);
  monotonic(secs);
});

test("subsections, captions and paper title are skipped", () => {
  const secs = S.sections([H("My Great Paper", 0, 50), H("1 Introduction", 0, 400), H("1.1 Motivation", 0, 600), H("Table 2: Foo", 1, 100), H("2 Method", 1, 300), H("B. Details", 1, 500)]);
  assert.deepEqual(plain(secs).map((s) => s.title), ["Introduction", "Method"]);
});

test("unknown unnumbered headings are skipped; unnumbered known names kept", () => {
  const secs = S.sections([H("Paper", 0, 10), H("Abstract", 0, 100), H("Related Work", 1, 100), H("Some Random Heading", 1, 300), H("Conclusions", 2, 100)]);
  assert.deepEqual(plain(secs).map((s) => [s.title, s.role]), [["Abstract", "front"], ["Related Work", "background"], ["Conclusions", "discussion"]]);
});

test("Chinese headings", () => {
  const secs = S.sections([H("一篇论文", 0, 10), H("摘要", 0, 100), H("1 引言", 0, 400), H("2 方法", 1, 100), H("3 实验", 2, 100), H("参考文献", 3, 100)]);
  assert.deepEqual(plain(secs).map((s) => s.role), ["front", "intro", "method", "experiment", "references"]);
});

test("sectionAt", () => {
  const secs = S.sections(diffusion);
  assert.equal(S.sectionAt(secs, 0, 100), -1);
  assert.equal(S.sectionAt(secs, 0, 300), 0);
  assert.equal(S.sectionAt(secs, 0, 700), 1);
  assert.equal(S.sectionAt(secs, 1, 99), 1);
  assert.equal(S.sectionAt(secs, 1, 100), 2);
  assert.equal(S.sectionAt(secs, 7, 900), 7);
  assert.equal(S.sectionAt(secs, 8, 0), -1);
  assert.equal(S.sectionAt([], 0, 0), -1);
});

test("empty / junk input", () => {
  assert.deepEqual(plain(S.sections(null)), []);
  assert.deepEqual(plain(S.sections([{}, null, { type: "text", text_level: 1 }])), []);
});

if (failures) { console.log(`${failures} test(s) failed`); process.exit(1); }
console.log("all structure tests passed");
