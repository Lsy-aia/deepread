// Tests DeepRead.PdfExport (addon/content/scripts/services/pdfExport.js) in Node with the vendored libraries.
// Run: node test/pdfexport.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test", "fixtures", "out");
fs.mkdirSync(outDir, { recursive: true });

process.on("uncaughtException", (e) => { console.log("FAIL exception: " + String(e && e.stack).slice(0, 1500)); process.exit(1); });
let failures = 0;
const pass = (m) => console.log("PASS " + m);
const fail = (m) => { failures++; console.log("FAIL " + m); };
const check = (cond, m) => (cond ? pass(m) : fail(m));

// ---- harness: load the runtime script like Zotero does (classic script with a DeepRead namespace)
const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, TextEncoder, TextDecoder, Uint8Array, DataView, Map, Set });
const DeepRead = { rootURI: "file://" + root + "/addon/", log: () => {}, prefs: { get: () => "" } };
ctx.DeepRead = DeepRead;
ctx.Services = {
  scriptloader: {
    loadSubScript(url, scope) {
      const file = url.replace("file://", "");
      vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
      // UMD builds attach to the context global; expose them on the scope object like Zotero's target does.
      scope.PDFLib = ctx.PDFLib; scope.fontkit = ctx.fontkit;
    },
  },
};
ctx.IOUtils = {
  exists: async (p) => fs.existsSync(p),
  read: async (p, o) => new Uint8Array(fs.readFileSync(p)).subarray(0, o?.maxBytes || undefined),
  getChildren: async (d) => fs.readdirSync(d).map((n) => path.join(d, n)),
};
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/pdfExport.js"), "utf8"), ctx, { filename: "pdfExport.js" });
const PdfExport = DeepRead.PdfExport;
const PDFLib = PdfExport.libs().PDFLib;
const toCtxArray = vm.runInContext("(a) => Array.from(a)", ctx); // pdf-lib checks instanceof Array (realm-sensitive)

const have = (bin) => spawnSync("which", [bin]).status === 0;
const pdftotext = (file, page) => execFileSync("pdftotext", ["-f", String(page), "-l", String(page), file, "-"]).toString();
function png(file, page, name) {
  if (!have("pdftoppm")) return;
  const prefix = path.join(outDir, name);
  execFileSync("pdftoppm", ["-r", "60", "-f", String(page), "-l", String(page), "-png", file, prefix]);
  const made = fs.readdirSync(outDir).filter((f) => f.startsWith(name + "-") && f.endsWith(".png"));
  console.log("PNG " + path.join(outDir, made[made.length - 1]));
}

const font = process.env.FONT ? { path: process.env.FONT, name: "env" } : await PdfExport.findCJKFont();
console.log(font ? `font: ${font.path}` : "SKIP CJK part: no CJK font found on this machine");

// ---- synthetic PDF
{
  const doc = await PDFLib.PDFDocument.create();
  const helv = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage(toCtxArray([400, 300]));
    p.drawText(`Original paragraph ${i}`, { x: 40, y: 250, size: 12, font: helv });
  }
  const bytes = await doc.save();
  const list = [
    { id: 0, type: "text", text: "Original paragraph 0", bbox: [80, 120, 700, 180], page_idx: 0 },
    { id: 1, type: "text", text: "Title", text_level: 1, bbox: [80, 300, 700, 360], page_idx: 1 },
  ];
  const tr = new Map([[0, "这是一段译文，用来测试自动换行与字号收缩。" + "很长".repeat(40)], [1, "标题"]]);
  const ph = [];
  const o1 = await PdfExport.build({ pdfBytes: bytes, contentList: list, translations: tr, mode: "inplace", fontPath: font && font.path, onProgress: (p) => ph.push(p.done) });
  fs.writeFileSync(path.join(outDir, "synthetic-inplace.pdf"), o1);
  const d1 = await PDFLib.PDFDocument.load(o1);
  check(d1.getPageCount() === 2, "synthetic in-place keeps 2 pages");
  check(ph.join() === "1,2", "synthetic progress reported per page");
  const o2 = await PdfExport.build({ pdfBytes: bytes, contentList: list, translations: tr, mode: "dual", fontPath: font && font.path });
  fs.writeFileSync(path.join(outDir, "synthetic-dual.pdf"), o2);
  const d2 = await PDFLib.PDFDocument.load(o2);
  check(d2.getPageCount() === 2 && Math.round(d2.getPage(0).getWidth()) === 800, "synthetic dual width = 2x");
  if (have("pdftotext") && font) {
    const t = pdftotext(path.join(outDir, "synthetic-inplace.pdf"), 1);
    check(/译文/.test(t), "synthetic in-place text extractable (Chinese)");
  }
}

// ---- TTC extraction sanity
if (font && /\.ttc$/i.test(font.path)) {
  const raw = new Uint8Array(fs.readFileSync(font.path));
  const one = PdfExport.extractFromTTC(raw);
  const f = PdfExport.libs().fontkit.create(Buffer.from(one));
  console.log(`TTC face: ${f.fullName} (${f.numGlyphs} glyphs, ${(one.length / 1e6).toFixed(1)} MB)`);
  check(f.hasGlyphForCodePoint(0x8bd1), "TTC extract: face has CJK glyphs");
}

// ---- TTC end-to-end (extractor + subset embed) when a TrueType collection is installed
{
  const ttc = ["/usr/share/fonts/truetype/arphic/uming.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "C:\\Windows\\Fonts\\msyh.ttc"].find((f) => fs.existsSync(f));
  if (!ttc) console.log("SKIP TTC end-to-end: no TrueType collection installed");
  else {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage(toCtxArray([300, 200]));
    const bytes = await doc.save();
    const out = await PdfExport.build({ pdfBytes: bytes, mode: "inplace", fontPath: ttc,
      contentList: [{ id: 0, type: "text", text: "x", bbox: [50, 100, 900, 400], page_idx: 0 }], translations: new Map([[0, "集合字体提取测试"]]) });
    const f = path.join(outDir, "ttc-test.pdf");
    fs.writeFileSync(f, out);
    check(!have("pdftotext") || /集合字体/.test(pdftotext(f, 1)), `TTC (${path.basename(ttc)}) embeds and extracts`);
  }
}

// ---- demo paper
const demoPdf = path.join(root, "test/fixtures/demo/demo-paper.pdf");
const demoList = path.join(root, "test/fixtures/demo/demo_content_list.json");
if (!fs.existsSync(demoPdf) || !fs.existsSync(demoList)) console.log("SKIP demo paper: fixtures absent");
else if (!font) console.log("SKIP demo paper CJK export: no CJK font");
else {
  const pdfBytes = new Uint8Array(fs.readFileSync(demoPdf));
  const contentList = JSON.parse(fs.readFileSync(demoList, "utf8")).map((x, id) => ({ id, ...x }));
  const zh = "【译】深度学习模型通过注意力机制建模序列之间的依赖关系，并在机器翻译任务上取得了显著的效果提升。";
  const translations = new Map();
  for (const it of contentList) {
    if (it.type !== "text" || !it.text) continue;
    const n = Math.max(6, Math.round(it.text.length * 0.45));
    translations.set(it.id, "【译】" + zh.repeat(Math.ceil(n / zh.length)).slice(0, n));
  }
  const orig = await PDFLib.PDFDocument.load(pdfBytes);
  const origPages = orig.getPageCount();
  const ow = orig.getPage(1).getWidth();
  for (const mode of ["inplace", "dual"]) {
    const t0 = Date.now();
    const bytes = await PdfExport.build({ pdfBytes, contentList, translations, mode, fontPath: font.path });
    const ms = Date.now() - t0;
    const file = path.join(outDir, `demo-${mode}.pdf`);
    fs.writeFileSync(file, bytes);
    console.log(`${mode}: ${ms} ms, ${(bytes.length / 1e6).toFixed(2)} MB`);
    const doc = await PDFLib.PDFDocument.load(bytes);
    check(doc.getPageCount() === origPages, `${mode}: page count ${origPages}`);
    if (mode === "dual") check(Math.abs(doc.getPage(1).getWidth() - 2 * ow) < 0.5, "dual: page width = 2x original");
    else check(Math.abs(doc.getPage(1).getWidth() - ow) < 0.5, "inplace: page width unchanged");
    const limit = pdfBytes.length * 3 + 6e6;
    check(bytes.length < limit, `${mode}: size ${(bytes.length / 1e6).toFixed(2)} MB < ${(limit / 1e6).toFixed(1)} MB`);
    check(ms < 20000, `${mode}: build time ${ms} ms`);
    if (have("pdftotext")) {
      const t = pdftotext(file, 2);
      const han = (t.match(/[一-鿿]/g) || []).length;
      check(han > 50 && t.includes("注意力"), `${mode}: pdftotext page 2 has ${han} Chinese chars`);
    }
    png(file, 2, `demo-${mode}-p2`);
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
