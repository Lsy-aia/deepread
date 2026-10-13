/*
 * Margin rail: persistent paragraph summary cards (and flashcards) beside the PDF.
 *
 * Vibero widened every PDF page inside a modified pdf.js to make room for its margin cards.
 * A plugin cannot do that, so the PDF iframe is narrowed instead and a rail is placed next to
 * it in the reader document. Each card is anchored at the vertical position of its paragraph,
 * pushed down to avoid overlaps (with a connector back to the anchor), and kept in sync with
 * scrolling and zooming.
 *
 * License: AGPL-3.0-or-later. Card design follows Vibero (AGPL-3.0, a Zotero fork).
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const GAP = 6;
  const OVERSCAN = 400;

  const CSS = `
#primary-view.deepread-has-rail > iframe { flex: 1 1 auto; width: auto !important; min-width: 0; }
.deepread-rail { position: relative; flex: 0 0 var(--dr-rail-width, 300px); overflow: hidden;
  border-inline-start: 1px solid var(--color-panedivider, rgba(0,0,0,0.12));
  background: var(--material-sidepane, #f6f7f8); color: var(--fill-primary, #1f2328);
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.deepread-rail svg.dr-links { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.deepread-rail .dr-rcard { position: absolute; left: 12px; right: 8px; box-sizing: border-box; padding: 6px 8px 5px;
  border-radius: 8px; background: var(--material-background, #fff); border: 1px solid rgba(0,0,0,0.08);
  box-shadow: 0 1px 3px rgba(0,0,0,0.06); transition: box-shadow .15s; }
.deepread-rail .dr-rcard:hover, .deepread-rail .dr-rcard.dr-linked { box-shadow: 0 0 0 1.5px rgba(251,191,36,0.9), 0 4px 14px rgba(0,0,0,0.10); }
.deepread-rail .dr-rhead { display: flex; gap: 4px; align-items: flex-start; }
.deepread-rail .dr-rsummary { flex: 1; font-weight: 600; cursor: pointer; outline: none; }
.deepread-rail .dr-rsummary[contenteditable="true"] { cursor: text; background: rgba(59,130,246,0.08); border-radius: 4px; }
.deepread-rail .dr-ractions { display: none; gap: 1px; flex-shrink: 0; }
.deepread-rail .dr-rcard:hover .dr-ractions { display: flex; }
.deepread-rail .dr-ractions button { border: none; background: transparent; color: var(--fill-secondary, #57606a); cursor: pointer;
  font-size: 11px; padding: 0 4px; border-radius: 4px; line-height: 18px; }
.deepread-rail .dr-ractions button:hover { background: rgba(0,0,0,0.07); color: inherit; }
.deepread-rail ul { margin: 3px 0 0; padding: 0; list-style: none; }
.deepread-rail li { position: relative; padding: 1px 4px 1px 11px; border-radius: 4px; cursor: pointer; color: var(--fill-secondary, #424a53); }
.deepread-rail li::before { content: ""; position: absolute; left: 3px; top: 7px; width: 4px; height: 4px; border-radius: 50%; background: #8c959f; }
.deepread-rail li[data-level="2"]::before { background: #3b82f6; }
.deepread-rail li[data-level="3"]::before { background: #ef4444; }
.deepread-rail li[data-level="2"] { color: #1d4ed8; }
.deepread-rail li[data-level="3"] { color: #b91c1c; }
.deepread-rail li:hover { background: rgba(251,191,36,0.16); }
.deepread-rail .dr-rtr { display: none; color: var(--fill-primary, #1f2328); margin-top: 1px; }
.deepread-rail li:hover .dr-rtr, .deepread-rail .dr-rcard.dr-expanded .dr-rtr { display: block; }
.deepread-rail .dr-rcard.dr-flash { background: #fffbea; border-color: rgba(234,179,8,0.45); cursor: pointer; }
.deepread-rail .dr-fc-label { font-size: 10.5px; font-weight: 700; color: #a16207; letter-spacing: .02em; }
.deepread-rail .dr-fc-q { font-weight: 600; }
.deepread-rail .dr-fc-a { margin-top: 3px; padding-top: 3px; border-top: 1px dashed rgba(161,98,7,0.35); }
.deepread-rail .dr-fc-a p { margin: 0.2em 0; }
.deepread-rail .dr-muted { color: var(--fill-secondary, #6b7280); }
.deepread-rail textarea { width: 100%; box-sizing: border-box; font: inherit; resize: vertical; margin: 2px 0;
  border: 1px solid rgba(0,0,0,0.15); border-radius: 5px; padding: 3px 5px; background: var(--material-background, #fff); color: inherit; }
.deepread-rail .dr-fc-buttons { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.deepread-rail .dr-fc-buttons button { font: inherit; font-size: 11px; padding: 1px 7px; border-radius: 4px; cursor: pointer;
  border: 1px solid rgba(0,0,0,0.15); background: transparent; color: inherit; }
.deepread-rail .dr-fc-buttons button.dr-primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
:root[data-color-scheme="dark"] .deepread-rail { background: #1f2124; color: #e6e6e6; }
:root[data-color-scheme="dark"] .deepread-rail .dr-rcard { background: #2a2d32; border-color: rgba(255,255,255,0.1); }
:root[data-color-scheme="dark"] .deepread-rail li { color: #c5c9cf; }
:root[data-color-scheme="dark"] .deepread-rail .dr-rcard.dr-flash { background: #3a3320; border-color: rgba(234,179,8,0.35); }
`;

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.Rail = class Rail {
    constructor(session) {
      this.session = session;
      this.cards = new Map(); // key → { el, height, width, anchor, kind, data, sig }
      this.expanded = new Set();
      this.attached = false;
      this._cleanup = [];
      this._raf = null;
    }

    get enabled() {
      return DeepRead.prefs.get("view.marginCards") !== false;
    }

    get overlay() {
      return this.session.overlay;
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.pdfWin = view._iframeWindow;
      this.app = (this.pdfWin.wrappedJSObject || this.pdfWin).PDFViewerApplication;
      this.container = view._iframe?.parentElement;
      if (!this.container) return;
      this.attached = true;
      this.refresh();
    }

    detach() {
      this._teardownDOM();
      this.attached = false;
    }

    _teardownDOM() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      if (this._raf && this.readerWin) this.readerWin.cancelAnimationFrame(this._raf);
      this._raf = null;
      this.root?.remove();
      this.root = null;
      this.cards.clear();
      this.container?.classList.remove("deepread-has-rail");
      this.overlay.setRailActive?.(false);
    }

    /** Should the rail be shown right now? */
    _wanted() {
      if (!this.attached || !this.enabled) return false;
      return this.overlay.pages.size > 0 || (this.session.flashcards || []).length > 0;
    }

    /** Re-evaluate visibility and contents (call after data, flashcards or settings change). */
    refresh() {
      if (!this.attached) return;
      if (!this._wanted()) {
        if (this.root) this._teardownDOM();
        return;
      }
      if (!this.root) this._buildDOM();
      for (const card of this.cards.values()) card.sig = null; // force content refresh
      this.schedule();
    }

    _buildDOM() {
      const doc = this.readerDoc;
      if (!doc.getElementById("deepread-rail-css")) {
        const style = doc.createElementNS(HTML_NS, "style");
        style.id = "deepread-rail-css";
        style.textContent = CSS;
        (doc.head || doc.documentElement).append(style);
      }
      if (!doc.getElementById("deepread-katex-css")) {
        const link = doc.createElementNS(HTML_NS, "link");
        link.id = "deepread-katex-css";
        link.rel = "stylesheet";
        link.href = "chrome://deepread/content/lib/katex/katex.min.css";
        (doc.head || doc.documentElement).append(link);
        this._cleanup.push(() => link.remove());
      }
      const width = Math.max(220, Math.min(520, DeepRead.prefs.number("view.railWidth", 300)));
      this.root = el(doc, "div", "deepread-rail");
      this.root.style.setProperty("--dr-rail-width", `${width}px`);
      this.svg = doc.createElementNS(SVG_NS, "svg");
      this.svg.setAttribute("class", "dr-links");
      this.root.append(this.svg);
      this.container.classList.add("deepread-has-rail");
      this.container.append(this.root);
      this.overlay.setRailActive?.(true);

      const schedule = () => this.schedule();
      const viewer = this.pdfWin.document.getElementById("viewerContainer");
      viewer?.addEventListener("scroll", schedule, { passive: true });
      this._cleanup.push(() => viewer?.removeEventListener("scroll", schedule));
      const onRendered = Components.utils.exportFunction(() => this.schedule(true), this.pdfWin);
      try {
        this.app.eventBus.on("pagerendered", onRendered);
        this.app.eventBus.on("scalechanging", onRendered);
        this.app.eventBus.on("rotationchanging", onRendered);
      }
      catch (e) {}
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagerendered", onRendered);
          this.app.eventBus.off("scalechanging", onRendered);
          this.app.eventBus.off("rotationchanging", onRendered);
        }
        catch (e) {}
      });
      const ro = new this.readerWin.ResizeObserver(() => this.schedule(true));
      ro.observe(this.root);
      this._cleanup.push(() => ro.disconnect());
      this._cleanup.push(() => this.readerDoc.getElementById("deepread-rail-css")?.remove());
    }

    schedule(remeasure = false) {
      if (remeasure) this._remeasure = true;
      if (!this.root || this._raf) return;
      this._raf = this.readerWin.requestAnimationFrame(() => {
        this._raf = null;
        try {
          this._layout();
        }
        catch (e) {
          DeepRead.log("rail layout failed", e?.stack || String(e));
        }
      });
    }

    /* ---------- items ---------- */

    _items() {
      const items = [];
      for (const [pageIndex, paragraphs] of this.overlay.pages) {
        for (const paragraph of paragraphs) {
          const key = `p_${pageIndex}_${paragraph.paragraphIndex}`;
          if (this.session.isCardHidden?.(key)) continue;
          items.push({ key, kind: "paragraph", pageIndex, rect: paragraph.bbox, data: paragraph });
        }
      }
      for (const card of this.session.flashcards || []) {
        const rect = card.rects?.length ? DeepRead.Overlay.unionRect(card.rects) : null;
        if (!rect) continue;
        items.push({ key: `f_${card.id}`, kind: "flashcard", pageIndex: card.pageIndex, rect, data: card });
      }
      return items;
    }

    /** Anchor y (rail coordinates) of a PDF rect's top edge, or null if the page is not laid out. */
    _anchorY(pageIndex, rect) {
      const geom = this.overlay._geometry(pageIndex);
      if (!geom) return null;
      const pct = this.overlay._toPercent(geom, rect);
      const box = geom.div.getBoundingClientRect();
      const frame = this.view._iframe.getBoundingClientRect();
      const rail = this.root.getBoundingClientRect();
      return frame.top - rail.top + box.top + geom.div.clientTop + (pct.top / 100) * geom.div.clientHeight;
    }

    _visiblePages(railHeight) {
      const visible = new Set();
      const count = this.app?.pdfViewer?.pagesCount || 0;
      const frame = this.view._iframe.getBoundingClientRect();
      const rail = this.root.getBoundingClientRect();
      const offset = frame.top - rail.top;
      for (let i = 0; i < count; i++) {
        const div = this.app.pdfViewer.getPageView(i)?.div;
        if (!div) continue;
        const r = div.getBoundingClientRect();
        if (r.bottom + offset > -OVERSCAN && r.top + offset < railHeight + OVERSCAN) visible.add(i);
      }
      return visible;
    }

    _layout() {
      if (!this.root) return;
      const railHeight = this.root.clientHeight;
      const visible = this._visiblePages(railHeight);
      const items = this._items().filter((item) => visible.has(item.pageIndex));
      for (const item of items) item.anchor = this._anchorY(item.pageIndex, item.rect);
      const placed = items.filter((item) => item.anchor !== null).sort((a, b) => a.anchor - b.anchor);

      const width = this.root.clientWidth;
      const keep = new Set();
      let bottom = -Infinity;
      const links = [];
      for (const item of placed) {
        const card = this._ensureCard(item, width);
        const top = Math.max(item.anchor, bottom + GAP);
        bottom = top + card.height;
        keep.add(item.key);
        const onScreen = bottom > -50 && top < railHeight + 50;
        card.el.hidden = !onScreen;
        if (onScreen) {
          card.el.style.top = `${Math.round(top)}px`;
          links.push({ anchor: item.anchor, top, kind: item.kind });
        }
      }
      for (const [key, card] of this.cards) {
        if (!keep.has(key)) {
          card.el.remove();
          this.cards.delete(key);
        }
      }
      this._remeasure = false;
      this._drawLinks(links);
    }

    _drawLinks(links) {
      const svg = this.svg;
      while (svg.firstChild) svg.firstChild.remove();
      for (const { anchor, top, kind } of links) {
        const color = kind === "flashcard" ? "rgba(202,138,4,0.75)" : "rgba(107,114,128,0.55)";
        const dot = this.readerDoc.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", "3");
        dot.setAttribute("cy", String(anchor + 4));
        dot.setAttribute("r", "2");
        dot.setAttribute("fill", color);
        svg.append(dot);
        if (top - anchor > 3) {
          const path = this.readerDoc.createElementNS(SVG_NS, "path");
          path.setAttribute("d", `M3 ${anchor + 4} L3 ${top + 10} L12 ${top + 10}`);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", "1");
          svg.append(path);
        }
      }
    }

    /* ---------- cards ---------- */

    _signature(item) {
      if (item.kind === "flashcard") {
        const c = item.data;
        return `f|${c.question}|${c.answer}|${c.updatedAt}|${this.session.flipped?.has(c.id)}|${this.session.editingFlashcard === c.id}|${c._busy || ""}`;
      }
      const p = item.data;
      const levels = (p.points || []).map((pt) => this.session.pointLevel(pt)).join("");
      return `p|${this.session.paragraphSummary(p)}|${levels}|${this.expanded.has(item.key)}|${this.overlay.options.translationPopup}`;
    }

    _ensureCard(item, width) {
      let card = this.cards.get(item.key);
      const sig = this._signature(item);
      if (!card) {
        card = { el: el(this.readerDoc, "div", "dr-rcard"), height: 0, width: 0, sig: null };
        card.el.dataset.key = item.key;
        this.root.append(card.el);
        this.cards.set(item.key, card);
      }
      if (card.sig !== sig) {
        card.el.replaceChildren();
        if (item.kind === "flashcard") this._fillFlashcard(card.el, item.data);
        else this._fillParagraph(card.el, item.key, item.data);
        card.sig = sig;
        card.height = 0;
      }
      if (!card.height || card.width !== width || this._remeasure) {
        card.el.hidden = false;
        card.height = card.el.offsetHeight;
        card.width = width;
      }
      return card;
    }

    _button(container, label, title, onClick) {
      const b = el(this.readerDoc, "button", "", label);
      b.title = title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(e);
      });
      container.append(b);
      return b;
    }

    _fillParagraph(node, key, paragraph) {
      const doc = this.readerDoc;
      const session = this.session;
      node.classList.toggle("dr-expanded", this.expanded.has(key));
      const head = el(doc, "div", "dr-rhead");
      const summary = el(doc, "div", "dr-rsummary", session.paragraphSummary(paragraph) || "…");
      summary.title = DeepRead.bilingual("单击展开译文 · 双击编辑", "Click to expand translations · double-click to edit");
      summary.addEventListener("click", () => {
        if (summary.isContentEditable) return;
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.schedule();
        this.cards.get(key).sig = null;
      });
      summary.addEventListener("dblclick", (e) => {
        e.preventDefault();
        summary.contentEditable = "true";
        summary.focus();
        const range = doc.createRange();
        range.selectNodeContents(summary);
        doc.defaultView.getSelection().removeAllRanges();
        doc.defaultView.getSelection().addRange(range);
      });
      const finish = (save) => {
        if (summary.contentEditable !== "true") return;
        summary.contentEditable = "false";
        if (save) session.setParagraphSummary(paragraph, summary.textContent.trim());
        else summary.textContent = session.paragraphSummary(paragraph);
        this.cards.get(key) && (this.cards.get(key).sig = null);
        this.schedule(true);
      };
      summary.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
        else if (e.key === "Escape") finish(false);
      });
      summary.addEventListener("blur", () => finish(true));
      head.append(summary);

      const actions = el(doc, "div", "dr-ractions");
      this._button(actions, "⧉", DeepRead.t("card.copySummary"), () => {
        const lines = [session.paragraphSummary(paragraph), ...(paragraph.points || []).map((p) => `- ${p.summary}`)];
        DeepRead.util.copyToClipboard(lines.filter(Boolean).join("\n"));
      });
      if (this.overlay._paragraphTranslation(paragraph)) {
        this._button(actions, "译", DeepRead.t("card.copyTranslation"), () => {
          DeepRead.util.copyToClipboard(this.overlay._paragraphTranslation(paragraph));
        });
      }
      this._button(actions, "卡", DeepRead.bilingual("生成闪卡", "Make a flashcard"), () => {
        session.createFlashcard({
          pageIndex: paragraph.pageIndex,
          rects: paragraph.rects,
          quote: paragraph.paragraphText || "",
          source: "paragraph",
        });
      });
      this._button(actions, "AI", DeepRead.t("card.askAI"), () => {
        session.askAI({ text: paragraph.paragraphText || "", pageIndex: paragraph.pageIndex });
      });
      this._button(actions, "×", DeepRead.bilingual("隐藏此卡片", "Hide this card"), () => {
        session.setCardHidden(key, true);
      });
      head.append(actions);
      node.append(head);

      const points = paragraph.points || [];
      if (points.length) {
        const list = el(doc, "ul");
        for (const point of points) {
          const li = el(doc, "li");
          li.dataset.level = String(session.pointLevel(point));
          li.title = DeepRead.t("card.importance");
          li.append(el(doc, "span", "", point.summary || ""));
          if (point.translation && this.overlay.options.translationPopup) {
            li.append(el(doc, "div", "dr-rtr", point.translation));
          }
          li.addEventListener("pointerenter", () => this.overlay._drawHover(paragraph, point.id));
          li.addEventListener("pointerleave", () => this.overlay._drawHover(paragraph));
          li.addEventListener("click", (e) => {
            e.stopPropagation();
            session.setPointImportance(point.id, (session.pointLevel(point) % 3) + 1);
          });
          list.append(li);
        }
        node.append(list);
      }
      node.onpointerenter = () => this.overlay._drawHover(paragraph);
      node.onpointerleave = () => this.overlay._clearTransient();
    }

    _fillFlashcard(node, card) {
      const doc = this.readerDoc;
      const session = this.session;
      node.classList.add("dr-flash");
      const head = el(doc, "div", "dr-rhead");
      head.append(el(doc, "div", "dr-fc-label", DeepRead.bilingual("闪卡", "FLASHCARD") + (card._busy ? ` · ${card._busy}` : "")));
      const actions = el(doc, "div", "dr-ractions");
      head.append(actions);
      node.append(head);

      if (session.editingFlashcard === card.id) {
        const q = el(doc, "textarea");
        q.rows = 2;
        q.placeholder = DeepRead.bilingual("问题", "Question");
        q.value = card.question || "";
        const a = el(doc, "textarea");
        a.rows = 3;
        a.placeholder = DeepRead.bilingual("答案（可留空，或点 AI 回答）", "Answer (optional, or ask AI)");
        a.value = card.answer || "";
        const buttons = el(doc, "div", "dr-fc-buttons");
        const save = this._button(buttons, DeepRead.bilingual("保存", "Save"), "", async () => {
          session.editingFlashcard = null;
          await session.saveFlashcard({ ...card, question: q.value.trim(), answer: a.value.trim() });
        });
        save.classList.add("dr-primary");
        this._button(buttons, DeepRead.bilingual("AI 回答", "AI answer"), "", async (e) => {
          const button = e.currentTarget;
          button.disabled = true;
          try {
            a.value = await DeepRead.Flashcards.answer({
              question: q.value.trim() || card.question,
              quote: card.quote,
              context: session.flashcardContext(card.pageIndex),
            });
          }
          catch (error) {
            a.value = DeepRead.util.formatError(error);
          }
          finally {
            button.disabled = false;
            this.schedule(true);
          }
        });
        this._button(buttons, DeepRead.bilingual("取消", "Cancel"), "", () => {
          session.editingFlashcard = null;
          if (!card.question && !card.answer) session.deleteFlashcard(card.id);
          else session._emit("flashcards", { id: card.id });
        });
        for (const field of [q, a]) {
          field.addEventListener("input", () => this.schedule(true));
          field.addEventListener("keydown", (e) => e.stopPropagation());
        }
        node.append(q, a, buttons);
        setTimeout(() => q.focus(), 0);
        return;
      }

      this._button(actions, "✎", DeepRead.bilingual("编辑", "Edit"), () => {
        session.editingFlashcard = card.id;
        session._emit("flashcards", { id: card.id });
      });
      this._button(actions, "↗", DeepRead.bilingual("定位原文", "Jump to source"), () => session.navigateToFlashcard(card));
      this._button(actions, "×", DeepRead.bilingual("删除", "Delete"), () => {
        if (Services.prompt.confirm(null, "DeepRead", DeepRead.bilingual("删除这张闪卡？", "Delete this flashcard?"))) {
          session.deleteFlashcard(card.id);
        }
      });
      node.append(el(doc, "div", "dr-fc-q", card.question || (card._busy ? "…" : DeepRead.bilingual("（无问题，点 ✎ 编辑）", "(no question — click ✎)"))));
      const flipped = session.flipped?.has(card.id);
      if (flipped && card.answer) {
        const answer = el(doc, "div", "dr-fc-a");
        answer.append(DeepRead.Markdown.render(doc, card.answer, answer));
        node.append(answer);
      }
      else if (card.answer) {
        node.append(el(doc, "div", "dr-muted", DeepRead.bilingual("点击查看答案", "Click to reveal the answer")));
      }
      node.onclick = (e) => {
        if (e.target.closest("button, a, textarea")) return;
        session.flipped = session.flipped || new Set();
        if (session.flipped.has(card.id)) session.flipped.delete(card.id);
        else session.flipped.add(card.id);
        this.cards.get(`f_${card.id}`) && (this.cards.get(`f_${card.id}`).sig = null);
        this.schedule(true);
      };
      node.onpointerenter = () => {
        const rect = DeepRead.Overlay.unionRect(card.rects || []);
        if (rect) this.overlay._drawHover({ pageIndex: card.pageIndex, bbox: rect, rects: card.rects, points: [] });
      };
      node.onpointerleave = () => this.overlay._clearTransient();
    }

    /** Highlight the rail card of a paragraph hovered in the PDF. */
    linkParagraph(paragraph) {
      if (!this.root) return;
      const key = paragraph ? `p_${paragraph.pageIndex}_${paragraph.paragraphIndex}` : null;
      for (const [k, card] of this.cards) card.el.classList.toggle("dr-linked", k === key);
    }
  };
})();
