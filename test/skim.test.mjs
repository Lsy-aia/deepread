// Tests for DeepRead.Skim. Run: node test/skim.test.mjs
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
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/skim.js"), "utf8"), ctx, { filename: "skim.js" });
const S = ctx.DeepRead.Skim;

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}

const long = Array(40).fill("word").join(" ");
const para = (i, o = {}) => ({ paragraphIndex: i, paragraphType: "text", paragraphText: long, paragraphSummary: "short summary here", points: [], ...o });
const pt = (id, importance_level) => ({ id, summary: id, importance_level });
const tierOf = (p, role = "") => S.tiers([{ pageIndex: 0, paragraphs: [p] }], { role: () => role }).tier.get("p_0_0");

test("role table without importance", () => {
  const exp = { contribution: "key", result: "key", gap: "normal", limitation: "normal", method: "normal", background: "minor", prior: "minor", "": "normal" };
  for (const [role, t] of Object.entries(exp)) assert.equal(tierOf(para(0), role), t, role);
});
test("importance bonus", () => {
  assert.equal(tierOf(para(0, { points: [pt("a", 3)] }), "gap"), "key");
  assert.equal(tierOf(para(0, { points: [pt("a", 2)] }), "gap"), "key");
  assert.equal(tierOf(para(0, { points: [pt("a", 3)] }), "method"), "key");
  assert.equal(tierOf(para(0, { points: [pt("a", 2)] }), "method"), "normal");
  assert.equal(tierOf(para(0, { points: [pt("a", 3)] }), "background"), "normal");
  assert.equal(tierOf(para(0, { points: [{ id: "a" }] }), "background"), "minor");
});
test("short paragraph cannot be key", () => {
  const P2 = [pt("a", 3)];
  assert.equal(tierOf(para(0, { paragraphText: "We win.", points: P2 }), "result"), "normal");
  assert.equal(tierOf(para(0, { paragraphText: "我们的方法很好。", points: P2 }), "result"), "normal");
  assert.equal(tierOf(para(0, { paragraphText: "我们".repeat(40), points: P2 }), "result"), "key");
});
test("non-text types get no tier", () => {
  for (const type of ["title", "equation", "image", "table"]) {
    const r = S.tiers([{ pageIndex: 0, paragraphs: [para(0, { paragraphType: type, points: [pt("a", 3)] })] }], { role: () => "result" });
    assert.equal(r.tier.size, 0, type);
  }
  assert.equal(tierOf(para(0, { paragraphType: "text_with_equation", points: [pt("a", 3)] }), "result"), "key");
  assert.equal(tierOf(para(0, { paragraphType: "list", points: [pt("a", 3)] }), "result"), "key");
});
test("references and acknowledgements are minor", () => {
  const kp = (i) => para(i, { points: [pt("a", 3)] });
  const title = (i, t) => para(i, { paragraphType: "title", paragraphText: t });
  const data = [
    { pageIndex: 0, paragraphs: [title(0, "5 Conclusion"), kp(1), title(2, "Acknowledgements"), kp(3), title(4, "6. References"), kp(5)] },
    { pageIndex: 1, paragraphs: [kp(0), title(1, "Appendix A"), kp(2)] },
  ];
  const { tier } = S.tiers(data, { role: () => "result" });
  assert.equal(tier.get("p_0_1"), "key");
  assert.equal(tier.get("p_0_3"), "minor");
  assert.equal(tier.get("p_0_5"), "minor");
  assert.equal(tier.get("p_1_0"), "minor");
  assert.equal(tier.get("p_1_2"), "key");
  const zh = S.tiers([{ pageIndex: 0, paragraphs: [title(0, "参考文献"), kp(1)] }], { role: () => "result" });
  assert.equal(zh.tier.get("p_0_1"), "minor");
});
test("keyPoints with fallback", () => {
  const p = para(0, { points: [pt("a", 1), pt("b", 3), pt("c", 2)] });
  const q = para(1, { points: [pt("d", 3), pt("e", 1)] });
  const n = para(2, { points: [pt("f", 3)] });
  const r = S.tiers([{ pageIndex: 0, paragraphs: [p, q, n] }], { role: (k) => (k === "p_0_2" ? "background" : "result") });
  assert.deepEqual([...r.keyPoints].sort(), ["b", "c", "d"]);
});

const near = (a, b) => assert.ok(Math.abs(a - b) <= 1, `${a} vs ${b}`);
const rp = (i, o) => ({ pageIndex: 0, paragraphIndex: i, paragraphType: "text", ...o });
test("readingTime modes, Latin", () => {
  const w = (n) => Array(n).fill("word").join(" ");
  const ps = [
    rp(0, { paragraphType: "title", paragraphText: w(23), paragraphSummary: "" }),
    rp(1, { paragraphText: w(230), paragraphSummary: w(23) }),
    rp(2, { paragraphText: w(460), paragraphSummary: w(46) }),
    rp(3, { paragraphText: w(690), paragraphSummary: w(69) }),
    rp(4, { paragraphType: "equation", paragraphText: w(100) }),
  ];
  const tier = new Map([["p_0_1", "key"], ["p_0_2", "normal"], ["p_0_3", "minor"]]);
  near(S.readingTime(ps, { tier, mode: "full" }), (23 + 230 + 460 + 690) / 230 * 60);
  near(S.readingTime(ps, { tier, mode: "key" }), (230 + 46) / 230 * 60);
  near(S.readingTime(ps, { tier, mode: "margin" }), (23 + 46) / 230 * 60);
  assert.ok(Number.isInteger(S.readingTime(ps, { tier, mode: "full" })));
});
test("readingTime CJK and mixed", () => {
  const ps = [rp(0, { paragraphText: "字".repeat(450), paragraphSummary: "字".repeat(45) })];
  assert.equal(S.readingTime(ps, { tier: new Map([["p_0_0", "key"]]), mode: "full" }), 60);
  assert.equal(S.readingTime(ps, { tier: new Map([["p_0_0", "normal"]]), mode: "key" }), 6);
  assert.equal(S.readingTime(ps, { tier: new Map([["p_0_0", "minor"]]), mode: "key" }), 0);
  const mixed = [rp(0, { paragraphText: "字".repeat(450) + " " + Array(230).fill("a").join(" ") })];
  assert.equal(S.readingTime(mixed, { mode: "full" }), 120);
});

const E = [
  { key: "a", pageIndex: 0, top: 100 },
  { key: "b", pageIndex: 0, top: 500 },
  { key: "c", pageIndex: 1, top: 50 },
  { key: "d", pageIndex: 3, top: 900 },
];
test("nextKey / prevKey", () => {
  assert.equal(S.nextKey(E, { pageIndex: 0, top: 0 }).key, "a");
  assert.equal(S.nextKey(E, { pageIndex: 0, top: 100 }).key, "b");
  assert.equal(S.nextKey(E, { pageIndex: 0, top: 600 }).key, "c");
  assert.equal(S.nextKey(E, { pageIndex: 2, top: 0 }).key, "d");
  assert.equal(S.nextKey(E, { pageIndex: 3, top: 900 }), null);
  assert.equal(S.prevKey(E, { pageIndex: 3, top: 900 }).key, "c");
  assert.equal(S.prevKey(E, { pageIndex: 1, top: 50 }).key, "b");
  assert.equal(S.prevKey(E, { pageIndex: 0, top: 100 }), null);
  assert.equal(S.prevKey(E, { pageIndex: 0, top: 300 }).key, "a");
});
test("nextKey with tier filter", () => {
  const tier = new Map([["a", "normal"], ["b", "key"], ["c", "minor"], ["d", "key"]]);
  assert.equal(S.nextKey(E, { pageIndex: 0, top: 0 }, tier).key, "b");
  assert.equal(S.nextKey(E, { pageIndex: 0, top: 500 }, tier).key, "d");
  assert.equal(S.prevKey(E, { pageIndex: 3, top: 900 }, tier).key, "b");
  assert.equal(S.prevKey(E, { pageIndex: 0, top: 500 }, tier), null);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all skim tests passed");
