// Stand-in CLI agent for end-to-end tests.
// Usage: node test/fake-agent.mjs [--cd DIR] [--fail] [--slow MS] <prompt...>
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
let cd = process.cwd();
let fail = false;
let slow = 300;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--cd") cd = argv[++i];
  else if (argv[i] === "--fail") fail = true;
  else if (argv[i] === "--slow") slow = Number(argv[++i]) || 0;
  else rest.push(argv[i]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (fail) {
  console.log("fake-agent: starting");
  console.error("error: simulated agent failure");
  process.exit(2);
}

const steps = ["reading paper.md", "applying nature-paper-xray", "applying nature-paper-card", "writing xray.md and paper-card.md"];
const paper = fs.existsSync(path.join(cd, "paper.md")) ? fs.readFileSync(path.join(cd, "paper.md"), "utf8") : "";
const labels = [...new Set(paper.match(/\[p\. \d+ ¶\d+\]/g) || [])].slice(0, 3);
while (labels.length < 3) labels.push("[p. 1 ¶1]");

for (const s of steps) {
  console.log(s);
  await sleep(slow / steps.length);
}

const xray = `# 长读：示例论文

## 这篇真正主张什么
作者主张其方法优于基线 ${labels[0]}。

## 研究路径
先指出旧方法失效，再提出新部件 ${labels[1]}。

## 承重部件
核心部件很可能 (likely) 是承重的，但消融不足，属于推测。

## 公式手算
$$y = w x + b$$
取 w=2, x=3, b=1，则 y=7 ${labels[2]}。

## 证据边界
只有单一数据集，结论的外推属于推测。
`;
const titles = ["基本信息", "研究问题", "背景", "核心主张", "方法概览", "关键部件", "数据与设置", "主要结果", "消融", "对比基线", "局限", "可复现性", "相关工作", "启发", "阅读建议", "研究想法"];
const card = titles.map((t, i) => `## ${String(i + 1).padStart(2, "0")} ${t}\n简述 ${i === 0 ? labels[0] : "见正文"}。\n`).join("\n");
fs.writeFileSync(path.join(cd, "xray.md"), xray);
fs.writeFileSync(path.join(cd, "paper-card.md"), card);
console.log("DEEPREAD_DONE");
