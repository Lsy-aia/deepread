// Tests for the pure helpers of DeepRead.GuideView. Run: node test/guideView.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");
const ctx = vm.createContext({ Zotero: { debug() {}, locale: "zh-CN" }, DeepRead: {}, Intl, Date });
for (const f of ["l10n.js", "reader/guideView.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const GV = ctx.DeepRead.GuideView;
assert.ok(GV && typeof GV.render === "function" && typeof GV.CSS === "string");

const full = {
  type: "algorithmic",
  position: { claim: "c", path: [{}, {}], focus: ["a"], order: [{}], questions: ["q1", "q2", "q3"] },
  skeleton: { moves: [{}, {}], terms: [{}] },
  method: { components: [{}], insight: { core: "x" }, formulas: [{}, {}] },
  evidence: { chain: [{}], checks: [{}, {}], hedges: [{}] },
  takeaway: { summary: "s", learned: ["a", "b"], ideas: [{}], },
};
assert.equal(JSON.stringify(GV.stepCounts(full)), JSON.stringify([8, 3, 4, 4, 4]));
assert.equal(JSON.stringify(GV.stepCounts({ position: { claim: "c" }, takeaway: {} })), JSON.stringify([1, 0, 0, 0, 0]));
assert.equal(JSON.stringify(GV.stepCounts(null)), JSON.stringify([0, 0, 0, 0, 0]));
assert.equal(JSON.stringify(GV.stepCounts({ markdown: { card: "x" } })), JSON.stringify([0, 0, 0, 0, 1]));

function check(fn, table) {
  for (const [k, zh] of Object.entries(table)) assert.ok(String(fn(k)).includes(zh), `${k} -> ${fn(k)}`);
  assert.equal(fn("weird"), "weird");
  assert.equal(fn(undefined), "");
  assert.equal(fn("toString"), "toString");
}
check(GV.verdictLabel, { "load-bearing": "承重", contributing: "贡献", decorative: "装饰", unestablished: "未确立", pending: "待定" });
check(GV.statusLabel, { proven: "已证", partial: "部分", unproven: "未证", pending: "待读" });
check(GV.strengthLabel, { strong: "强断言", hedged: "保留", speculative: "推测", outlook: "展望" });
check(GV.basisLabel, { source: "原文", inference: "推断", pending: "待读" });
check(GV.effectLabel, { changes: "改变结论", weakens: "削弱结论", scopes: "限定范围", wording: "仅表述问题" });
check(GV.roleLabel, { background: "背景", gap: "空白", prior: "已有方案", contribution: "贡献", claim: "主张", evidence: "证据", limitation: "局限" });
console.log("guideView tests passed");
