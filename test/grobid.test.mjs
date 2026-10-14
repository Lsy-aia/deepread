// Tests for DeepRead.GrobidParser.teiToContentList (services/grobidParser.js).
// Needs a DOMParser: run `npm install --no-save @xmldom/xmldom` in a scratch dir and point GROBID_TEST_DEPS at it
// (default /tmp/claude-1000/grobid-test-deps). Nothing is added to the repo's package.json.
// Fixture: test/fixtures/demo/grobid-tei.xml (TEI from GROBID, or a hand-made one in the same format).
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const depsDir = process.env.GROBID_TEST_DEPS || "/tmp/claude-1000/grobid-test-deps";
let DOMParser;
try {
  DOMParser = createRequire(path.join(depsDir, "x.js"))("@xmldom/xmldom").DOMParser;
}
catch (e) {
  DOMParser = createRequire(import.meta.url)("@xmldom/xmldom").DOMParser;
}

const ctx = { DeepRead: { log() {}, bilingual: (z, e) => e }, console, setTimeout, clearTimeout, AbortController };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/grobidParser.js"), "utf8"), ctx);
const G = ctx.DeepRead.GrobidParser;

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  }
  catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const normT = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

// ---- fixture --------------------------------------------------------------
const xml = fs.readFileSync(path.join(root, "test/fixtures/demo/grobid-tei.xml"), "utf8");
const mineru = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/demo/demo_content_list.json"), "utf8"));
const { contentList: out, markdown, summary } = G.teiToContentList(xml, { DOMParser });
console.log(`items=${out.length} summary=${JSON.stringify(summary)}`);

check("title found (level 1, page 0)", () => {
  const t = out.find((i) => i.text_level === 1 && normT(i.text) === "attentionisallyouneed");
  assert.ok(t); assert.equal(t.page_idx, 0);
});

const mHeads = mineru.filter((i) => i.type === "text" && i.text_level === 1);
check("headings recall >= 85% vs MinerU", () => {
  const ours = new Set(out.filter((i) => i.text_level === 1).map((i) => normT(i.text)));
  const hit = mHeads.filter((h) => ours.has(normT(h.text)));
  const miss = mHeads.filter((h) => !ours.has(normT(h.text))).map((h) => h.text.slice(0, 40));
  const recall = hit.length / mHeads.length;
  console.log(`  heading recall ${hit.length}/${mHeads.length} = ${(recall * 100).toFixed(1)}%  missing: ${JSON.stringify(miss)}`);
  assert.ok(recall >= 0.85);
});

check("heading numbers kept (3.2.1 ...)", () => {
  assert.ok(out.some((i) => i.text_level === 1 && i.text === "3.2.1 Scaled Dot-Product Attention"));
});

check("abstract heading + paragraph", () => {
  const i = out.findIndex((x) => x.text_level === 1 && x.text === "Abstract");
  assert.ok(i >= 0);
  assert.ok(/dominant sequence transduction/.test(out[i + 1].text));
  assert.equal(out[i + 1].page_idx, 0);
});

check("figures and tables with captions", () => {
  const imgs = out.filter((i) => i.type === "image");
  const tabs = out.filter((i) => i.type === "table");
  console.log(`  images ${imgs.length}/${mineru.filter((i) => i.type === "image").length}, tables ${tabs.length}/${mineru.filter((i) => i.type === "table").length}`);
  assert.equal(imgs.length, mineru.filter((i) => i.type === "image").length);
  assert.equal(tabs.length, mineru.filter((i) => i.type === "table").length);
  assert.ok(imgs.every((i) => i.image_caption[0].length > 10 && i.img_path === ""));
  assert.ok(tabs.every((i) => i.table_caption[0].startsWith("Table ")));
  assert.ok(tabs[0].table_body.includes(" | ") && tabs[0].table_body.includes("\n"));
});

check("formula present with label", () => {
  const f = out.filter((i) => i.type === "equation");
  assert.ok(f.length >= 1);
  assert.ok(f[0].text.includes("(1)") && f[0].text_format === "text");
});

check("references heading + entries", () => {
  const i = out.findIndex((x) => x.text_level === 1 && x.text === "References");
  assert.ok(i >= 0);
  assert.equal(out[i + 1].text, "Jimmy Lei Ba. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.");
});

check("boxes valid (per-mille ints, x0<x1, y0<y1, page in range)", () => {
  for (const it of out) {
    assert.ok(it.bbox.length === 4 && it.bbox.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000), JSON.stringify(it));
    assert.ok(it.bbox[0] <= it.bbox[2] && it.bbox[1] <= it.bbox[3], JSON.stringify(it));
    assert.ok(it.page_idx >= 0 && it.page_idx < 15);
  }
});

check("page_idx matches MinerU for headings", () => {
  const ours = new Map(out.filter((i) => i.text_level === 1).map((i) => [normT(i.text), i.page_idx]));
  const both = mHeads.filter((h) => ours.has(normT(h.text)));
  const same = both.filter((h) => ours.get(normT(h.text)) === h.page_idx);
  assert.equal(same.length, both.length);
});

check("MinerU text blocks p1-9 overlapped >= 70%", () => {
  const blocks = mineru.filter((i) => i.type === "text" && i.page_idx <= 8);
  const hit = blocks.filter((m) => out.some((o) => {
    if (o.page_idx !== m.page_idx) return false;
    const iw = Math.min(o.bbox[2], m.bbox[2]) - Math.max(o.bbox[0], m.bbox[0]);
    const ih = Math.min(o.bbox[3], m.bbox[3]) - Math.max(o.bbox[1], m.bbox[1]);
    return iw > 0 && ih > 0 && iw * ih >= 0.3 * (m.bbox[2] - m.bbox[0]) * (m.bbox[3] - m.bbox[1]);
  }));
  const r = hit.length / blocks.length;
  console.log(`  overlap ${hit.length}/${blocks.length} = ${(r * 100).toFixed(1)}%`);
  assert.ok(r >= 0.7);
});

check("markdown shapes", () => {
  assert.ok(markdown.startsWith("# Attention Is All You Need"));
  assert.ok(/\n\n## ?|\n\n# 1 Introduction/.test(markdown) || markdown.includes("# 1 Introduction"));
  assert.ok(markdown.includes("$$") && /\n\n\*Figure 1:/.test(markdown));
});

// ---- synthetic cases ------------------------------------------------------
const wrap = (body, back = "") => `<?xml version="1.0"?><TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title level="a" type="main" coords="1,100,50,400,20">T</title></titleStmt></fileDesc></teiHeader>
<facsimile><surface n="1" ulx="0" uly="0" lrx="600" lry="800"/><surface n="2" ulx="0" uly="0" lrx="600" lry="800"/></facsimile>
<text><body>${body}</body><back>${back}</back></text></TEI>`;

check("synthetic: coords -> per-mille", () => {
  const r = G.teiToContentList(wrap(`<div><p coords="1,60,80,300,40;1,60,120,150,40">Hello world.</p></div>`), { DOMParser });
  const p = r.contentList.find((i) => i.text === "Hello world.");
  assert.equal(JSON.stringify(p.bbox), "[100,100,600,200]");
  assert.equal(p.page_idx, 0);
});

check("synthetic: two-page paragraph split by sentences", () => {
  const body = `<div><p coords="1,60,700,400,80;2,60,40,400,40"><s coords="1,60,700,400,80">First sentence here.</s><s coords="2,60,40,400,40">Second one.</s></p></div>`;
  const r = G.teiToContentList(wrap(body), { DOMParser });
  const ps = r.contentList.filter((i) => i.type === "text" && !i.text_level);
  assert.equal(ps.length, 2);
  assert.equal(JSON.stringify(ps.map((p) => [p.page_idx, p.text])), JSON.stringify([[0, "First sentence here."], [1, "Second one."]]));
});

check("synthetic: two-page paragraph without sentences splits proportionally", () => {
  const body = `<div><p coords="1,60,700,400,80;2,60,40,400,80">a b c d e f g h</p></div>`;
  const r = G.teiToContentList(wrap(body), { DOMParser });
  const ps = r.contentList.filter((i) => !i.text_level);
  assert.equal(ps.length, 2);
  assert.equal(ps.map((p) => p.text).join(" "), "a b c d e f g h");
});

check("synthetic: items without coords skipped and counted", () => {
  const body = `<div><head n="2">No box</head><p>No coords here</p><p coords="1,10,10,100,10">Has coords</p><figure><figDesc>x</figDesc></figure></div>`;
  const r = G.teiToContentList(wrap(body), { DOMParser });
  assert.ok(!r.contentList.some((i) => /No (box|coords)/.test(i.text || "")));
  assert.ok(r.contentList.some((i) => i.text === "Has coords"));
  assert.equal(r.summary.skippedNoCoords, 3);
});

check("synthetic: non-TEI input rejected", () => {
  assert.throws(() => G.teiToContentList("<html><body>Error</body></html>", { DOMParser }), /not TEI/);
});

if (failed) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll grobid tests passed");
