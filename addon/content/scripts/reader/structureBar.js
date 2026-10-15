/*
 * Section bar (module "structureBar"): a thin strip under the reader toolbar showing the paper's
 * top-level sections (DeepRead.Structure), sized by length and coloured by role, with how far the
 * reader has got and where they are now. Clicking a section jumps to it.
 *
 * The reader UI positions #split-view at top: 41px (below its toolbar); the bar takes that slot and
 * pushes the views down by its height.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const TOOLBAR = 41;
  const HEIGHT = 30;

  // [read, unread, text on read, text on unread]
  const COLORS = {
    front: ["#59647a", "#cdd3de", "#fff", "#3a3f4c"],
    intro: ["#59647a", "#cdd3de", "#fff", "#3a3f4c"],
    background: ["#7c8597", "#dce0e7", "#fff", "#3a3f4c"],
    method: ["#2b59c3", "#c7d3f0", "#fff", "#1e428f"],
    experiment: ["#0f766e", "#bfe0dc", "#fff", "#0b5550"],
    discussion: ["#6b6b66", "#dcdcd8", "#fff", "#3a3a36"],
    references: ["#a9a9a4", "#ececE8", "#1d1d1b", "#5c5c57"],
    appendix: ["#a9a9a4", "#ececE8", "#1d1d1b", "#5c5c57"],
  };

  const CSS = `
body.deepread-has-bar #split-view { top: ${TOOLBAR + HEIGHT}px !important; }
#deepread-bar { position: absolute; top: ${TOOLBAR}px; inset-inline-start: 0; inset-inline-end: 0; height: ${HEIGHT}px; z-index: 3;
  box-sizing: border-box; padding: 5px 10px; display: flex; align-items: center; gap: 10px;
  background: var(--material-toolbar, #f6f6f4); border-bottom: 1px solid var(--color-panedivider, rgba(0,0,0,0.12));
  font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
body.sidebar-open #deepread-bar { inset-inline-start: var(--sidebar-width); }
#deepread-bar .dr-segs { position: relative; flex: 1; min-width: 0; display: flex; gap: 2px; height: 20px; }
#deepread-bar .dr-seg { position: relative; min-width: 10px; border: none; margin: 0; padding: 0 6px; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; text-align: start; font: inherit; font-weight: 500; line-height: 20px; cursor: pointer; }
#deepread-bar .dr-seg:first-child { border-start-start-radius: 4px; border-end-start-radius: 4px; }
#deepread-bar .dr-seg:last-child { border-start-end-radius: 4px; border-end-end-radius: 4px; }
#deepread-bar .dr-seg.dr-current { box-shadow: inset 0 0 0 1.5px #1d1d1b; }
#deepread-bar .dr-seg:hover { filter: brightness(0.96); }
#deepread-bar .dr-here { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-inline-start: -1px; border-radius: 1px;
  background: #1d1d1b; pointer-events: none; transition: inset-inline-start .15s; }
#deepread-bar .dr-read { flex-shrink: 0; color: var(--fill-secondary, #4a4a46); white-space: nowrap; }
:root[data-color-scheme="dark"] #deepread-bar .dr-here { background: #f2f2f2; }
:root[data-color-scheme="dark"] #deepread-bar .dr-seg.dr-current { box-shadow: inset 0 0 0 1.5px #f2f2f2; }
`;

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  DeepRead.StructureBar = class StructureBar {
    constructor(session) {
      this.session = session;
      this.root = null;
      this.sections = [];
      this._cleanup = [];
      this._raf = null;
    }

    get enabled() {
      return DeepRead.Modules.enabled(this.session, "structureBar");
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.pdfWin = view._iframeWindow;
      this.app = (this.pdfWin.wrappedJSObject || this.pdfWin).PDFViewerApplication;
      const container = this.pdfWin.document.getElementById("viewerContainer");
      const onScroll = () => this.schedule();
      container?.addEventListener("scroll", onScroll, { passive: true });
      this._cleanup.push(() => container?.removeEventListener("scroll", onScroll));
      const onPages = Components.utils.exportFunction(() => this.schedule(), this.pdfWin);
      try {
        this.app.eventBus.on("pagesloaded", onPages);
        this.app.eventBus.on("scalechanging", onPages);
      }
      catch (e) {}
      this._cleanup.push(() => {
        try {
          this.app.eventBus.off("pagesloaded", onPages);
          this.app.eventBus.off("scalechanging", onPages);
        }
        catch (e) {}
      });
      this.attached = true;
      this.refresh();
    }

    detach() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      if (this._raf && this.readerWin) this.readerWin.cancelAnimationFrame(this._raf);
      this._raf = null;
      this._remove();
      this.attached = false;
    }

    _remove() {
      this.root?.remove();
      this.root = null;
      this.readerDoc?.body?.classList.remove("deepread-has-bar");
    }

    /** Rebuild from the session's content list (call after results or module switches change). */
    refresh() {
      if (!this.attached) return;
      const contentList = this.session.data?.contentList;
      this.sections = this.enabled && Array.isArray(contentList) ? DeepRead.Structure.sections(contentList) : [];
      if (this.sections.length < 2) {
        this._remove();
        return;
      }
      this._build();
      this.schedule();
    }

    _build() {
      const doc = this.readerDoc;
      if (!doc.getElementById("deepread-bar-css")) {
        const style = el(doc, "style");
        style.id = "deepread-bar-css";
        style.textContent = CSS;
        (doc.head || doc.documentElement).append(style);
        this._cleanup.push(() => doc.getElementById("deepread-bar-css")?.remove());
      }
      this._remove();
      const root = el(doc, "div");
      root.id = "deepread-bar";
      root.setAttribute("role", "navigation");
      root.setAttribute("aria-label", DeepRead.bilingual("全文结构", "Paper structure"));
      const segs = el(doc, "div", "dr-segs");
      this.total = Math.max(...this.sections.map((s) => s.end)) || 1;
      this.segs = this.sections.map((section) => {
        const button = el(doc, "button", "dr-seg", section.label);
        button.style.flex = `${Math.max(0.15, section.end - section.start)} 1 0`;
        const pages = `p.${Math.floor(section.start) + 1}–${Math.max(Math.floor(section.start) + 1, Math.ceil(section.end))}`;
        button.title = `${section.label} · ${pages}`;
        button.addEventListener("click", () => this._goTo(section));
        segs.append(button);
        return button;
      });
      this.here = el(doc, "span", "dr-here");
      segs.append(this.here);
      this.readLabel = el(doc, "span", "dr-read");
      root.append(segs, this.readLabel);
      doc.body.append(root);
      doc.body.classList.add("deepread-has-bar");
      this.root = root;
      this.segBox = segs;
    }

    /** Jump to the section heading itself (sections often start mid-page); reader.navigate would centre it. */
    _goTo(section) {
      const pageIndex = Math.floor(section.start);
      const viewer = this.app?.pdfViewer;
      const container = viewer?.container;
      const div = viewer?.getPageView(pageIndex)?.div;
      if (!container || !div) {
        this.session.reader.navigate({ pageIndex });
        return;
      }
      const page = div.getBoundingClientRect();
      const offset = page.top - container.getBoundingClientRect().top + (section.start - pageIndex) * page.height;
      container.scrollTop = Math.max(0, container.scrollTop + offset - 24);
    }

    schedule() {
      if (!this.root || this._raf) return;
      this._raf = this.readerWin.requestAnimationFrame(() => {
        this._raf = null;
        try {
          this._update();
        }
        catch (e) {
          DeepRead.log("structure bar update failed", String(e));
        }
      });
    }

    /** Fractional page position (page index + fraction) at a scroll offset of the viewer. */
    _positionAt(offset) {
      const viewer = this.app?.pdfViewer;
      const container = viewer?.container;
      if (!container) return 0;
      const top = container.getBoundingClientRect().top - container.scrollTop;
      const count = viewer.pagesCount || 0;
      for (let i = 0; i < count; i++) {
        const div = viewer.getPageView(i)?.div;
        if (!div) continue;
        const r = div.getBoundingClientRect();
        const start = r.top - top;
        if (offset < start + r.height || i === count - 1) {
          return i + Math.min(1, Math.max(0, (offset - start) / (r.height || 1)));
        }
      }
      return 0;
    }

    _update() {
      const container = this.app?.pdfViewer?.container;
      if (!container || !this.root) return;
      // Reading line a little below the top edge: jumps land with padding above the heading.
      const now = this._positionAt(container.scrollTop + container.clientHeight * 0.2);
      const seen = this._positionAt(container.scrollTop + container.clientHeight * 0.85);
      const state = this.session.userState;
      if (seen > (state.readUpTo || 0)) {
        state.readUpTo = Math.round(seen * 100) / 100;
        this.session._saveUserStateSoon();
      }
      const readUpTo = state.readUpTo || 0;
      this.sections.forEach((section, i) => {
        const [dark, light, onDark, onLight] = COLORS[section.role] || COLORS.method;
        const span = section.end - section.start || 1;
        const read = Math.max(0, Math.min(1, (readUpTo - section.start) / span));
        const pct = Math.round(read * 100);
        const seg = this.segs[i];
        seg.style.background = `linear-gradient(90deg, ${dark} 0 ${pct}%, ${light} ${pct}% 100%)`;
        // The label sits at the start of the segment: light text once the read fill covers its middle.
        const labelMid = Math.min(seg.scrollWidth, seg.offsetWidth) / 2;
        seg.style.color = read * seg.offsetWidth > labelMid ? onDark : onLight;
        seg.classList.toggle("dr-current", now >= section.start && now < section.end);
      });
      // Marker: place it inside the current section's button (flex sizes are not linear in pages).
      const index = DeepRead.Structure.sectionAt(this.sections, Math.floor(now), (now % 1) * 1000);
      if (index >= 0) {
        const section = this.sections[index];
        const seg = this.segs[index];
        const frac = Math.max(0, Math.min(1, (now - section.start) / (section.end - section.start || 1)));
        this.here.style.insetInlineStart = `${seg.offsetLeft + frac * seg.offsetWidth}px`;
        this.here.hidden = false;
      }
      else this.here.hidden = true;
      const pages = this.app.pdfViewer.pagesCount || this.total;
      this.readLabel.textContent = DeepRead.bilingual(`已读 ${Math.min(100, Math.round((readUpTo / pages) * 100))}%`,
        `${Math.min(100, Math.round((readUpTo / pages) * 100))}% read`);
    }
  };
})();
