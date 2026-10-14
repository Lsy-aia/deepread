/*
 * In-reader presentation of deep-read results.
 *
 * - Passive layers inside each pdf.js page (pointer-events: none): key-point highlights,
 *   hover outlines and the Alt-hover in-place translation.
 * - Interactive paragraph cards live in the *outer* reader document (reader.html), because the
 *   reader registers capture-phase pointer handlers on the PDF window for text selection.
 *
 * Geometry: rects are PDF user-space [x1, y1, x2, y2]; they are mapped to percentages of the
 * page box through the page viewport transform, so layers stay correct while zooming.
 *
 * License: AGPL-3.0-or-later. Interaction design follows Vibero (AGPL-3.0, a Zotero fork).
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const LEVEL_COLORS = {
    2: "rgba(96, 175, 255, 0.28)", // important (blue)
    3: "rgba(239, 68, 68, 0.24)", // critical (red)
  };
  const HOVER_POINT_COLOR = "rgba(251, 191, 36, 0.32)";
  const SHOW_DELAY = 140;
  const HIDE_DELAY = 280;

  const PAGE_CSS = `
.deepread-layer { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.deepread-layer .dr-rect { position: absolute; border-radius: 2px; mix-blend-mode: multiply; }
.deepread-layer .dr-outline { position: absolute; border-radius: 4px;
  box-shadow: 0 0 0 1.5px rgba(251, 191, 36, 0.85); background: rgba(251, 191, 36, 0.06); }
.deepread-layer .dr-tbox { position: absolute; overflow: hidden; box-sizing: border-box; padding: 1px 2px;
  background: #fffef8; color: #1f2328; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0,0,0,0.05);
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif; line-height: 1.38;
  text-align: justify; white-space: pre-wrap; word-break: break-word; }
.deepread-layer .dr-tbox.dr-title { font-weight: 700; text-align: left; }
:root[data-color-scheme="dark"] .deepread-layer .dr-tbox { background: #22252a; color: #e6e6e6; }
.deepread-layer .dr-translation { position: absolute; overflow: hidden; box-sizing: border-box;
  padding: 2px 3px; border-radius: 3px; background: #fffef8; color: #1f2328;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 2px 10px rgba(0,0,0,0.12);
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif; line-height: 1.45;
  text-align: justify; white-space: pre-wrap; word-break: break-word; }
:root[data-color-scheme="dark"] .deepread-layer .dr-rect { mix-blend-mode: screen; }
:root[data-color-scheme="dark"] .deepread-layer .dr-translation { background: #22252a; color: #e6e6e6; }
`;

  const CARD_CSS = `
.deepread-card { position: fixed; z-index: 2147483000; width: 340px; max-height: 70vh; overflow: auto;
  box-sizing: border-box; padding: 10px 12px 8px; border-radius: 10px;
  background: #ffffff; color: #1f2328; border: 1px solid rgba(0,0,0,0.10);
  box-shadow: 0 8px 28px rgba(0,0,0,0.16); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.deepread-card[hidden] { display: none; }
.deepread-card .dr-head { display: flex; gap: 8px; align-items: flex-start; }
.deepread-card .dr-summary { flex: 1; font-weight: 600; font-size: 13.5px; }
.deepread-card .dr-actions { display: flex; gap: 2px; flex-shrink: 0; }
.deepread-card .dr-actions button { border: none; background: transparent; color: #57606a; cursor: pointer;
  font-size: 12px; padding: 2px 5px; border-radius: 5px; }
.deepread-card .dr-actions button:hover { background: rgba(0,0,0,0.06); color: #1f2328; }
.deepread-card ol { margin: 8px 0 2px; padding: 0; list-style: none; }
.deepread-card li { position: relative; padding: 5px 6px 5px 16px; border-radius: 6px; cursor: pointer; }
.deepread-card li::before { content: ""; position: absolute; left: 6px; top: 12px; width: 5px; height: 5px;
  border-radius: 50%; background: #8c959f; }
.deepread-card li[data-level="2"]::before { background: #3b82f6; }
.deepread-card li[data-level="3"]::before { background: #ef4444; }
.deepread-card li:hover { background: rgba(251, 191, 36, 0.16); }
.deepread-card .dr-point-summary { font-weight: 500; }
.deepread-card .dr-point-translation { color: #424a53; margin-top: 2px; }
.deepread-card .dr-foot { margin-top: 4px; font-size: 11px; color: #8c959f; }
.deepread-card .dr-hnote { margin-top: 6px; padding: 4px 8px; border-radius: 6px; border-left: 3px solid #10b981;
  background: rgba(16,185,129,0.08); white-space: pre-wrap; }
.deepread-card .dr-hnote-label { font-size: 11px; font-weight: 700; color: #047857; }
:root[data-color-scheme="dark"] .deepread-card { background: #2a2d32; color: #e6e6e6; border-color: rgba(255,255,255,0.12); }
:root[data-color-scheme="dark"] .deepread-card .dr-actions button { color: #a0a7b0; }
:root[data-color-scheme="dark"] .deepread-card .dr-actions button:hover { background: rgba(255,255,255,0.08); color: #fff; }
:root[data-color-scheme="dark"] .deepread-card .dr-point-translation { color: #c5c9cf; }
`;

  function apply(t, x, y) {
    return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  }

  function invert(t) {
    const det = t[0] * t[3] - t[1] * t[2];
    if (!det) return null;
    return [
      t[3] / det, -t[1] / det, -t[2] / det, t[0] / det,
      (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det,
    ];
  }

  function unionRect(rects) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rects) {
      x1 = Math.min(x1, r[0], r[2]);
      y1 = Math.min(y1, r[1], r[3]);
      x2 = Math.max(x2, r[0], r[2]);
      y2 = Math.max(y2, r[1], r[3]);
    }
    return Number.isFinite(x1) ? [x1, y1, x2, y2] : null;
  }

  function inRect(r, x, y, pad = 1.5) {
    return x >= Math.min(r[0], r[2]) - pad && x <= Math.max(r[0], r[2]) + pad
      && y >= Math.min(r[1], r[3]) - pad && y <= Math.max(r[1], r[3]) + pad;
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.Overlay = class Overlay {
    constructor(session) {
      this.session = session;
      this.pages = new Map(); // pageIndex → paragraphs (with bbox)
      this.options = {
        highlights: DeepRead.prefs.get("view.highlights") !== false,
        hoverCards: DeepRead.prefs.get("view.hoverCards") !== false,
        translationPopup: DeepRead.prefs.get("view.translationPopup") !== false,
      };
      this.hoverPara = null;
      this.cardPara = null;
      this.altDown = false;
      this._timers = {};
      this._cleanup = [];
      this.attached = false;
    }

    /** @param view reader._internalReader._primaryView (content object, x-ray waived) */
    attach(view) {
      this.detach();
      const pdfWin = view._iframeWindow;
      const readerWin = this.session.reader._iframeWindow;
      if (!pdfWin || !readerWin) throw new Error("reader view not ready");
      this.view = view;
      this.pdfWin = pdfWin;
      this.pdfDoc = pdfWin.document;
      this.app = (pdfWin.wrappedJSObject || pdfWin).PDFViewerApplication;
      this.readerDoc = readerWin.document;
      this.iframeEl = view._iframe;

      this._injectStyle(this.pdfDoc, "deepread-page-css", PAGE_CSS);
      this._injectStyle(this.readerDoc, "deepread-card-css", CARD_CSS);

      const onPointerMove = (event) => this._onPointerMove(event);
      const onPointerLeave = () => this._scheduleHide();
      const onKey = (event) => this._onKey(event);
      const onScroll = () => this._hideCard(true);
      this.pdfDoc.addEventListener("pointermove", onPointerMove, { passive: true });
      this.pdfDoc.documentElement.addEventListener("pointerleave", onPointerLeave);
      this.pdfWin.addEventListener("keydown", onKey, true);
      this.pdfWin.addEventListener("keyup", onKey, true);
      this.pdfWin.addEventListener("blur", onKey, true);
      const container = this.pdfDoc.getElementById("viewerContainer");
      container?.addEventListener("scroll", onScroll, { passive: true });
      this._cleanup.push(() => {
        this.pdfDoc.removeEventListener("pointermove", onPointerMove);
        this.pdfDoc.documentElement?.removeEventListener("pointerleave", onPointerLeave);
        this.pdfWin.removeEventListener("keydown", onKey, true);
        this.pdfWin.removeEventListener("keyup", onKey, true);
        this.pdfWin.removeEventListener("blur", onKey, true);
        container?.removeEventListener("scroll", onScroll);
      });

      // Re-create page layers whenever pdf.js (re)renders a page; zooming resets page DOM.
      const onRendered = Components.utils.exportFunction((event) => {
        try {
          this._renderPage(event.pageNumber - 1);
        }
        catch (e) {
          DeepRead.log("overlay pagerendered failed", String(e));
        }
      }, this.pdfWin);
      const onRotation = Components.utils.exportFunction(() => this.renderAllPages(), this.pdfWin);
      this.app.eventBus.on("pagerendered", onRendered);
      this.app.eventBus.on("rotationchanging", onRotation);
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagerendered", onRendered);
          this.app.eventBus.off("rotationchanging", onRotation);
        }
        catch (e) {}
      });

      this.attached = true;
      this.renderAllPages();
    }

    detach() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      for (const timer of Object.values(this._timers)) clearTimeout(timer);
      this._timers = {};
      if (this.pdfDoc) {
        for (const layer of this.pdfDoc.querySelectorAll(".deepread-layer")) layer.remove();
      }
      this.card?.remove();
      this.card = null;
      this.attached = false;
    }

    /**
     * Persistent in-place translation of whole blocks ("译文视图").
     * view = { contentList, translations: { [id]: text } } or null to show the original.
     */
    setTranslationView(view) {
      this.tview = null;
      if (view?.contentList && view.translations) {
        const byPage = new Map();
        for (const item of view.contentList) {
          const text = view.translations[item.id];
          if (!text || !Array.isArray(item.bbox)) continue;
          if (!byPage.has(item.page_idx)) byPage.set(item.page_idx, []);
          byPage.get(item.page_idx).push({ bbox: item.bbox, text, title: item.text_level === 1 });
        }
        this.tview = byPage;
      }
      this.renderAllPages();
    }

    /** PDF rect of a per-mille (top-left origin) bbox on a page. */
    _permilleRect(pageIndex, bbox) {
      const pageView = this.app?.pdfViewer?.getPageView(pageIndex);
      const view = pageView?.pdfPage?.view ? Array.from(pageView.pdfPage.view) : null;
      if (!view) return null;
      const w = view[2] - view[0];
      const h = view[3] - view[1];
      return [view[0] + (bbox[0] / 1000) * w, view[3] - (bbox[3] / 1000) * h, view[0] + (bbox[2] / 1000) * w, view[3] - (bbox[1] / 1000) * h];
    }

    _renderTranslationView(ctx, pageIndex) {
      ctx.tview.replaceChildren();
      const blocks = this.tview?.get(pageIndex);
      if (!blocks?.length) return;
      const scale = Math.hypot(ctx.geom.t[0], ctx.geom.t[1]) * (ctx.geom.div.clientWidth / ctx.geom.w);
      for (const block of blocks) {
        const rect = this._permilleRect(pageIndex, block.bbox);
        if (!rect) continue;
        const box = this._addRect(ctx.tview, ctx.geom, [rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1], block.title ? "dr-tbox dr-title" : "dr-tbox");
        box.textContent = block.text;
        // Start near typical body size (~10 pt) and shrink until the text fits its block.
        let size = Math.max(6, (block.title ? 13 : 10) * scale);
        const height = box.clientHeight;
        for (let i = 0; i < 16 && size > 5; i++) {
          box.style.fontSize = `${size}px`;
          if (box.scrollHeight <= height + 1) break;
          size *= 0.9;
        }
      }
    }

    setData(hierarchicalData) {
      this.pages = new Map();
      for (const page of hierarchicalData || []) {
        const paragraphs = [];
        for (const paragraph of page.paragraphs || []) {
          const rects = (paragraph.rects || []).filter((r) => Array.isArray(r) && r.length === 4);
          const hasContent = paragraph.paragraphSummary || (paragraph.points || []).some((p) => p.summary || p.translation);
          if (!rects.length || !hasContent) continue;
          paragraphs.push({ ...paragraph, pageIndex: page.pageIndex, rects, bbox: unionRect(rects) });
        }
        this.pages.set(page.pageIndex, paragraphs);
      }
      this._hideCard(true);
      this.renderAllPages();
    }

    /** When the margin rail is visible, floating hover cards are replaced by rail highlighting. */
    setRailActive(active) {
      this.railActive = !!active;
      if (active) this._hideCard(true);
    }

    setOptions(options) {
      Object.assign(this.options, options);
      if (!this.options.hoverCards) this._hideCard(true);
      this.renderAllPages();
    }

    renderAllPages() {
      if (!this.attached) return;
      const count = this.app?.pdfViewer?.pagesCount || 0;
      for (let i = 0; i < count; i++) {
        this._renderPage(i);
      }
    }

    /* ---------- geometry ---------- */

    _geometry(pageIndex) {
      const pageView = this.app?.pdfViewer?.getPageView(pageIndex);
      const viewport = pageView?.viewport;
      if (!pageView?.div || !viewport) return null;
      return { div: pageView.div, t: Array.from(viewport.transform), w: viewport.width, h: viewport.height };
    }

    _toPercent(geom, rect) {
      const [ax, ay] = apply(geom.t, rect[0], rect[1]);
      const [bx, by] = apply(geom.t, rect[2], rect[3]);
      return {
        left: (Math.min(ax, bx) / geom.w) * 100,
        top: (Math.min(ay, by) / geom.h) * 100,
        width: (Math.abs(bx - ax) / geom.w) * 100,
        height: (Math.abs(by - ay) / geom.h) * 100,
      };
    }

    _clientToPdf(geom, clientX, clientY) {
      const box = geom.div.getBoundingClientRect();
      const left = box.left + geom.div.clientLeft;
      const top = box.top + geom.div.clientTop;
      const px = ((clientX - left) / (geom.div.clientWidth || 1)) * geom.w;
      const py = ((clientY - top) / (geom.div.clientHeight || 1)) * geom.h;
      const inv = invert(geom.t);
      return inv ? apply(inv, px, py) : null;
    }

    /** Client rect (in the outer reader document) of a PDF rect on a page. */
    _rectInReaderDoc(pageIndex, rect) {
      const geom = this._geometry(pageIndex);
      if (!geom) return null;
      const pct = this._toPercent(geom, rect);
      const box = geom.div.getBoundingClientRect();
      const frame = this.iframeEl.getBoundingClientRect();
      const left = frame.left + box.left + geom.div.clientLeft;
      const top = frame.top + box.top + geom.div.clientTop;
      const w = geom.div.clientWidth;
      const h = geom.div.clientHeight;
      return {
        left: left + (pct.left / 100) * w,
        top: top + (pct.top / 100) * h,
        right: left + ((pct.left + pct.width) / 100) * w,
        bottom: top + ((pct.top + pct.height) / 100) * h,
        pageLeft: frame.left + box.left,
        pageRight: frame.left + box.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        frameTop: frame.top,
        frameBottom: frame.bottom,
      };
    }

    /* ---------- page layers ---------- */

    _layer(pageIndex) {
      const geom = this._geometry(pageIndex);
      if (!geom) return null;
      let layer = geom.div.querySelector(":scope > .deepread-layer");
      if (!layer) {
        layer = el(this.pdfDoc, "div", "deepread-layer");
        layer.append(el(this.pdfDoc, "div", "dr-persistent"), el(this.pdfDoc, "div", "dr-tview"), el(this.pdfDoc, "div", "dr-transient"));
        geom.div.append(layer);
      }
      return {
        layer, geom,
        persistent: layer.querySelector(":scope > .dr-persistent"),
        tview: layer.querySelector(":scope > .dr-tview"),
        transient: layer.querySelector(":scope > .dr-transient"),
      };
    }

    _addRect(container, geom, rect, cls, color) {
      const pct = this._toPercent(geom, rect);
      const node = el(this.pdfDoc, "div", cls);
      node.style.left = `${pct.left}%`;
      node.style.top = `${pct.top}%`;
      node.style.width = `${pct.width}%`;
      node.style.height = `${pct.height}%`;
      if (color) node.style.background = color;
      container.append(node);
      return node;
    }

    _renderPage(pageIndex) {
      const paragraphs = this.pages.get(pageIndex) || [];
      const geom = this._geometry(pageIndex);
      if (!geom) return;
      if (!paragraphs.length && !this.tview?.get(pageIndex)?.length) {
        geom.div.querySelector(":scope > .deepread-layer")?.remove();
        return;
      }
      const ctx = this._layer(pageIndex);
      if (!ctx) return;
      this._renderTranslationView(ctx, pageIndex);
      ctx.persistent.replaceChildren();
      if (this.options.highlights) {
        for (const paragraph of paragraphs) {
          for (const point of paragraph.points || []) {
            const level = this.session.pointLevel(point);
            if (level < 2) continue;
            for (const rect of point.rects || []) {
              this._addRect(ctx.persistent, ctx.geom, rect, "dr-rect", LEVEL_COLORS[level]);
            }
          }
        }
      }
      // Restore transient state for the hovered paragraph after a re-render.
      ctx.transient.replaceChildren();
      if (this.hoverPara && this.hoverPara.pageIndex === pageIndex) {
        this._drawHover(this.hoverPara);
      }
    }

    _clearTransient() {
      if (!this.pdfDoc) return;
      for (const node of this.pdfDoc.querySelectorAll(".deepread-layer .dr-transient")) {
        node.replaceChildren();
      }
    }

    _drawHover(paragraph, pointId = null) {
      this._clearTransient();
      const ctx = this._layer(paragraph.pageIndex);
      if (!ctx) return;
      if (this.altDown && this.options.translationPopup) {
        this._drawTranslation(ctx, paragraph);
        return;
      }
      if (pointId) {
        const point = (paragraph.points || []).find((p) => p.id === pointId);
        for (const rect of point?.rects || []) {
          this._addRect(ctx.transient, ctx.geom, rect, "dr-rect", HOVER_POINT_COLOR);
        }
      }
      else {
        const pad = 2;
        const [x1, y1, x2, y2] = paragraph.bbox;
        this._addRect(ctx.transient, ctx.geom, [x1 - pad, y1 - pad, x2 + pad, y2 + pad], "dr-outline");
      }
    }

    _paragraphTranslation(paragraph) {
      const parts = (paragraph.points || []).map((p) => (p.translation || "").trim()).filter(Boolean);
      return parts.join("");
    }

    _drawTranslation(ctx, paragraph) {
      const text = this._paragraphTranslation(paragraph);
      if (!text) return;
      const box = this._addRect(ctx.transient, ctx.geom, paragraph.bbox, "dr-translation");
      box.textContent = text;
      // Start from the original line height (so it reads like the paper), then shrink to fit.
      const height = box.clientHeight;
      const scale = Math.hypot(ctx.geom.t[0], ctx.geom.t[1]) * (ctx.geom.div.clientWidth / ctx.geom.w);
      const lineHeights = paragraph.rects.map((r) => Math.abs(r[3] - r[1])).filter((v) => v > 2).sort((a, b) => a - b);
      const lineHeight = lineHeights.length ? lineHeights[Math.floor(lineHeights.length / 2)] : 10;
      let size = Math.max(8, Math.min(28, lineHeight * scale * 1.0));
      for (let i = 0; i < 14; i++) {
        box.style.fontSize = `${size}px`;
        if (box.scrollHeight <= height + 1 || size <= 7) break;
        size *= 0.9;
      }
      if (box.scrollHeight > height + 1) {
        box.style.height = "auto";
        box.style.overflow = "visible";
      }
    }

    /* ---------- hover handling ---------- */

    _onKey(event) {
      const alt = event.type === "blur" ? false : !!event.altKey;
      if (alt === this.altDown) return;
      this.altDown = alt;
      if (this.hoverPara) {
        this._drawHover(this.hoverPara);
        if (alt) this._hideCard(false);
      }
    }

    _hitTest(event) {
      const pageDiv = event.target?.closest?.(".page[data-page-number]");
      if (!pageDiv) return null;
      const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
      const paragraphs = this.pages.get(pageIndex);
      if (!paragraphs?.length) return null;
      const geom = this._geometry(pageIndex);
      const point = geom && this._clientToPdf(geom, event.clientX, event.clientY);
      if (!point) return null;
      const [x, y] = point;
      for (const paragraph of paragraphs) {
        if (!inRect(paragraph.bbox, x, y, 3)) continue;
        if (paragraph.rects.some((r) => inRect(r, x, y, 3))) return paragraph;
      }
      return null;
    }

    _onPointerMove(event) {
      if (!this.pages.size) return;
      this.altDown = !!event.altKey;
      const active = this.options.hoverCards || this.railActive || (this.altDown && this.options.translationPopup);
      if (!active || event.buttons) {
        if (this.hoverPara) this._setHover(null);
        return;
      }
      const paragraph = this._hitTest(event);
      if (paragraph !== this.hoverPara) {
        this._setHover(paragraph);
      }
    }

    _setHover(paragraph) {
      this.hoverPara = paragraph;
      clearTimeout(this._timers.show);
      if (!paragraph) {
        this._clearTransient();
        this.session.rail?.linkParagraph(null);
        this._scheduleHide();
        return;
      }
      clearTimeout(this._timers.hide);
      this._drawHover(paragraph);
      this.session.rail?.linkParagraph(paragraph);
      if (this.altDown || !this.options.hoverCards || this.railActive) return;
      this._timers.show = setTimeout(() => this._showCard(paragraph), this.card && !this.card.hidden ? 40 : SHOW_DELAY);
    }

    _scheduleHide() {
      clearTimeout(this._timers.hide);
      this._timers.hide = setTimeout(() => {
        if (this._cardHovered) return;
        this.hoverPara = null;
        this._clearTransient();
        this._hideCard(false);
      }, HIDE_DELAY);
    }

    /* ---------- card ---------- */

    _ensureCard() {
      if (this.card && this.card.isConnected) return this.card;
      const card = el(this.readerDoc, "div", "deepread-card");
      card.hidden = true;
      card.addEventListener("pointerenter", () => {
        this._cardHovered = true;
        clearTimeout(this._timers.hide);
      });
      card.addEventListener("pointerleave", () => {
        this._cardHovered = false;
        if (this.cardPara) this._drawHover(this.cardPara);
        this._scheduleHide();
      });
      (this.readerDoc.body || this.readerDoc.documentElement).append(card);
      this.card = card;
      return card;
    }

    _hideCard(immediate) {
      clearTimeout(this._timers.show);
      if (immediate) this._cardHovered = false;
      if (this.card) this.card.hidden = true;
      this.cardPara = null;
    }

    _showCard(paragraph) {
      if (!this.attached || paragraph !== this.hoverPara) return;
      const doc = this.readerDoc;
      const card = this._ensureCard();
      this.cardPara = paragraph;
      const showTranslation = this.options.translationPopup;
      card.replaceChildren();

      const head = el(doc, "div", "dr-head");
      head.append(el(doc, "div", "dr-summary", this.session.paragraphSummary(paragraph) || ""));
      const actions = el(doc, "div", "dr-actions");
      const button = (label, title, onClick) => {
        const b = el(doc, "button", "", label);
        b.title = title;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          onClick();
        });
        actions.append(b);
      };
      button("⧉", DeepRead.t("card.copySummary"), () => {
        const lines = [this.session.paragraphSummary(paragraph), ...(paragraph.points || []).map((p) => `- ${p.summary}`)];
        DeepRead.util.copyToClipboard(lines.filter(Boolean).join("\n"));
      });
      if (this._paragraphTranslation(paragraph)) {
        button("译", DeepRead.t("card.copyTranslation"), () => {
          DeepRead.util.copyToClipboard(this._paragraphTranslation(paragraph));
        });
      }
      button("卡", DeepRead.bilingual("生成闪卡", "Make a flashcard"), () => {
        this.session.createFlashcard({ pageIndex: paragraph.pageIndex, rects: paragraph.rects, quote: paragraph.paragraphText || "", source: "paragraph" });
      });
      button("AI", DeepRead.t("card.askAI"), () => {
        this.session.askAI({ text: paragraph.paragraphText || "", pageIndex: paragraph.pageIndex });
      });
      head.append(actions);
      card.append(head);

      const list = el(doc, "ol");
      for (const point of paragraph.points || []) {
        const li = el(doc, "li");
        li.dataset.pointId = point.id;
        li.dataset.level = String(this.session.pointLevel(point));
        li.title = DeepRead.t("card.importance");
        li.append(el(doc, "div", "dr-point-summary", point.summary || ""));
        if (showTranslation && point.translation) {
          li.append(el(doc, "div", "dr-point-translation", point.translation));
        }
        li.addEventListener("pointerenter", () => this._drawHover(paragraph, point.id));
        li.addEventListener("pointerleave", () => this._drawHover(paragraph));
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = (this.session.pointLevel(point) % 3) + 1;
          this.session.setPointImportance(point.id, next);
          li.dataset.level = String(next);
        });
        list.append(li);
      }
      if (list.childNodes.length) card.append(list);
      const note = this.session.paragraphNote?.(`p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`);
      if (note) {
        const block = el(doc, "div", "dr-hnote");
        block.append(el(doc, "div", "dr-hnote-label", DeepRead.bilingual("我的理解", "My understanding")), el(doc, "div", "", note));
        card.append(block);
      }
      card.append(el(doc, "div", "dr-foot", `p. ${paragraph.pageIndex + 1} · Alt: ${DeepRead.t("card.translation")}`));

      card.hidden = false;
      this._positionCard(card, paragraph);
    }

    _positionCard(card, paragraph) {
      const r = this._rectInReaderDoc(paragraph.pageIndex, paragraph.bbox);
      if (!r) return;
      const width = card.offsetWidth || 340;
      const gap = 12;
      let left;
      if (r.pageRight + gap + width <= r.frameRight - 4) left = r.pageRight + gap;
      else if (r.pageLeft - gap - width >= r.frameLeft + 4) left = r.pageLeft - gap - width;
      else if (r.right + gap + width <= r.frameRight - 4) left = r.right + gap;
      else left = Math.max(r.frameLeft + 4, r.frameRight - width - 8);
      const height = card.offsetHeight || 200;
      let top = Math.max(r.frameTop + 6, Math.min(r.top, r.frameBottom - height - 6));
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    /** Briefly highlight a paragraph after navigation. */
    flash(paragraph) {
      if (!paragraph?.bbox && paragraph?.rects) paragraph = { ...paragraph, bbox: unionRect(paragraph.rects) };
      if (!paragraph?.bbox) return;
      this.hoverPara = null;
      setTimeout(() => {
        this._drawHover(paragraph);
        clearTimeout(this._timers.flash);
        this._timers.flash = setTimeout(() => {
          if (!this.hoverPara) this._clearTransient();
        }, 1600);
      }, 350);
    }

    _injectStyle(doc, id, cssText) {
      if (!doc || doc.getElementById(id)) return;
      const style = doc.createElementNS(HTML_NS, "style");
      style.id = id;
      style.textContent = cssText;
      (doc.head || doc.documentElement).append(style);
      this._cleanup.push(() => style.remove());
    }
  };

  DeepRead.Overlay.unionRect = unionRect;
})();
