// Tests for DeepRead.References. Run: node test/references.test.mjs
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
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/references.js"), "utf8"), ctx, { filename: "references.js" });
const R = ctx.DeepRead.References;
const plain = (x) => JSON.parse(JSON.stringify(x));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}

const B = [0, 0, 1, 1];
const T = (text, page = 0, extra = {}) => ({ type: "text", text, page_idx: page, bbox: B, ...extra });
const H = (text, page = 0) => T(text, page, { text_level: 1 });
const RT = (text, page = 5) => ({ type: "ref_text", text, page_idx: page, bbox: B });

const IEEE = [
  "[1] J. Ho, A. Jain, and P. Abbeel, “Denoising diffusion probabilistic models,” in NeurIPS, 2020.",
  "[2] Y. Song and S. Ermon, “Generative modeling by estimating gradients of the data distribution,” in NeurIPS, 2019. doi:10.5555/3454287.3455354.",
  "[18] A. Vaswani et al., “Attention is all you need,” arXiv preprint arXiv:1706.03762, 2017.",
];

test("ref_text numbered IEEE", () => {
  const refs = R.list([H("Intro"), T("body"), H("References", 5), ...IEEE.map((t) => RT(t))]);
  assert.equal(refs.length, 3);
  assert.deepEqual(plain(refs.map((r) => r.n)), [1, 2, 18]);
  assert.deepEqual(plain(refs.map((r) => r.id)), ["r1", "r2", "r18"]);
  assert.equal(refs[0].label, "[1]");
  assert.equal(refs[0].title, "Denoising diffusion probabilistic models");
  assert.equal(refs[0].firstAuthor, "Ho");
  assert.equal(refs[0].year, "2020");
  assert.ok(refs[0].text.startsWith("J. Ho"));
  assert.equal(refs[1].firstAuthor, "Song");
  assert.equal(refs[1].doi, "10.5555/3454287.3455354");
  assert.equal(refs[2].arxiv, "1706.03762");
  assert.equal(refs[2].firstAuthor, "Vaswani");
  assert.equal(refs[2].title, "Attention is all you need");
  assert.equal(refs[2].year, "2017");
});

test("ref_text dot-numbered", () => {
  const refs = R.list([RT("1. J. Ho, “Title A,” 2020."), RT("2. Y. Song, “Title B,” 2019.")]);
  assert.deepEqual(plain(refs.map((r) => r.n)), [1, 2]);
  assert.ok(refs[0].text.startsWith("J. Ho"));
});

test("numbered section from one concatenated text block", () => {
  const cl = [
    H("Method"), T("body [1]"),
    H("7 References", 6),
    T("[1] J. Ho, A. Jain, and P. Abbeel, “Denoising diffusion probabilistic models,” in NeurIPS, 2020. [2] Y. Song and S. Ermon, “Score matching,” in NeurIPS, 2019.", 6),
    T("[3] D. Kingma and J. Ba, “Adam: A method for stochastic optimization,” in ICLR, 2015.", 6),
    H("A. Proofs", 7), T("[9] not a reference", 7),
  ];
  const refs = R.list(cl);
  assert.deepEqual(plain(refs.map((r) => r.n)), [1, 2, 3]);
  assert.equal(refs[1].title, "Score matching");
  assert.equal(refs[2].firstAuthor, "Kingma");
});

test("dot-numbered concatenated block", () => {
  const cl = [H("REFERENCES"), T("1. J. Ho, “Title A,” in NeurIPS, 2020.\n2. Y. Song, “Title B,” in ICML, 2019.\n3. D. Kingma, “Title C,” 2015.")];
  const refs = R.list(cl);
  assert.deepEqual(plain(refs.map((r) => r.n)), [1, 2, 3]);
  assert.equal(refs[1].year, "2019");
});

test("author-year APA", () => {
  const cl = [H("References"),
    T("Ho, J., Jain, A., & Abbeel, P. (2020). Denoising diffusion probabilistic models. In NeurIPS. Song, Y., & Ermon, S. (2019). Generative modeling by estimating gradients. In NeurIPS. https://doi.org/10.1000/xyz123."),
    T("Ho, J. (2020a). Another thing. Journal of Stuff.")];
  const refs = R.list(cl);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].n, null);
  assert.equal(refs[0].title, "Denoising diffusion probabilistic models");
  assert.equal(refs[0].firstAuthor, "Ho");
  assert.equal(refs[0].year, "2020");
  assert.equal(refs[0].label, "Ho et al., 2020");
  assert.equal(refs[0].id, "r_ho2020");
  assert.equal(refs[1].title, "Generative modeling by estimating gradients");
  assert.equal(refs[1].doi, "10.1000/xyz123");
  assert.equal(refs[2].year, "2020a");
  assert.equal(refs[2].id, "r_ho2020a");
});

test("author-year NeurIPS style and id dedupe", () => {
  const cl = [H("References"),
    T("Jonathan Ho, Ajay Jain, and Pieter Abbeel. Denoising diffusion probabilistic models. In NeurIPS, 2020."),
    T("Jonathan Ho, Tim Salimans. Classifier-free guidance. arXiv:2207.12598, 2020."),
    T("Yang Song et al. Score-based generative modeling. In ICLR, 2021.")];
  const refs = R.list(cl);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].title, "Denoising diffusion probabilistic models");
  assert.equal(refs[0].firstAuthor, "Ho");
  assert.equal(refs[1].arxiv, "2207.12598");
  assert.equal(refs[1].title, "Classifier-free guidance");
  assert.equal(refs[1].id, "r_ho2020_2");
  assert.equal(refs[2].firstAuthor, "Song");
  assert.equal(refs[2].title, "Score-based generative modeling");
});

test("arXiv-only and no list", () => {
  const refs = R.list([RT("[5] K. He et al. arXiv:2111.06377.")]);
  assert.equal(refs[0].arxiv, "2111.06377");
  assert.equal(refs[0].year, "2021");
  assert.equal(refs[0].title, "");
  assert.deepEqual(plain(R.list([T("nothing")])), []);
});

const nums = (g) => g.items.map((i) => i.n);

test("citationsIn numeric", () => {
  const s = "As in [18] and [12, 15, 29], also [3–5], [3-5], [3]–[5], [3, 7–9].";
  const g = plain(R.citationsIn(s));
  assert.deepEqual(g.map((x) => x.raw), ["[18]", "[12, 15, 29]", "[3–5]", "[3-5]", "[3]–[5]", "[3, 7–9]"]);
  assert.deepEqual(g.map(nums), [[18], [12, 15, 29], [3, 4, 5], [3, 4, 5], [3, 4, 5], [3, 7, 8, 9]]);
  assert.equal(s.slice(g[0].start, g[0].end), "[18]");
  assert.equal(R.citationsIn("[1-100]").length, 1);
  assert.ok(nums(R.citationsIn("[1-100]")[0]).length <= 50);
});

test("citationsIn negatives", () => {
  for (const s of ["x in [0, 1] here", "values [0.5, 1.0]", "array [x] and [i, j]", "see Eq. (1) and (2)", "(2020)", "[]"])
    assert.deepEqual(plain(R.citationsIn(s)), [], s);
});

test("citationsIn author-year", () => {
  const s = "Prior work (Ho et al., 2020) and (Ho et al. 2020; Song and Ermon, 2019), Ho et al. (2020), (Ho & Abbeel, 2020a).";
  const g = plain(R.citationsIn(s));
  assert.deepEqual(g.map((x) => x.raw), ["(Ho et al., 2020)", "(Ho et al. 2020; Song and Ermon, 2019)", "Ho et al. (2020)", "(Ho & Abbeel, 2020a)"]);
  assert.deepEqual(g[0].items, [{ author: "Ho", year: "2020" }]);
  assert.deepEqual(g[1].items, [{ author: "Ho", year: "2020" }, { author: "Song", year: "2019" }]);
  assert.deepEqual(g[2].items, [{ author: "Ho", year: "2020" }]);
  assert.deepEqual(g[3].items, [{ author: "Ho", year: "2020a" }]);
  assert.deepEqual(plain(R.citationsIn("(see Figure 3 for details)")), []);
});

test("citationAt", () => {
  const s = "foo [12, 15, 29] bar (Ho et al., 2020) baz";
  const a = s.indexOf("[");
  assert.equal(R.citationAt(s, a - 1), null);
  assert.equal(R.citationAt(s, a + 16), null);
  let r = R.citationAt(s, a);
  assert.equal(r.group.raw, "[12, 15, 29]");
  assert.equal(r.item, null);
  r = R.citationAt(s, a + 1);
  assert.deepEqual(plain(r.item), { n: 12 });
  r = R.citationAt(s, a + 6);
  assert.deepEqual(plain(r.item), { n: 15 });
  r = R.citationAt(s, a + 4);
  assert.equal(r.item, null);
  r = R.citationAt(s, s.indexOf("Ho"));
  assert.deepEqual(plain(r.item), { author: "Ho", year: "2020" });
  assert.deepEqual(plain(R.citationAt("see [7].", 5).item), { n: 7 });
});

test("resolve", () => {
  const refs = R.list([RT("[1] J. Ho, “Title A,” 2020."), RT("[2] Y. Song, “Title B,” 2019.")]);
  assert.equal(R.resolve({ n: 2 }, refs).firstAuthor, "Song");
  assert.equal(R.resolve({ n: 9 }, refs), null);
  assert.equal(R.resolve({ author: "ho", year: "2020" }, refs).n, 1);
  assert.equal(R.resolve({ author: "Ho", year: "2019" }, refs), null);
  const ay = R.list([H("References"), T("Müller, A. (2020a). Title X. Venue One. Müller, A. (2020b). Title Z. Venue Two.")]);
  assert.equal(ay.length, 2);
  assert.equal(R.resolve({ author: "Muller", year: "2020b" }, ay).year, "2020b");
  assert.equal(R.resolve({ author: "Muller", year: "2020" }, ay).year, "2020a");
});

test("occurrences", () => {
  const cl = [
    H("Intro"),
    T("Diffusion [1] works; see [1, 2].", 0),
    { type: "list", text: "scores [2]", page_idx: 1, bbox: B },
    H("References", 5),
    RT("[1] J. Ho, “Title A,” 2020."), RT("[2] Y. Song, “Title B,” 2019. cites [1]"),
    H("Appendix", 6), T("late [2]", 6),
  ];
  const refs = R.list(cl);
  const occ = R.occurrences(cl, refs);
  assert.equal(occ.get("r1").length, 2);
  assert.equal(occ.get("r2").length, 3);
  assert.deepEqual(plain(occ.get("r1")[0]), { pageIndex: 0, blockIndex: 1, excerpt: "Diffusion [1] works; see [1, 2]." });
  assert.equal(occ.get("r2")[1].pageIndex, 1);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
