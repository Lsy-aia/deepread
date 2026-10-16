/*
 * 带读 panel (module "guided"): a column at the right edge of the reader that takes the right card rail's
 * place while it is open. The content is drawn by DeepRead.GuideView from session.guide / session.guideRun;
 * this host owns placement, open/close, the running clock and the actions.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const HOST_CSS = `
#primary-view .deepread-guide { position: relative; flex: 0 0 440px; box-sizing: border-box; height: 100%; overflow: auto;
  border-inline-start: 1px solid var(--color-panedivider, rgba(0,0,0,0.12)); background: var(--material-sidepane, #f7f7f5); }
#primary-view.deepread-guide-open > .deepread-rail.dr-right { display: none; }
`;

  DeepRead.GuidePanel = class GuidePanel {
    constructor(session) {
      this.session = session;
      this.isOpen = false;
      this.step = 1;
      this._cleanup = [];
    }

    get enabled() {
      return DeepRead.Modules.enabled(this.session, "guided");
    }

    attach(view) {
      this.detach();
      this.view = view;
      this.readerWin = this.session.reader._iframeWindow;
      this.readerDoc = this.readerWin.document;
      this.container = view._iframe?.parentElement;
      const off = this.session.on((type) => {
        if (type === "guide" || type === "change" || type === "modules") {
          if (type === "modules" && !this.enabled) this.close();
          else this.render();
        }
      });
      this._cleanup.push(off);
    }

    detach() {
      for (const fn of this._cleanup.splice(0)) {
        try {
          fn();
        }
        catch (e) {}
      }
      this._stopClock();
      this.host?.remove();
      this.host = null;
      this.container?.classList.remove("deepread-guide-open");
      this.isOpen = false;
    }

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    }

    open(step) {
      if (!this.container || !this.enabled) return;
      if (step) this.step = step;
      const doc = this.readerDoc;
      if (!doc.getElementById("deepread-guide-css")) {
        const style = doc.createElementNS(HTML_NS, "style");
        style.id = "deepread-guide-css";
        style.textContent = HOST_CSS + (DeepRead.GuideView?.CSS || "");
        (doc.head || doc.documentElement).append(style);
        this._cleanup.push(() => doc.getElementById("deepread-guide-css")?.remove());
      }
      if (!this.host) {
        this.host = doc.createElementNS(HTML_NS, "div");
        this.host.className = "deepread-guide";
        this.host.setAttribute("role", "complementary");
        this.host.setAttribute("aria-label", DeepRead.bilingual("带读", "Guided reading"));
      }
      this.container.append(this.host);
      this.container.classList.add("deepread-guide-open");
      this.isOpen = true;
      this.render();
      this.session._emit("guidePanel");
    }

    close() {
      if (!this.isOpen) return;
      this.host?.remove();
      this.container?.classList.remove("deepread-guide-open");
      this.isOpen = false;
      this._stopClock();
      this.session.rail?.schedule(true); // the right rail is back
      this.session._emit("guidePanel");
    }

    _startClock() {
      if (this._clock) return;
      this._clock = this.readerWin.setInterval(() => this.render(), 1000);
    }

    _stopClock() {
      if (this._clock) this.readerWin?.clearInterval(this._clock);
      this._clock = null;
    }

    state() {
      const session = this.session;
      const run = session.guideRun;
      const guide = session.guide;
      const kind = guide?.meta?.kind || DeepRead.prefs.get("agent.kind") || "none";
      const kindLabel = {
        codex: DeepRead.bilingual("本地 Agent · Codex", "Local agent · Codex"),
        claude: DeepRead.bilingual("本地 Agent · Claude Code", "Local agent · Claude Code"),
        api: DeepRead.bilingual("远程 API", "Remote API"),
        import: DeepRead.bilingual("导入的结果", "Imported result"),
      }[kind] || DeepRead.bilingual("未选择 Agent", "No agent chosen");
      return {
        guide,
        step: this.step,
        status: run?.status || (guide ? "ready" : "empty"),
        error: run?.error || "",
        log: run?.log || "",
        elapsedSec: run?.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : 0,
        kindLabel,
        skills: guide?.meta?.skills || [],
        meta: guide?.meta || {},
        agentConfigured: session.agentConfigured(),
      };
    }

    actions() {
      const session = this.session;
      const report = (e) => {
        if (e?.name === "AbortError") return;
        DeepRead.log("guided reading failed", String(e));
        session._notify(DeepRead.util.formatError(e), "error");
        if (e?.configError) DeepRead.openPreferences();
      };
      return {
        setStep: (n) => {
          this.step = n;
          this.render();
          this.host?.scrollTo?.(0, 0);
        },
        run: () => session.runGuide().catch(report),
        cancel: () => session.cancelGuide(),
        importFile: () => session.pickGuideFile().catch(report),
        openSettings: () => DeepRead.openPreferences(),
        close: () => this.close(),
        openBlock: (key) => {
          const m = /^p_(\d+)_(\d+)$/.exec(key || "");
          if (m) session.openBlock(Number(m[1]), Number(m[2]));
        },
        saveNote: () => session.saveGuideNote()
          .then((note) => note && session._notify(DeepRead.bilingual("已保存为 Zotero 笔记", "Saved as a Zotero note"), "info"))
          .catch(report),
        copyMarkdown: () => {
          DeepRead.util.copyToClipboard(session.guideMarkdown());
          session._notify(DeepRead.bilingual("已复制 Markdown", "Markdown copied"), "info");
        },
      };
    }

    render() {
      if (!this.isOpen || !this.host || !DeepRead.GuideView) return;
      const state = this.state();
      if (state.status === "running" || state.status === "structuring") this._startClock();
      else this._stopClock();
      const scroll = this.host.scrollTop;
      try {
        DeepRead.GuideView.render(this.readerDoc, this.host, state, this.actions());
      }
      catch (e) {
        DeepRead.log("guide view failed", e?.stack || String(e));
      }
      this.host.scrollTop = scroll;
    }
  };
})();
