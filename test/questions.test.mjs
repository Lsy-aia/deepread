// Tests for DeepRead.Questions. Run: node test/questions.test.mjs
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
for (const f of ["util.js", "l10n.js", "pipeline/languages.js", "services/questions.js"]) {
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

const Q = ctx.DeepRead.Questions;

const blk = (i, extra = {}) => ({ key: `p_0_${i}`, label: `p. 1 ¶${i}`, summary: `sum ${i}`, explanation: `exp ${i}`, role: "method", text: `text ${i}`, ...extra });
const blocks = [0, 1, 2, 3, 4, 5].map((i) => blk(i));
const sent = (args) => JSON.parse(args.messages.at(-1).content.split("Paper blocks (JSON):\n")[1]).blocks;
const full = (keys = ["p_0_1"]) => ({
  content: JSON.stringify({ questions: Q.STANDARD.map((s) => ({ id: s.id, question: `Q ${s.id}`, answer: `A ${s.id}`, keys })) }),
});

await test("STANDARD has five questions", () => {
  assert.deepEqual(plain(Q.STANDARD.map((s) => s.id)), ["q1", "q2", "q3", "q4", "q5"]);
  assert.ok(Q.STANDARD.every((s) => s.zh && s.en));
});

await test("generate: prompt, marker, language, request options", async () => {
  handler = () => full();
  const out = await Q.generate({ blocks, paperContext: "CTX", targetLang: "en" });
  const a = requests[0];
  const user = a.messages.at(-1).content;
  assert.match(user, /Paper blocks \(JSON\):\n\{/);
  assert.match(user, /Paper context:\nCTX/);
  for (const id of ["q1", "q2", "q3", "q4", "q5"]) assert.ok(user.includes(`"${id}"`) || user.includes(`- ${id}:`));
  assert.match(a.system, /in English/);
  assert.deepEqual(plain(a.responseFormat), { type: "json_object" });
  assert.equal(sent(a).length, 6);
  assert.equal(out.length, 5);
  assert.deepEqual(plain(out[0]), { id: "q1", question: "Q q1", answer: "A q1", keys: ["p_0_1"] });
});

await test("generate: language instruction follows targetLang", async () => {
  handler = () => full();
  await Q.generate({ blocks, targetLang: "zh" });
  assert.match(requests[0].system, /Simplified Chinese/);
});

await test("budget: tail dropped, text only for blocks without summary/explanation", async () => {
  handler = () => full();
  const many = [blk(0, { summary: "", explanation: "", text: "t".repeat(900) }), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => blk(i))];
  await Q.generate({ blocks: many, maxChars: 1000 });
  const items = sent(requests[0]);
  assert.ok(items.length > 1 && items.length < 9, `kept ${items.length}`);
  assert.deepEqual(plain(items.map((b) => b.key)), many.slice(0, items.length).map((b) => b.key));
  assert.equal(items[0].text.length, 600);
  assert.ok(items.slice(1).every((b) => !("text" in b) && b.summary && b.explanation && b.role && b.label));
  requests.length = 0;
  await Q.generate({ blocks: many });
  assert.equal(sent(requests[0]).length, 9);
});

await test("_parse: fences, think blocks, invalid keys dropped, reading order", () => {
  const body = JSON.stringify({ questions: [{ id: "q1", question: "Q", answer: "A", keys: ["p_0_3", "bogus", "p_0_1", "p_0_3"] }] });
  const out = plain(Q._parse(`<think>hmm</think>\n\`\`\`json\n${body}\n\`\`\``, blocks, "zh"));
  assert.deepEqual(out[0], { id: "q1", question: "Q", answer: "A", keys: ["p_0_1", "p_0_3"] });
  const cap = plain(Q._parse(JSON.stringify({ questions: [{ id: "q1", answer: "A", keys: ["p_0_0", "p_0_1", "p_0_2", "p_0_3", "p_0_4"] }] }), blocks, "zh"));
  assert.equal(cap[0].keys.length, 4);
});

await test("_parse: missing entries filled from STANDARD in the target language", () => {
  const body = JSON.stringify({ questions: [{ id: "q3", answer: "A3", keys: ["p_0_2"] }, { id: "q4", question: "x", answer: "", keys: [] }, "junk"] });
  const zh = plain(Q._parse(body, blocks, "zh"));
  assert.deepEqual(zh.map((x) => x.id), ["q1", "q2", "q3", "q4", "q5"]);
  assert.deepEqual(zh[0], { id: "q1", question: "要解决什么问题？", answer: "", keys: [] });
  assert.equal(zh[2].question, "关键设计有哪些？");
  assert.equal(zh[3].answer, "");
  const en = plain(Q._parse(body, blocks, "en"));
  assert.equal(en[4].question, "What are the limitations?");
  assert.deepEqual(plain(Q._parse("not json", blocks, "en")).map((x) => x.answer), ["", "", "", "", ""]);
});

await test("generate: retries once, then throws; abort not retried", async () => {
  handler = (a, n) => { if (n === 1) throw new Error("boom"); return full(); };
  const out = await Q.generate({ blocks });
  assert.equal(requests.length, 2);
  assert.equal(out[4].answer, "A q5");
  requests.length = 0;
  handler = () => { throw new Error("always"); };
  await assert.rejects(() => Q.generate({ blocks }), /always/);
  assert.equal(requests.length, 2);
  requests.length = 0;
  handler = () => { const e = new Error("x"); e.name = "AbortError"; throw e; };
  await assert.rejects(() => Q.generate({ blocks }), (e) => e.name === "AbortError");
  assert.equal(requests.length, 1);
  requests.length = 0;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => Q.generate({ blocks, signal: ac.signal }), (e) => e.name === "AbortError");
  assert.equal(requests.length, 0);
});

await test("ask: answered", async () => {
  handler = () => ({ content: "```json\n" + JSON.stringify({ answer: "Because X.", keys: ["p_0_4", "zzz", "p_0_2"] }) + "\n```" });
  const out = await Q.ask("Why X?", { blocks, targetLang: "en" });
  const user = requests[0].messages.at(-1).content;
  assert.match(user, /Question to answer:\nWhy X\?/);
  assert.match(user, /Paper blocks \(JSON\):\n\{/);
  assert.ok(user.indexOf("Question to answer:") < user.indexOf("Paper blocks (JSON):"));
  assert.deepEqual(plain(out), { answer: "Because X.", keys: ["p_0_2", "p_0_4"] });
});

await test("ask: not answered by the paper", async () => {
  handler = () => ({ content: JSON.stringify({ answer: "The paper does not say.", keys: [] }) });
  assert.deepEqual(plain(await Q.ask("Unrelated?", { blocks })), { answer: "The paper does not say.", keys: [] });
});

await test("ask: retry, empty answer and empty question", async () => {
  handler = (a, n) => { if (n === 1) throw new Error("boom"); return { content: JSON.stringify({ answer: "ok", keys: [] }) }; };
  assert.equal((await Q.ask("q", { blocks })).answer, "ok");
  assert.equal(requests.length, 2);
  handler = () => ({ content: "garbage" });
  await assert.rejects(() => Q.ask("q", { blocks }), /no answer/);
  await assert.rejects(() => Q.ask("  ", { blocks }), /Empty question/);
});

if (failures) {
  console.log(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all questions tests passed");
