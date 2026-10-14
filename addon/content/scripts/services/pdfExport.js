/* Translated-PDF export without external services: pdf-lib + @pdf-lib/fontkit (vendored) and a CJK system font.
 * In-place: white boxes over translated blocks + fitted translated text. Dual: original | translated side by side.
 * Only unrotated pages (/Rotate 0) are typeset; rotated pages are copied untouched.
 * License: AGPL-3.0-or-later */
/* global DeepRead, Services, IOUtils, PathUtils */

DeepRead.PdfExport = (function () {
  const api = {
    _libs: null,
    _fontCache: new Map(),
    MIN_FONT_SIZE: 5,
  };

  /* ---------------- library loading ---------------- */

  api.libs = function () {
    if (!api._libs) {
      const scope = {};
      Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/pdf-lib/pdf-lib.min.js`, scope);
      Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/pdf-lib/fontkit.umd.min.js`, scope);
      api._libs = {
        PDFLib: scope.PDFLib || globalThis.PDFLib,
        fontkit: scope.fontkit || globalThis.fontkit,
      };
      if (!api._libs.PDFLib || !api._libs.fontkit) throw new Error("pdf-lib / fontkit failed to load");
    }
    return api._libs;
  };

  /* ---------------- font discovery ---------------- */

  const FONT_CANDIDATES = [
    // Linux
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/arphic/ukai.ttc",
    // Droid Sans Fallback: fontkit garbles its subset, so it is embedded whole (see build()); last resort.
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    // Windows
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "C:\\Windows\\Fonts\\Deng.ttf",
    // macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
  ];
  const FONT_DIR_PATTERN = /(CJK|[-_ ]SC|SC[-_.]|Hei|Song|YaHei|Ming|Kai|Fallback)/i;

  function fontName(path) {
    return String(path).split(/[\\/]/).pop();
  }

  async function exists(path) {
    try {
      return await IOUtils.exists(path);
    }
    catch (e) {
      return false;
    }
  }

  /**
   * True for OpenType fonts with CFF outlines ("OTTO", e.g. Noto Sans/Serif CJK): pdf-lib/fontkit cannot subset-embed
   * them into a valid PDF font (poppler: "Embedded font file may be invalid"). Only TrueType (glyf) fonts work.
   */
  async function isCFF(path) {
    try {
      const head = await IOUtils.read(path, { maxBytes: 4096 });
      let off = 0;
      if (head[0] === 0x74 && head[1] === 0x74 && head[2] === 0x63 && head[3] === 0x66) {
        off = ((head[12] << 24) | (head[13] << 16) | (head[14] << 8) | head[15]) >>> 0;
      }
      return head[off] === 0x4f && head[off + 1] === 0x54 && head[off + 2] === 0x54 && head[off + 3] === 0x4f;
    }
    catch (e) {
      return false;
    }
  }

  async function searchDir(dir, depth, found) {
    if (depth < 0 || found.length >= 1) return;
    let children;
    try {
      children = await IOUtils.getChildren(dir);
    }
    catch (e) {
      return;
    }
    const dirs = [];
    for (const child of children) {
      if (found.length) return;
      if (/\.(ttf|ttc|otf)$/i.test(child)) {
        if (FONT_DIR_PATTERN.test(fontName(child)) && !/(Bold|Italic|Light|Thin|Black|Mono)/i.test(fontName(child)) && !(await isCFF(child))) found.push(child);
      }
      else if (!/\.[a-z0-9]{1,5}$/i.test(child)) dirs.push(child);
    }
    for (const d of dirs) await searchDir(d, depth - 1, found);
  }

  api.findCJKFont = async function () {
    let pref = "";
    try {
      pref = DeepRead.prefs.get("translate.fontPath") || "";
    }
    catch (e) { /* pref missing */ }
    if (pref && await exists(pref)) return { path: pref, name: fontName(pref) };
    for (const path of FONT_CANDIDATES) {
      if (await exists(path) && !(await isCFF(path))) return { path, name: fontName(path) };
    }
    for (const dir of ["/usr/share/fonts", "/usr/local/share/fonts"]) {
      const found = [];
      await searchDir(dir, 4, found);
      if (found.length) return { path: found[0], name: fontName(found[0]) };
    }
    return null;
  };

  /* ---------------- TTC -> standalone sfnt ---------------- */

  function tagOf(view, off) {
    return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  }

  /** Concatenated name strings (IDs 1, 4, 16) of the font whose table directory is at `fontOff`. */
  function fontNames(bytes, view, fontOff) {
    const numTables = view.getUint16(fontOff + 4);
    for (let i = 0; i < numTables; i++) {
      const rec = fontOff + 12 + i * 16;
      if (tagOf(view, rec) !== "name") continue;
      const tOff = view.getUint32(rec + 8);
      const count = view.getUint16(tOff + 2);
      const strOff = tOff + view.getUint16(tOff + 4);
      const names = [];
      for (let n = 0; n < count; n++) {
        const r = tOff + 6 + n * 12;
        const platform = view.getUint16(r), id = view.getUint16(r + 6);
        if (id !== 1 && id !== 4 && id !== 16) continue;
        const len = view.getUint16(r + 8), off = strOff + view.getUint16(r + 10);
        let s = "";
        if (platform === 3 || platform === 0) {
          for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(view.getUint16(off + k));
        }
        else for (let k = 0; k < len; k++) s += String.fromCharCode(bytes[off + k]);
        names.push(s);
      }
      return names.join(" | ");
    }
    return "";
  }

  function checksum(bytes, start, length) {
    let sum = 0;
    const end = start + length;
    for (let i = start; i < end; i += 4) {
      const v = ((bytes[i] << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0)) >>> 0;
      sum = (sum + v) >>> 0;
    }
    return sum;
  }

  /** Pull one font out of a TrueType Collection as a standalone sfnt (Uint8Array). Prefers Simplified Chinese. */
  api.extractFromTTC = function (bytes, preferIndex) {
    if (bytes[0] !== 0x74 || bytes[1] !== 0x74 || bytes[2] !== 0x63 || bytes[3] !== 0x66) return bytes; // not 'ttcf'
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numFonts = view.getUint32(8);
    const offsets = [];
    for (let i = 0; i < numFonts; i++) offsets.push(view.getUint32(12 + i * 4));
    let index = 0;
    if (Number.isInteger(preferIndex) && preferIndex >= 0 && preferIndex < numFonts) index = preferIndex;
    else {
      // Pick the face that looks Simplified Chinese; plain "Sans"/"Serif CJK SC" before "Mono" variants.
      let best = -1;
      offsets.forEach((off, i) => {
        const n = fontNames(bytes, view, off);
        let score = 0;
        if (/\bSC\b|Simplified|简|YaHei|雅黑|\bCN\b|PingFang SC|Heiti SC|SimSun|SimHei|宋体|黑体|MicroHei|微米黑|ZenHei|正黑|文泉驿/i.test(n)) score += 10;
        if (/Mono/i.test(n)) score -= 5;
        if (/\b(TC|HK|JP|KR)\b/.test(n)) score -= 3;
        if (score > best) { best = score; index = i; }
      });
    }
    const fontOff = offsets[index];
    const sfntVersion = view.getUint32(fontOff);
    const numTables = view.getUint16(fontOff + 4);
    const tables = [];
    for (let i = 0; i < numTables; i++) {
      const rec = fontOff + 12 + i * 16;
      tables.push({ tag: tagOf(view, rec), offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) });
    }
    tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    const headerLen = 12 + numTables * 16;
    let total = headerLen;
    for (const t of tables) { t.newOffset = total; total += (t.length + 3) & ~3; }
    const out = new Uint8Array(total);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, sfntVersion);
    ov.setUint16(4, numTables);
    let pow = 1, log = 0;
    while (pow * 2 <= numTables) { pow *= 2; log++; }
    ov.setUint16(6, pow * 16);
    ov.setUint16(8, log);
    ov.setUint16(10, numTables * 16 - pow * 16);
    let headOffset = -1;
    tables.forEach((t, i) => {
      out.set(bytes.subarray(t.offset, t.offset + t.length), t.newOffset);
      if (t.tag === "head" && t.length >= 12) {
        headOffset = t.newOffset;
        ov.setUint32(t.newOffset + 8, 0); // checkSumAdjustment zeroed before checksumming
      }
      const rec = 12 + i * 16;
      for (let k = 0; k < 4; k++) out[rec + k] = t.tag.charCodeAt(k);
      ov.setUint32(rec + 4, checksum(out, t.newOffset, (t.length + 3) & ~3));
      ov.setUint32(rec + 8, t.newOffset);
      ov.setUint32(rec + 12, t.length);
    });
    if (headOffset >= 0) {
      const whole = checksum(out, 0, total);
      ov.setUint32(headOffset + 8, (0xB1B0AFBA - whole) >>> 0);
    }
    return out;
  };

  /* ---------------- text layout ---------------- */

  const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
  const NO_LINE_START = /[，。、；：！？）」』》】〕”’,.;:!?)\]}%、。，．！？：；）】》」』]/;
  const NO_LINE_END = /[（「『《【〔“‘([{]/;

  /** Splits text into unbreakable units: each CJK char, each run of other non-space chars (word), spaces. */
  function tokenize(text) {
    const tokens = [];
    let word = "";
    const flush = () => { if (word) { tokens.push({ s: word, space: false }); word = ""; } };
    for (const ch of text) {
      if (ch === " " || ch === "\t") { flush(); tokens.push({ s: " ", space: true }); }
      else if (CJK_RE.test(ch)) { flush(); tokens.push({ s: ch, space: false, cjk: true }); }
      else word += ch;
    }
    flush();
    return tokens;
  }

  function makeMeasurer(font, charset) {
    const cache = new Map();
    const glyph = (ch) => {
      let w = cache.get(ch);
      if (w === undefined) {
        try {
          w = font.widthOfTextAtSize(ch, 1);
        }
        catch (e) {
          w = font.widthOfTextAtSize("?", 1);
        }
        cache.set(ch, w);
      }
      return w;
    };
    const width = (s, size) => {
      let w = 0;
      for (const ch of s) w += glyph(ch);
      return w * size;
    };
    return { width };
  }

  /** Greedy wrap into lines no wider than `maxW`. */
  function wrap(paragraphs, measure, size, maxW) {
    const lines = [];
    for (const para of paragraphs) {
      const tokens = tokenize(para);
      let line = "", lineW = 0;
      for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        if (tk.space) {
          if (line) { line += " "; lineW += measure.width(" ", size); }
          continue;
        }
        const w = measure.width(tk.s, size);
        if (line && lineW + w > maxW + 0.01) {
          const prev = line.replace(/ $/, "");
          // Kinsoku: a closing mark may hang at the end of the line rather than start the next one.
          if (tk.cjk && NO_LINE_START.test(tk.s) && lineW + w <= maxW * 1.08) {
            line += tk.s; lineW += w; continue;
          }
          // Do not leave an opening bracket stranded at line end.
          const last = prev.slice(-1);
          let carry = "";
          if (tokens[i - 1] && !tokens[i - 1].space && NO_LINE_END.test(last) && prev.length > 1) {
            carry = last;
            line = prev.slice(0, -1);
          }
          else line = prev;
          lines.push(line);
          line = carry; lineW = measure.width(carry, size);
        }
        if (w > maxW && !line) {
          // Over-long single word: break per character.
          for (const ch of tk.s) {
            const cw = measure.width(ch, size);
            if (line && lineW + cw > maxW) { lines.push(line); line = ""; lineW = 0; }
            line += ch; lineW += cw;
          }
          continue;
        }
        line += tk.s; lineW += w;
      }
      lines.push(line.replace(/ $/, ""));
    }
    return lines;
  }

  /**
   * Largest font size in [minSize, startSize] (0.25 pt steps) whose wrapped text fits `w` x `h`.
   * Returns { size, lines, lineHeight, fits }.
   */
  api.fitText = function (text, measure, w, h, startSize, minSize, leading) {
    const paragraphs = String(text).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const lead = leading || 1.18;
    let size = startSize;
    for (; size >= minSize - 1e-6; size -= 0.25) {
      const lines = wrap(paragraphs, measure, size, w);
      if (lines.length * size * lead <= h + 0.01) return { size, lines, lineHeight: size * lead, fits: true };
    }
    const s = minSize;
    const lines = wrap(paragraphs, measure, s, w);
    return { size: s, lines, lineHeight: s * lead, fits: false };
  };

  function startSizeFor(item, w, h) {
    const len = Math.max(8, String(item.text || "").length);
    const est = Math.sqrt((w * h) / (0.58 * len));
    if (item.text_level) return Math.min(24, Math.max(9, Math.min(est, h * 0.85)));
    return Math.min(13, Math.max(6.5, est));
  }

  /* ---------------- build ---------------- */

  function translationOf(translations, item, index) {
    if (!translations) return "";
    const id = item.id !== undefined ? item.id : index;
    const v = translations instanceof Map ? translations.get(id) : translations[id];
    if (v && typeof v === "object") return String(v.text || v.translated_text || "");
    return v ? String(v) : "";
  }

  function pageBox(page) {
    let box;
    try {
      box = page.getCropBox();
    }
    catch (e) { /* fall through */ }
    if (!box || !(box.width > 0 && box.height > 0)) box = page.getMediaBox();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  async function loadFontBytes(fontPath) {
    if (api._fontCache.has(fontPath)) return api._fontCache.get(fontPath);
    const raw = new Uint8Array(await IOUtils.read(fontPath)); // same-realm copy, see build()
    const bytes = /\.ttc$/i.test(fontPath) || (raw[0] === 0x74 && raw[1] === 0x74 && raw[2] === 0x63 && raw[3] === 0x66)
      ? api.extractFromTTC(raw)
      : raw;
    if (bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
      throw new Error(`Font ${fontName(fontPath)} has CFF outlines (OpenType/CFF); choose a TrueType-outline CJK font (e.g. WenQuanYi, Microsoft YaHei, SimSun, PingFang)`);
    }
    api._fontCache.clear();
    api._fontCache.set(fontPath, bytes);
    return bytes;
  }

  /** Draws white boxes then fitted text for `blocks` (page space rects) on `page`, shifted by (dx, dy). */
  function paintBlocks(page, blocks, { rgb, font, measure, dx, dy, clip }) {
    const white = rgb(1, 1, 1), black = rgb(0, 0, 0);
    for (const b of blocks) {
      page.drawRectangle({ x: b.x - 1 + dx, y: b.y - 1 + dy, width: b.w + 2, height: b.h + 2, color: white, borderWidth: 0 });
    }
    for (const b of blocks) {
      const fit = api.fitText(b.text, measure, b.w, b.h, b.startSize, api.MIN_FONT_SIZE);
      let y = b.y + b.h - fit.size * 0.96; // baseline of first line (top of box)
      for (const line of fit.lines) {
        if (line) {
          const opts = { x: b.x + dx, y: y + dy, size: fit.size, font, color: black };
          page.drawText(line, opts);
          if (b.bold) page.drawText(line, { ...opts, x: opts.x + fit.size * 0.025 + 0.15 });
        }
        y -= fit.lineHeight;
      }
    }
  }

  api.build = async function ({ pdfBytes, contentList, translations, mode, fontPath, onProgress } = {}) {
    const { PDFLib, fontkit } = api.libs();
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const report = (done, total, message) => {
      if (onProgress) try { onProgress({ done, total, message }); } catch (e) { /* ignore */ }
    };
    if (!pdfBytes) throw new Error("pdfBytes required");
    mode = mode === "dual" ? "dual" : "inplace";

    // IOUtils hands out typed arrays from another realm; pdf-lib checks `instanceof Uint8Array`.
    pdfBytes = new Uint8Array(pdfBytes);
    const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const srcPages = src.getPages();
    const total = srcPages.length;

    // One shared font for the whole output; embedded once, subset.
    const out = mode === "dual" ? await PDFDocument.create() : src;
    let font, fontLabel;
    if (!fontPath) {
      const found = await api.findCJKFont();
      fontPath = found && found.path;
    }
    if (fontPath) {
      out.registerFontkit(fontkit);
      const bytes = await loadFontBytes(fontPath);
      // fontkit mangles subsets of Droid Sans Fallback (wide gaps, wrong glyphs); embed it whole.
      font = await out.embedFont(bytes, { subset: !/Droid/i.test(fontPath) });
      fontLabel = fontName(fontPath);
    }
    else {
      DeepRead.log("PdfExport: no CJK font found, falling back to Helvetica (non-Latin text becomes '?')");
      font = await out.embedFont(StandardFonts.Helvetica);
      fontLabel = "Helvetica";
    }
    const latinOnly = !fontPath ? new Set(font.getCharacterSet()) : null;
    const measureBase = makeMeasurer(font);
    const measure = latinOnly
      ? { width: (s, size) => measureBase.width(sanitizeLatin(s, latinOnly), size) }
      : measureBase;

    // Group translated blocks per page.
    const byPage = new Map();
    (contentList || []).forEach((item, index) => {
      if (!item || !Array.isArray(item.bbox) || item.bbox.length < 4) return;
      let text = translationOf(translations, item, index);
      if (!text.trim()) return;
      if (latinOnly) text = sanitizeLatin(text, latinOnly);
      const p = item.page_idx | 0;
      if (p < 0 || p >= total) return;
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push({ item, text });
    });

    const blocksFor = (pageIndex, box) => {
      const list = byPage.get(pageIndex) || [];
      return list.map(({ item, text }) => {
        const [b0, b1, b2, b3] = item.bbox.map(Number);
        const x = box.x + (Math.min(b0, b2) / 1000) * box.width;
        const w = (Math.abs(b2 - b0) / 1000) * box.width;
        const h = (Math.abs(b3 - b1) / 1000) * box.height;
        const top = box.y + box.height - (Math.min(b1, b3) / 1000) * box.height;
        return {
          x, y: top - h, w, h, text,
          bold: !!item.text_level,
          startSize: startSizeFor(item, w, h),
        };
      }).filter((b) => b.w > 4 && b.h > 3);
    };

    const t0 = Date.now();
    if (mode === "inplace") {
      for (let i = 0; i < total; i++) {
        const page = srcPages[i];
        const box = pageBox(page);
        if (page.getRotation().angle % 360 === 0) {
          paintBlocks(page, blocksFor(i, box), { rgb, font, measure, dx: 0, dy: 0 });
        }
        else DeepRead.log(`PdfExport: page ${i + 1} is rotated; left untranslated`);
        report(i + 1, total, `page ${i + 1}/${total}`);
        if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
      }
      DeepRead.log(`PdfExport inplace: ${total} pages in ${Date.now() - t0} ms (font ${fontLabel})`);
      return await out.save({ useObjectStreams: true });
    }

    // dual
    const boxes = srcPages.map(pageBox);
    const embedded = await out.embedPages(srcPages, boxes.map((b) => ({ left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height })));
    for (let i = 0; i < total; i++) {
      const box = boxes[i];
      const page = out.addPage([box.width * 2, box.height]);
      page.drawPage(embedded[i], { x: 0, y: 0 });
      page.drawPage(embedded[i], { x: box.width, y: 0 });
      if (srcPages[i].getRotation().angle % 360 === 0) {
        // Blocks are computed in the cropbox frame; re-base to origin (0,0), then shift to the right half.
        const local = { x: 0, y: 0, width: box.width, height: box.height };
        paintBlocks(page, blocksFor(i, local), { rgb, font, measure, dx: box.width, dy: 0 });
      }
      report(i + 1, total, `page ${i + 1}/${total}`);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    DeepRead.log(`PdfExport dual: ${total} pages in ${Date.now() - t0} ms (font ${fontLabel})`);
    return await out.save({ useObjectStreams: true });
  };

  function sanitizeLatin(s, charset) {
    let r = "";
    const set = charset instanceof Set ? charset : new Set(charset);
    for (const ch of s) r += ch === "\n" || set.has(ch.codePointAt(0)) ? ch : "?";
    return r;
  }

  return api;
})();
