/*
 * PDF structure parsing via a local GROBID service (provider "grobid").
 * GROBID returns TEI XML; with `teiCoordinates` every element carries `coords="page,x,y,w,h[;...]"` (page 1-based,
 * PDF points, top-left origin). This module converts the TEI into a MinerU-style content list (per-mille boxes).
 *
 *   await DeepRead.GrobidParser.parse({ filePath, config, onStatus, signal }) → { contentList, markdown }
 *   DeepRead.GrobidParser.teiToContentList(xml, { DOMParser }) → { contentList, markdown, summary }   (pure)
 *   await DeepRead.GrobidParser.testConnection(config) → { ok, message }
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, IOUtils, PathUtils, fetch, Blob, FormData, AbortController, setTimeout, clearTimeout */

(function () {
  const TEI_NS = "http://www.tei-c.org/ns/1.0";
  const TIMEOUT_MS = 10 * 60 * 1000;
  const COORD_ELEMENTS = ["head", "p", "s", "figure", "formula", "title", "biblStruct", "note"];

  // ---- small helpers --------------------------------------------------------

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const ln = (n) => n && n.localName;
  const kids = (el, name) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && (!name || ln(n) === name));
  const first = (el, name) => kids(el, name)[0] || null;

  function descendants(el, name) {
    const out = [];
    const walk = (n) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType !== 1) continue;
        if (ln(c) === name) out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  }

  /** Text of an element, skipping descendants whose localName is in `skip`. */
  function textOf(el, skip) {
    let out = "";
    const walk = (n) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === 3 || c.nodeType === 4) out += c.nodeValue;
        else if (c.nodeType === 1 && !(skip && skip.includes(ln(c)))) walk(c);
      }
    };
    walk(el);
    return norm(out);
  }

  /** "p,x,y,w,h;..." → [{page,x,y,w,h}] */
  function parseCoords(attr) {
    const out = [];
    for (const part of String(attr || "").split(";")) {
      const v = part.split(",").map((s) => parseFloat(s));
      if (v.length >= 5 && v.slice(0, 5).every((x) => Number.isFinite(x))) {
        out.push({ page: v[0], x: v[1], y: v[2], w: v[3], h: v[4] });
      }
    }
    return out;
  }

  const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));

  /** Group boxes by page and union them → Map(page → [x0,y0,x1,y1] in points). */
  function unionByPage(boxes) {
    const m = new Map();
    for (const b of boxes) {
      const r = m.get(b.page);
      const x1 = b.x + b.w;
      const y1 = b.y + b.h;
      if (!r) m.set(b.page, [b.x, b.y, x1, y1]);
      else {
        r[0] = Math.min(r[0], b.x);
        r[1] = Math.min(r[1], b.y);
        r[2] = Math.max(r[2], x1);
        r[3] = Math.max(r[3], y1);
      }
    }
    return m;
  }

  function pageSizes(doc) {
    const sizes = new Map();
    for (const s of descendants(doc.documentElement, "surface")) {
      const n = parseInt(s.getAttribute("n"), 10);
      const w = parseFloat(s.getAttribute("lrx")) - (parseFloat(s.getAttribute("ulx")) || 0);
      const h = parseFloat(s.getAttribute("lry")) - (parseFloat(s.getAttribute("uly")) || 0);
      if (n > 0 && w > 0 && h > 0) sizes.set(n, { w, h });
    }
    return sizes;
  }

  // ---- conversion -----------------------------------------------------------

  class Converter {
    constructor(doc) {
      this.doc = doc;
      this.sizes = pageSizes(doc);
      this.items = [];
      this.summary = { skippedNoCoords: 0, skippedNoPage: 0, kept: 0, skippedTypes: {} };
    }

    skip(kind, reason) {
      this.summary[reason === "page" ? "skippedNoPage" : "skippedNoCoords"]++;
      this.summary.skippedTypes[kind] = (this.summary.skippedTypes[kind] || 0) + 1;
    }

    /** Boxes → [{ page_idx, bbox }] one per page (sorted by page). */
    pageBoxes(boxes) {
      const out = [];
      const u = unionByPage(boxes);
      for (const page of Array.from(u.keys()).sort((a, b) => a - b)) {
        const size = this.sizes.get(page);
        if (!size) continue;
        const r = u.get(page);
        out.push({
          page,
          page_idx: page - 1,
          area: Math.max(1, (r[2] - r[0]) * (r[3] - r[1])),
          bbox: [clamp(r[0] / size.w * 1000), clamp(r[1] / size.h * 1000), clamp(r[2] / size.w * 1000), clamp(r[3] / size.h * 1000)],
        });
      }
      return out;
    }

    push(item) {
      this.items.push(item);
      this.summary.kept++;
    }

    /**
     * Emit a text-like item (type text/equation) for an element's coords. Several pages → one item per page; the text
     * is split by `sentences` ([{text, boxes}]) when given, otherwise proportionally to the box areas.
     */
    emitText(kind, base, text, boxes, sentences) {
      if (!text) return;
      if (!boxes.length && sentences && sentences.length) boxes = sentences.flatMap((s) => s.boxes);
      if (!boxes.length) return this.skip(kind);
      const parts = this.pageBoxes(boxes);
      if (!parts.length) return this.skip(kind, "page");
      if (parts.length === 1) return this.push({ ...base, text, bbox: parts[0].bbox, page_idx: parts[0].page_idx });

      const texts = parts.map(() => "");
      const withS = sentences && sentences.filter((s) => s.boxes.length);
      if (withS && withS.length >= parts.length) {
        for (const s of withS) {
          const pg = s.boxes[0].page;
          let k = parts.findIndex((p) => p.page === pg);
          if (k < 0) k = 0;
          texts[k] += (texts[k] ? " " : "") + s.text;
        }
      }
      else {
        const words = text.split(" ");
        const total = parts.reduce((a, p) => a + p.area, 0);
        let at = 0;
        parts.forEach((p, i) => {
          const n = i === parts.length - 1 ? words.length - at : Math.round(words.length * p.area / total);
          texts[i] = words.slice(at, at + n).join(" ");
          at += n;
        });
      }
      parts.forEach((p, i) => {
        if (texts[i]) this.push({ ...base, text: texts[i], bbox: p.bbox, page_idx: p.page_idx });
      });
    }

    sentencesOf(p) {
      return kids(p, "s").map((s) => ({ text: textOf(s), boxes: parseCoords(s.getAttribute("coords")) })).filter((s) => s.text);
    }

    heading(text, boxes, kind) {
      this.emitText(kind || "head", { type: "text", text_level: 1 }, text, boxes);
    }

    /** A heading without its own coordinates: place a thin strip right above `anchorBoxes`' first box. */
    syntheticHeading(text, anchorBoxes) {
      const parts = this.pageBoxes(anchorBoxes.slice(0, 1));
      if (!parts.length) return;
      const b = parts[0].bbox;
      const bottom = Math.max(14, b[1] - 6);
      this.push({ type: "text", text, text_level: 1, bbox: [b[0], Math.max(0, bottom - 18), Math.min(1000, b[0] + 200), bottom], page_idx: parts[0].page_idx });
    }

    paragraph(p) {
      const text = textOf(p);
      this.emitText("p", { type: "text" }, text, parseCoords(p.getAttribute("coords")), this.sentencesOf(p));
    }

    formula(f) {
      const label = first(f, "label");
      const labelText = label ? textOf(label) : "";
      let text = textOf(f, ["label"]);
      if (!text) return;
      if (labelText) text += ` ${labelText}`;
      this.emitText("formula", { type: "equation", text_format: "text" }, text, parseCoords(f.getAttribute("coords")));
    }

    captionOf(fig) {
      const head = first(fig, "head");
      const desc = first(fig, "figDesc");
      return norm([head ? textOf(head) : "", desc ? textOf(desc, ["table"]) : ""].filter(Boolean).join(" "));
    }

    figure(fig) {
      const boxes = parseCoords(fig.getAttribute("coords"));
      const isTable = fig.getAttribute("type") === "table" || !!first(fig, "table");
      const caption = this.captionOf(fig);
      if (!boxes.length) return this.skip(isTable ? "table" : "figure");
      const parts = this.pageBoxes(boxes);
      if (!parts.length) return this.skip(isTable ? "table" : "figure", "page");
      const loc = { bbox: parts[0].bbox, page_idx: parts[0].page_idx };
      if (isTable) {
        const table = first(fig, "table");
        const rows = table
          ? descendants(table, "row").map((r) => kids(r, "cell").map((c) => textOf(c)).join(" | ")).filter((r) => r.replace(/[\s|]/g, ""))
          : [];
        this.push({ type: "table", img_path: "", table_caption: caption ? [caption] : [], table_footnote: [], table_body: rows.join("\n"), ...loc });
      }
      else {
        this.push({ type: "image", img_path: "", image_caption: caption ? [caption] : [], image_footnote: [], ...loc });
      }
    }

    note(n) {
      this.emitText("note", { type: "text" }, textOf(n), parseCoords(n.getAttribute("coords")), this.sentencesOf(n));
    }

    /** Walk a div (and nested divs) in document order. */
    div(div) {
      for (const c of kids(div)) {
        switch (ln(c)) {
          case "head": {
            const n = norm(c.getAttribute("n"));
            let t = textOf(c);
            if (!t) break;
            if (n && !t.startsWith(n)) t = `${n} ${t}`;
            this.heading(t, parseCoords(c.getAttribute("coords")));
            break;
          }
          case "p": this.paragraph(c); break;
          case "formula": this.formula(c); break;
          case "figure": this.figure(c); break;
          case "note": this.note(c); break;
          case "div": this.div(c); break;
          case "listBibl": break;
          default: break;
        }
      }
    }

    // ---- sections ----

    title() {
      const root = this.doc.documentElement;
      const titles = descendants(first(root, "teiHeader") || root, "title");
      const t = titles.find((x) => x.getAttribute("type") === "main" && ln(x.parentNode) === "titleStmt")
        || titles.find((x) => x.getAttribute("type") === "main");
      if (!t) return;
      this.heading(textOf(t), parseCoords(t.getAttribute("coords")), "title");
    }

    abstract() {
      const root = this.doc.documentElement;
      const abs = descendants(first(root, "teiHeader") || root, "abstract")[0];
      if (!abs) return;
      const paras = descendants(abs, "p");
      const allBoxes = paras.flatMap((p) => parseCoords(p.getAttribute("coords")).concat(this.sentencesOf(p).flatMap((s) => s.boxes)));
      if (!allBoxes.length) return this.skip("abstract");
      const head = descendants(abs, "head")[0];
      const headBoxes = head ? parseCoords(head.getAttribute("coords")) : [];
      if (headBoxes.length) this.heading(textOf(head) || "Abstract", headBoxes);
      else this.syntheticHeading("Abstract", allBoxes);
      for (const c of descendants(abs, "div").length ? descendants(abs, "div") : [abs]) {
        for (const p of kids(c, "p")) this.paragraph(p);
      }
    }

    body() {
      const body = descendants(this.doc.documentElement, "body")[0];
      if (body) this.div(body);
    }

    refText(b) {
      const analytic = first(b, "analytic");
      const monogr = first(b, "monogr");
      const authorsOf = (el) => (el ? kids(el, "author") : []).map((a) => {
        const pn = first(a, "persName") || a;
        const fn = kids(pn, "forename").map((f) => textOf(f)).filter(Boolean).join(" ");
        const sn = first(pn, "surname");
        return norm(`${fn} ${sn ? textOf(sn) : ""}`) || textOf(a);
      }).filter(Boolean);
      const authors = authorsOf(analytic).length ? authorsOf(analytic) : authorsOf(monogr);
      const titleEl = (analytic && first(analytic, "title")) || (monogr && first(monogr, "title"));
      const venueEl = analytic && monogr ? first(monogr, "title") : null;
      const date = monogr ? descendants(monogr, "date")[0] : null;
      const year = date ? (date.getAttribute("when") || textOf(date)).slice(0, 4) : "";
      const parts = [];
      if (authors.length) parts.push(authors.join(", "));
      if (titleEl) parts.push(textOf(titleEl));
      const venue = [venueEl ? textOf(venueEl) : "", year].filter(Boolean).join(", ");
      if (venue) parts.push(venue);
      const out = parts.join(". ");
      return out ? `${out}.` : textOf(b);
    }

    back() {
      const back = descendants(this.doc.documentElement, "back")[0];
      if (!back) return;
      const refs = [];
      for (const d of kids(back, "div")) {
        const hasBib = descendants(d, "biblStruct").length > 0;
        if (hasBib || d.getAttribute("type") === "references") refs.push(...descendants(d, "biblStruct"));
        else this.div(d);
      }
      for (const lb of kids(back, "listBibl")) refs.push(...descendants(lb, "biblStruct"));
      const withBoxes = refs.filter((b) => parseCoords(b.getAttribute("coords")).length);
      this.summary.skippedTypes.biblStruct = refs.length - withBoxes.length || undefined;
      if (!withBoxes.length) return;
      this.syntheticHeading("References", parseCoords(withBoxes[0].getAttribute("coords")));
      for (const b of withBoxes) {
        this.emitText("biblStruct", { type: "text" }, this.refText(b), parseCoords(b.getAttribute("coords")));
      }
    }
  }

  function toMarkdown(items) {
    const out = [];
    for (const it of items) {
      if (it.type === "text") out.push(it.text_level ? `${"#".repeat(it.text_level)} ${it.text}` : it.text);
      else if (it.type === "equation") out.push(`$$${it.text}$$`);
      else if (it.type === "image") {
        for (const c of it.image_caption) out.push(`*${c}*`);
      }
      else if (it.type === "table") {
        for (const c of it.table_caption) out.push(`*${c}*`);
        if (it.table_body) out.push(it.table_body);
      }
    }
    return out.join("\n\n");
  }

  function teiToContentList(xml, { DOMParser: DP } = {}) {
    const Parser = DP || globalThis.DOMParser;
    if (!Parser) throw new Error("GROBID: no DOMParser available to parse TEI");
    const text = String(xml || "");
    if (!/<TEI[\s>]/.test(text)) throw new Error("GROBID: response is not TEI XML");
    const doc = new Parser().parseFromString(text, "application/xml");
    const root = doc && doc.documentElement;
    if (!root || ln(root) === "parsererror" || (doc.getElementsByTagName && doc.getElementsByTagName("parsererror").length)) {
      throw new Error(`GROBID: TEI XML could not be parsed: ${norm(root && root.textContent).slice(0, 200)}`);
    }
    if (ln(root) !== "TEI") throw new Error("GROBID: response is not TEI XML");
    const c = new Converter(doc);
    c.title();
    c.abstract();
    c.body();
    c.back();
    const contentList = c.items;
    c.summary.pages = c.sizes.size;
    return { contentList, markdown: toMarkdown(contentList), summary: c.summary };
  }

  // ---- service client -------------------------------------------------------

  function baseURL(config) {
    const raw = String((config && (config.grobidURL || config.grobidUrl)) || (typeof DeepRead !== "undefined" && DeepRead.prefs && DeepRead.prefs.get && DeepRead.prefs.get("parser.grobidURL")) || "http://127.0.0.1:8070");
    return raw.trim().replace(/\/+$/, "");
  }

  async function excerpt(resp) {
    try {
      return (await resp.text()).replace(/\s+/g, " ").slice(0, 500);
    }
    catch (e) {
      return "";
    }
  }

  /** AbortSignal combining the caller's signal with a deadline. */
  function deadline(signal, ms) {
    const ac = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, ms);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ac.signal,
      get timedOut() { return timedOut; },
      clear() {
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  function abortError() {
    const e = new Error("Aborted");
    e.name = "AbortError";
    return e;
  }

  function getDOMParser() {
    try {
      const w = typeof Zotero !== "undefined" && Zotero.getMainWindow && Zotero.getMainWindow();
      if (w && w.DOMParser) return w.DOMParser;
    }
    catch (e) { /* fall through */ }
    if (globalThis.DOMParser) return globalThis.DOMParser;
    throw new Error("GROBID: no DOMParser available");
  }

  async function parse({ filePath, config, onStatus, signal } = {}) {
    const status = (phase, message) => {
      try {
        onStatus && onStatus({ phase, message });
      }
      catch (e) { /* ignore */ }
    };
    const bil = (zh, en) => (DeepRead.bilingual ? DeepRead.bilingual(zh, en) : en);
    if (signal && signal.aborted) throw abortError();
    const base = baseURL(config || (DeepRead.prefs && DeepRead.prefs.parserConfig && DeepRead.prefs.parserConfig()));
    const timeout = deadline(signal, TIMEOUT_MS);
    try {
      status("upload", bil("上传 PDF 至 GROBID…", "Uploading PDF to GROBID…"));
      let bytes;
      try {
        bytes = await IOUtils.read(filePath);
      }
      catch (e) {
        throw new Error(`GROBID read PDF failed: ${e && e.message || e}`);
      }
      let name = (typeof PathUtils !== "undefined" && PathUtils.filename(filePath)) || "document.pdf";
      if (!/\.pdf$/i.test(name)) name += ".pdf";
      const form = new FormData();
      form.append("input", new Blob([bytes], { type: "application/pdf" }), name);
      for (const el of COORD_ELEMENTS) form.append("teiCoordinates", el);
      form.append("consolidateHeader", "0");
      form.append("consolidateCitations", "0");
      form.append("segmentSentences", "1");

      status("running", bil("GROBID 解析中…", "GROBID is parsing…"));
      let resp;
      try {
        resp = await fetch(`${base}/api/processFulltextDocument`, { method: "POST", body: form, signal: timeout.signal });
      }
      catch (e) {
        if (signal && signal.aborted) throw abortError();
        if (timeout.timedOut) throw new Error("GROBID process document failed: timed out after 10 minutes");
        if (e && e.name === "AbortError") throw e;
        throw new Error(`GROBID process document failed: network error: ${e && e.message || e} (is the service running at ${base}? try scripts/grobid.sh start)`);
      }
      if (!resp.ok) {
        const body = await excerpt(resp);
        const hint = resp.status === 503 ? " (GROBID is busy or still starting; retry shortly)" : "";
        throw new Error(`GROBID process document failed: HTTP ${resp.status} ${resp.statusText || ""} ${body}${hint}`.replace(/\s+/g, " "));
      }
      let xml;
      try {
        xml = await resp.text();
      }
      catch (e) {
        if (signal && signal.aborted) throw abortError();
        throw new Error(`GROBID read response failed: ${e && e.message || e}`);
      }
      status("extract", bil("读取解析结果…", "Reading parse results…"));
      if (!/<TEI[\s>]/.test(xml)) {
        throw new Error(`GROBID process document failed: response is not TEI XML: ${norm(xml).slice(0, 200)}`);
      }
      const result = teiToContentList(xml, { DOMParser: getDOMParser() });
      if (DeepRead.log) DeepRead.log("GROBID parse summary", JSON.stringify(result.summary));
      if (!result.contentList.length) {
        throw new Error("GROBID returned no blocks with coordinates (is teiCoordinates supported by this server version?)");
      }
      return { contentList: result.contentList, markdown: result.markdown };
    }
    finally {
      timeout.clear();
    }
  }

  async function testConnection(config) {
    try {
      const base = baseURL(config || (DeepRead.prefs && DeepRead.prefs.parserConfig && DeepRead.prefs.parserConfig()));
      const d = deadline(null, 10000);
      try {
        const alive = await fetch(`${base}/api/isalive`, { signal: d.signal });
        const aliveText = norm(await alive.text());
        if (!alive.ok || aliveText !== "true") {
          return { ok: false, message: `GROBID not ready: HTTP ${alive.status} ${aliveText.slice(0, 200)}` };
        }
        let version = "";
        try {
          const v = await fetch(`${base}/api/version`, { signal: d.signal });
          if (v.ok) version = norm(await v.text());
        }
        catch (e) { /* version is optional */ }
        return { ok: true, message: `GROBID ${version || "(unknown version)"} at ${base}` };
      }
      finally {
        d.clear();
      }
    }
    catch (e) {
      return { ok: false, message: `GROBID unreachable: ${e && e.message || e}` };
    }
  }

  const api = { parse, teiToContentList, testConnection, TEI_NS };
  if (typeof DeepRead !== "undefined") DeepRead.GrobidParser = api;
})();
