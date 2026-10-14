// Tests for DeepRead.TextLayerParser (built-in text-layer parser). Run: node test/textlayer.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ DeepRead: {}, console, Zotero: { debug() {} } });
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/textLayerParser.js"), "utf8"), ctx);
const TL = ctx.DeepRead.TextLayerParser;
const build = (pages) => JSON.parse(JSON.stringify(TL.buildContentList(pages)));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack || e}`); }
}

// ---- synthetic helpers: a line of text → chars --------------------------------------------------
function lineChars(text, { x = 72, top = 100, size = 10, font = "AAAAAA+Times-Roman", rotation = 0, para = true, H = 792 } = {}) {
  const y2 = H - top, y1 = y2 - size;
  const out = [];
  [...text].forEach((ch, i) => {
    const last = i === text.length - 1;
    out.push({
      c: ch, u: ch, rect: [x + i * size * 0.5, y1, x + (i + 1) * size * 0.5, y2], fontSize: size, fontName: font,
      baseline: y1 + size * 0.2, rotation, spaceAfter: ch === " " ? false : false,
      lineBreakAfter: last, paragraphBreakAfter: last && para,
    });
  });
  return out;
}
const page = (pageIndex, lines) => ({ pageIndex, viewBox: [0, 0, 612, 792], chars: lines.flat() });
const body = (t, top, extra = {}) => lineChars(t, { top, ...extra });
const longText = "The quick brown fox jumps over the lazy dog and keeps running through the forest ";

check("de-hyphenation across line break", () => {
  const p = page(0, [
    body(longText + "inter-", 200, { para: false }),
    body("national agreements. " + longText, 212),
    body(longText + longText, 300),
  ]);
  const r = build([p]);
  assert.ok(r.some((i) => i.text && i.text.includes("international agreements")), JSON.stringify(r.map((i) => i.text)));
});

check("rotated chars (arXiv stamp) are dropped", () => {
  const p = page(0, [
    body(longText + longText, 200),
    lineChars("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", { x: 20, top: 200, rotation: 90 }),
  ]);
  const r = build([p]);
  assert.equal(r.filter((i) => /arXiv/.test(i.text || "")).length, 0);
  assert.equal(r.length, 1);
});

check("repeated header/footer and page numbers dropped", () => {
  const pages = [0, 1, 2, 3].map((i) => page(i, [
    body("Journal of Testing Vol. " + (10 + i), 30),
    body(longText + longText + i, 300),
    body(String(i + 1), 760),
  ]));
  const r = build(pages);
  assert.equal(r.length, 4, JSON.stringify(r.map((x) => x.text)));
  assert.ok(r.every((i) => !/Journal|^\d+$/.test(i.text)));
});

check("caption detection → image/table items", () => {
  const p = page(0, [
    body(longText + longText, 100, { para: true }),
    body(longText + longText, 112),
    body("Figure 3: A nice diagram of the system.", 400),
    body("Table 2: Results of the experiment.", 450),
    body(longText + longText, 600),
    body(longText + longText, 612),
  ]);
  const r = build([p]);
  const img = r.find((i) => i.type === "image");
  const tab = r.find((i) => i.type === "table");
  assert.ok(img && img.image_caption[0].startsWith("Figure 3"));
  assert.ok(tab && tab.table_caption[0].startsWith("Table 2"));
  assert.ok(img.bbox[1] < 400 / 792 * 1000, "figure region extends above its caption");
});

check("heading by font size and by numbering+bold", () => {
  const p = page(0, [
    body(longText + longText, 100), body(longText + longText, 112),
    body("2 Related Work", 160, { size: 12, font: "BBBBBB+Times-Bold" }),
    body(longText + longText, 190), body(longText + longText, 202),
    body("2.1 Small Things", 250, { font: "BBBBBB+Times-Bold" }),
    body(longText + longText, 280), body(longText + longText, 292),
  ]);
  const r = build([p]);
  const heads = r.filter((i) => i.text_level === 1).map((i) => i.text);
  assert.deepEqual(heads, ["2 Related Work", "2.1 Small Things"]);
});

check("markdown output", () => {
  const md = TL.toMarkdown([{ type: "text", text: "T", text_level: 1 }, { type: "text", text: "p" },
    { type: "image", image_caption: ["Figure 1: x."] }, { type: "equation", text: "a=b" }]);
  assert.equal(md, "# T\n\np\n\n*Figure 1: x.*\n\n$$a=b$$\n");
});

// ---- demo paper vs MinerU -----------------------------------------------------------------------
const charsPath = path.join(root, "test/fixtures/demo/chars.json");
const refPath = path.join(root, "test/fixtures/demo/demo_content_list.json");
if (fs.existsSync(charsPath) && fs.existsSync(refPath)) {
  const pages = JSON.parse(fs.readFileSync(charsPath, "utf8"));
  const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
  const t0 = Date.now();
  const out = build(pages);
  const ms = Date.now() - t0;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  const refHeads = ref.filter((i) => i.text_level === 1);
  const outHeads = out.filter((i) => i.text_level === 1).map((i) => norm(i.text));
  const foundHeads = refHeads.filter((r) => outHeads.some((h) => h.startsWith(norm(r.text).slice(0, 20)))).length;
  const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const refText = ref.filter((i) => i.type === "text" && i.page_idx < 9);
  const covered = refText.filter((r) => {
    const a = (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]);
    return out.some((o) => o.page_idx === r.page_idx && ov(o.bbox, r.bbox) > 0.3 * a);
  }).length;
  const cnt = (l, t) => l.filter((i) => i.type === t).length;
  console.log(`metrics: items=${out.length} ms=${ms} headings=${foundHeads}/${refHeads.length} (out ${outHeads.length}) ` +
    `coverage=${covered}/${refText.length} image=${cnt(out, "image")}/${cnt(ref, "image")} table=${cnt(out, "table")}/${cnt(ref, "table")}`);

  check("demo: headings recall >= 85%", () => assert.ok(foundHeads / refHeads.length >= 0.85));
  check("demo: paper title found as heading", () => assert.ok(out.some((i) => i.text_level === 1 && i.page_idx === 0 && /Attention Is All You Need/.test(i.text))));
  check("demo: no arXiv stamp item", () => assert.ok(!out.some((i) => /^arXiv:/.test(i.text || ""))));
  check("demo: no page-number-only items", () => assert.ok(!out.some((i) => i.type === "text" && /^\s*\d{1,3}\s*$/.test(i.text))));
  check("demo: author names are not headings", () => assert.ok(!out.some((i) => i.text_level === 1 && i.page_idx === 0 && /Vaswani|Shazeer|Parmar/.test(i.text))));
  check("demo: page 0 front matter merged, notice dropped", () => {
    const p0 = out.filter((i) => i.page_idx === 0);
    assert.equal(p0[0].text_level, 1);
    assert.ok(!p0.some((i) => /grants permission/.test(i.text)));
    const authors = p0.filter((i) => /Vaswani/.test(i.text));
    assert.equal(authors.length, 1);
    assert.ok(/Shazeer/.test(authors[0].text) && / · /.test(authors[0].text));
    assert.ok(p0.findIndex((i) => /^Abstract/.test(i.text)) === p0.indexOf(authors[0]) + 1);
  });
  check("demo: table content not a heading", () => assert.ok(!out.some((i) => i.text_level === 1 && /Parser Training/.test(i.text))));
  check("demo: 3.5 and 6.2 headings found", () => {
    assert.ok(out.some((i) => i.text_level === 1 && /^3\.5 Positional/.test(i.text)));
    assert.ok(out.some((i) => i.text_level === 1 && /^6\.2 Model Variations/.test(i.text)));
  });
  check("demo: >= 70% of MinerU text blocks (pages 1-9) covered", () => assert.ok(covered / refText.length >= 0.7));
  check("demo: figures and tables captioned", () => {
    assert.ok(cnt(out, "image") >= 4 && cnt(out, "table") >= 3);
    assert.ok(out.some((i) => i.type === "image" && /^Figure 1/.test(i.image_caption[0])));
  });
  check("demo: bboxes valid and ordered by page", () => {
    let last = 0;
    for (const i of out) {
      assert.ok(i.bbox.length === 4 && i.bbox.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000));
      assert.ok(i.bbox[2] >= i.bbox[0] && i.bbox[3] >= i.bbox[1]);
      assert.ok(i.page_idx >= last);
      last = i.page_idx;
    }
  });
}
else console.log("SKIP demo comparison (test/fixtures/demo/chars.json missing; run scripts/e2e.sh test/e2e/dump-chars.js)");

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
