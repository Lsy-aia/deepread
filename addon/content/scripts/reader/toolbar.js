/*
 * Reader toolbar: "AI 精读" button with live progress, an options menu, and toasts.
 * Rendering the toolbar is also our signal that a reader opened, so sessions start here.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const CSS = `
.deepread-toolbar { display: flex; align-items: center; gap: 1px; }
.deepread-toolbar .dr-run { width: auto; min-width: 28px; padding: 0 8px; gap: 5px; font-size: 12px; font-weight: 600;
  color: var(--fill-primary, #222); white-space: nowrap; position: relative; overflow: hidden; }
.deepread-toolbar .dr-run .dr-run-progress { position: absolute; left: 0; bottom: 0; height: 2px; background: #3b82f6; transition: width .3s; }
.deepread-toolbar .dr-run.dr-ready::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #22c55e; }
.deepread-toolbar .dr-menu-button { width: 18px; font-size: 10px; }
.deepread-menu { position: fixed; z-index: 2147483001; min-width: 220px; padding: 4px; border-radius: 8px;
  background: var(--material-toolbar, #fff); color: var(--fill-primary, #222); border: 1px solid rgba(0,0,0,0.12);
  box-shadow: 0 8px 24px rgba(0,0,0,0.18); font: 12.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.deepread-menu button { display: flex; width: 100%; gap: 8px; align-items: center; text-align: start; padding: 5px 8px;
  border: none; background: transparent; color: inherit; border-radius: 5px; font: inherit; cursor: pointer; }
.deepread-menu button:hover { background: var(--fill-quinary, rgba(0,0,0,0.06)); }
.deepread-menu .dr-check { width: 14px; display: inline-block; }
.deepread-menu hr { border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: 4px 2px; }
.deepread-menu .dr-menu-heading { padding: 4px 8px 2px; font-size: 11px; opacity: 0.6; }
.deepread-toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483002; max-width: 380px; padding: 9px 12px;
  border-radius: 8px; background: #1f2328; color: #fff; font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, sans-serif;
  box-shadow: 0 6px 20px rgba(0,0,0,0.25); white-space: pre-wrap; }
.deepread-toast.dr-error { background: #b42318; }
.deepread-toast.dr-warning { background: #b54708; }
`;

  function h(doc, tag, props = {}, ...children) {
    const node = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    node.append(...children.flat().filter((c) => c !== null && c !== undefined));
    return node;
  }

  function injectCSS(doc) {
    if (doc.getElementById("deepread-toolbar-css")) return;
    const style = doc.createElementNS(HTML_NS, "style");
    style.id = "deepread-toolbar-css";
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
  }

  DeepRead.Toast = {
    show(doc, message, type = "info", ms = 4500) {
      if (!doc || !message) return;
      injectCSS(doc);
      doc.querySelector(".deepread-toast")?.remove();
      const toast = h(doc, "div", { class: `deepread-toast dr-${type}` }, String(message));
      (doc.body || doc.documentElement).append(toast);
      setTimeout(() => toast.remove(), type === "error" ? Math.max(ms, 8000) : ms);
    },
  };

  function confirm(reader, message) {
    return Services.prompt.confirm(reader._window || null, "DeepRead", message);
  }

  async function onRun(session, doc) {
    if (session.status === "running") {
      if (confirm(session.reader, DeepRead.bilingual("取消正在进行的精读？", "Cancel the running deep read?"))) session.cancel();
      return;
    }
    if (session.hasResults && !confirm(session.reader, DeepRead.t("toolbar.confirmRerun"))) return;
    try {
      await session.run();
      DeepRead.Toast.show(doc, DeepRead.t("flow.done"));
      DeepRead.Panes.reveal(session.reader, "summary");
    }
    catch (error) {
      DeepRead.Toast.show(doc, DeepRead.util.formatError(error), "error");
      if (error?.configError) DeepRead.openPreferences();
    }
  }

  function toggleOption(prefKey, optionKey) {
    const value = !(DeepRead.prefs.get(prefKey) !== false);
    DeepRead.prefs.set(prefKey, value);
    DeepRead.Session.forEachOverlay((overlay) => {
      if (optionKey) overlay.setOptions({ [optionKey]: value });
      overlay.session.rail?.refresh();
    });
  }

  function openMenu(session, doc, anchor) {
    doc.querySelector(".deepread-menu")?.remove();
    const check = (prefKey) => h(doc, "span", { class: "dr-check" }, DeepRead.prefs.get(prefKey) !== false ? "✓" : "");
    const close = () => {
      menu.remove();
      doc.removeEventListener("pointerdown", outside, true);
    };
    const outside = (e) => {
      if (!menu.contains(e.target)) close();
    };
    const item = (content, action) => h(doc, "button", {
      onclick: (e) => {
        e.stopPropagation();
        close();
        action();
      },
    }, ...content);
    const menu = h(doc, "div", { class: "deepread-menu" },
      item([h(doc, "span", { class: "dr-check" }), session.hasResults ? DeepRead.t("toolbar.rerun") : DeepRead.t("toolbar.run")],
        () => onRun(session, doc)),
      h(doc, "hr"),
      item([check("view.marginCards"), DeepRead.bilingual("页边卡片", "Margin cards")], () => toggleOption("view.marginCards", null)),
      item([h(doc, "span", { class: "dr-check" }, DeepRead.prefs.get("view.railLayout") !== "right" ? "✓" : ""),
        DeepRead.bilingual("双栏卡片（左栏段落放左边）", "Split cards (left-column paragraphs on the left)")], () => {
        DeepRead.prefs.set("view.railLayout", DeepRead.prefs.get("view.railLayout") === "right" ? "split" : "right");
        DeepRead.Session.forEachOverlay((overlay) => overlay.session.rail?.refresh());
      }),
      item([check("view.highlights"), DeepRead.t("toolbar.showHighlights")], () => toggleOption("view.highlights", "highlights")),
      item([check("view.hoverCards"), DeepRead.t("toolbar.showCards")], () => toggleOption("view.hoverCards", "hoverCards")),
      item([check("view.translationPopup"), DeepRead.t("toolbar.showTranslation")], () => toggleOption("view.translationPopup", "translationPopup")),
      session.hiddenCardCount
        ? item([h(doc, "span", { class: "dr-check" }), DeepRead.bilingual(`显示已隐藏的卡片（${session.hiddenCardCount}）`, `Show hidden cards (${session.hiddenCardCount})`)],
          () => session.showHiddenCards())
        : null,
      h(doc, "hr"),
      item([h(doc, "span", { class: "dr-check" }), DeepRead.bilingual("DeepRead 设置…", "DeepRead settings…")], () => DeepRead.openPreferences()),
      session.hasResults
        ? item([h(doc, "span", { class: "dr-check" }), DeepRead.t("toolbar.clear")], async () => {
          if (confirm(session.reader, DeepRead.t("toolbar.confirmClear"))) await session.clearResults();
        })
        : null);
    (doc.body || doc.documentElement).append(menu);
    const r = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(4, Math.min(r.left, doc.documentElement.clientWidth - width - 4))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    doc.addEventListener("pointerdown", outside, true);
  }

  function openTranslateMenu(session, doc, anchor) {
    doc.querySelector(".deepread-menu")?.remove();
    const close = () => {
      menu.remove();
      doc.removeEventListener("pointerdown", outside, true);
    };
    const outside = (e) => {
      if (!menu.contains(e.target)) close();
    };
    const item = (label, action, marked = "") => h(doc, "button", {
      onclick: (e) => {
        e.stopPropagation();
        close();
        action();
      },
    }, h(doc, "span", { class: "dr-check" }, marked), label);
    const heading = (text) => h(doc, "div", { class: "dr-menu-heading" }, text);
    const fail = (error) => {
      DeepRead.Toast.show(doc, DeepRead.util.formatError(error), "error");
      if (error?.configError) DeepRead.openPreferences();
    };
    const modeLabel = (mode) => (mode === "dual"
      ? DeepRead.bilingual("双栏对照（左原文·右译文）", "side by side")
      : DeepRead.bilingual("原位译文（保留排版）", "in place"));

    // Built-in engine: translate the parsed blocks with the DeepRead model, overlay in place, export PDF.
    const builtin = [heading(DeepRead.bilingual("内置翻译（DeepRead 模型）", "Built-in (DeepRead model)"))];
    const done = !!session.fullTranslation;
    const translateAll = () => session.translateFull()
      .then((result) => result && DeepRead.Toast.show(doc, session.translation?.message || DeepRead.bilingual("翻译完成", "Done")))
      .catch(fail);
    if (!done) {
      builtin.push(item(DeepRead.bilingual("翻译全文（在原文上显示译文）", "Translate the document"), translateAll));
    }
    else {
      builtin.push(item(DeepRead.bilingual("显示译文", "Show translation"), () => session.setTranslationView(!session.translationView), session.translationView ? "✓" : ""));
      for (const mode of ["dual", "inplace"]) {
        builtin.push(item(DeepRead.bilingual(`导出 PDF · ${modeLabel(mode)}`, `Export PDF · ${modeLabel(mode)}`), () => session.exportTranslatedPDF(mode)
          .then((attachment) => attachment && DeepRead.Toast.show(doc, DeepRead.bilingual("译文 PDF 已保存为附件并打开", "Translated PDF saved and opened")))
          .catch(fail)));
      }
      builtin.push(item(DeepRead.bilingual("重新翻译全文", "Translate again"), () => {
        if (confirm(session.reader, DeepRead.bilingual("重新翻译会覆盖已有译文，继续？", "Replace the existing translation?"))) translateAll();
      }));
    }

    // Optional ReadFlow engine: only when enabled in settings.
    const readflow = [];
    if (DeepRead.ReadFlowLauncher?.enabled && DeepRead.ReadFlow) {
      const defaultMode = DeepRead.prefs.get("readflow.defaultMode") === "inplace" ? "inplace" : "dual";
      readflow.push(heading(DeepRead.bilingual("ReadFlow 引擎", "ReadFlow engine")));
      for (const mode of ["dual", "inplace"]) {
        readflow.push(item(`ReadFlow · ${modeLabel(mode)}`, () => session.translateDocument(mode)
          .then((attachment) => attachment && DeepRead.Toast.show(doc, DeepRead.bilingual("译文已保存为附件并打开", "Translated PDF saved and opened")))
          .catch(fail), mode === defaultMode ? "•" : ""));
      }
    }

    const existing = [];
    for (const mode of ["dual", "inplace"]) {
      const attachment = session.existingTranslation(mode);
      if (attachment) {
        existing.push(item(DeepRead.bilingual(`打开已有${DeepRead.Session.translationTitle(mode)}`, `Open existing ${DeepRead.Session.translationTitle(mode)}`),
          () => Zotero.Reader.open(attachment.id)));
      }
    }

    const sections = DeepRead.prefs.get("translate.engine") === "readflow" && readflow.length
      ? [readflow, builtin, existing]
      : [builtin, readflow, existing];
    const entries = [];
    for (const section of sections.filter((list) => list.length)) {
      if (entries.length) entries.push(h(doc, "hr"));
      entries.push(...section);
    }
    const menu = h(doc, "div", { class: "deepread-menu" }, ...entries, h(doc, "hr"),
      item(DeepRead.bilingual("翻译设置…", "Translation settings…"), () => DeepRead.openPreferences()));
    (doc.body || doc.documentElement).append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.left, doc.documentElement.clientWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    doc.addEventListener("pointerdown", outside, true);
  }

  function render(event) {
    const { reader, doc, append } = event;
    const session = DeepRead.Session.forReader(reader);
    if (!session) return;
    injectCSS(doc);
    doc.querySelectorAll(".deepread-toolbar").forEach((node) => node.remove());

    const progress = h(doc, "div", { class: "dr-run-progress" });
    const label = h(doc, "span", {}, DeepRead.t("toolbar.run"));
    const runButton = h(doc, "button", { class: "toolbar-button dr-run", onclick: () => onRun(session, doc) }, label, progress);
    const menuButton = h(doc, "button", {
      class: "toolbar-button dr-menu-button",
      title: DeepRead.t("toolbar.menu"),
      onclick: (e) => openMenu(session, doc, e.currentTarget),
    }, "▾");
    const translateLabel = h(doc, "span", {}, DeepRead.bilingual("整篇翻译", "Translate"));
    const translateProgress = h(doc, "div", { class: "dr-run-progress" });
    const translateButton = h(doc, "button", {
      class: "toolbar-button dr-run dr-translate",
      onclick: (e) => {
        if (session.translation?.status === "running") {
          if (confirm(session.reader, DeepRead.bilingual("取消正在进行的整篇翻译？", "Cancel the running translation?"))) session.cancelTranslation();
          return;
        }
        openTranslateMenu(session, doc, e.currentTarget);
      },
    }, translateLabel, translateProgress);
    const container = h(doc, "div", { class: "deepread-toolbar" }, runButton, menuButton, translateButton);
    const updateTranslate = () => {
      const job = session.translation;
      const running = job?.status === "running";
      translateLabel.textContent = running
        ? `${DeepRead.bilingual("翻译", "Translating")} ${Math.round(job.percent || 0)}%`
        : DeepRead.bilingual("整篇翻译", "Translate");
      translateButton.title = running
        ? `${job.message || ""}\n${DeepRead.bilingual("点击取消", "Click to cancel")}`
        : (job?.status === "error" ? job.message : DeepRead.bilingual("整篇翻译：在原文上显示译文，可导出译文 PDF", "Translate the whole document; export a translated PDF"));
      translateButton.classList.toggle("dr-ready", !!session.translationView && !running);
      translateProgress.style.width = running ? `${Math.max(2, job.percent || 0)}%` : "0";
    };

    const update = () => {
      const running = session.status === "running";
      label.textContent = running
        ? `${DeepRead.bilingual("精读", "Reading")} ${Math.round(session.progress.percent || 0)}%`
        : DeepRead.t("toolbar.run");
      runButton.title = running
        ? `${session.progress.message || ""}\n${DeepRead.bilingual("点击取消", "Click to cancel")}`
        : (session.hasResults ? DeepRead.bilingual("已精读 · 点击重新精读", "Deep-read · click to run again") : DeepRead.t("toolbar.run"));
      runButton.classList.toggle("dr-ready", session.hasResults && !running);
      progress.style.width = running ? `${Math.max(2, session.progress.percent || 0)}%` : "0";
    };
    const unsubscribe = session.on((type, payload) => {
      if (!container.isConnected) {
        unsubscribe();
        return;
      }
      if (type === "notify" && payload?.message) {
        DeepRead.Toast.show(doc, payload.message, payload.type);
        return;
      }
      if (type === "change" || type === "progress") update();
      if (type === "translation") updateTranslate();
    });
    update();
    updateTranslate();
    append(container);
    session.init().then(update);
  }

  DeepRead.Toolbar = {
    register(pluginID) {
      Zotero.Reader.registerEventListener("renderToolbar", (event) => {
        try {
          render(event);
        }
        catch (e) {
          DeepRead.log("renderToolbar failed", e?.stack || String(e));
        }
      }, pluginID);
      // Readers that were already open when the plugin started.
      for (const reader of Zotero.Reader._readers || []) {
        if (reader.type === "pdf") DeepRead.Session.forReader(reader)?.init();
      }
    },
  };
})();
