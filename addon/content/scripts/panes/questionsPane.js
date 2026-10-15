/* "阅读问题" (question-led reading) and "术语与符号" (hover-lookup glossary) sections.
 * License: AGPL-3.0-or-later */
/* global DeepRead */

(function () {
  const revealed = new WeakMap(); // session → Set(question id) answers shown early by the reader

  function blockChip(h, session, key) {
    const m = /^p_(\d+)_(\d+)$/.exec(key || "");
    if (!m) return null;
    const page = Number(m[1]);
    const para = Number(m[2]);
    return h("span", {
      class: "dr-q-chip dr-clickable",
      title: DeepRead.bilingual("跳到这一段并打开卡片", "Go to the paragraph and open its card"),
      onclick: () => session.openBlock(page, para),
    }, `p. ${page + 1} ¶${para + 1}`);
  }

  function markdown(doc, text) {
    const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    box.append(DeepRead.Markdown.render(doc, text || ""));
    return box;
  }

  DeepRead.Panes.renderers.questions = (ctx) => {
    const { body, doc, session, h, event } = ctx;
    if (event === "ask" || String(event).startsWith("chat")) return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    const root = h("div", { class: "dr-pane dr-questions-pane" });
    if (!DeepRead.Modules.enabled(session, "questions")) {
      root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("问题导向已在「功能」菜单中关闭。", "Question-led reading is off in the Features menu.")));
      body.replaceChildren(root);
      return;
    }
    const items = session.questions?.items || [];
    const hide = DeepRead.prefs.get("questions.hideAnswers") === true;
    const shown = revealed.get(session) || new Set();
    revealed.set(session, shown);

    const progress = session.questionProgress();
    const head = h("div", { class: "dr-q-head" },
      h("span", { class: "dr-muted" }, items.length
        ? DeepRead.bilingual(`已读到 ${progress.reached} / ${progress.total} 个答案`, `Answers reached: ${progress.reached} / ${progress.total}`)
        : DeepRead.bilingual("带着问题读：精读后 AI 给出 5 个问题和答案出处", "Read with questions: after the deep read the AI answers five questions and points to the paragraphs")),
      h("label", { class: "dr-q-hide" },
        h("input", {
          type: "checkbox",
          checked: hide || null,
          onchange: (e) => {
            DeepRead.prefs.set("questions.hideAnswers", !!e.target.checked);
            session._emit("questions");
          },
        }),
        DeepRead.bilingual("先自己想，读到时再揭晓", "Hide answers until I get there")));
    root.append(head);

    if (session.generatingQuestions) root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("正在生成阅读问题…", "Writing the reading questions…")));
    if (!items.length && !session.generatingQuestions) {
      root.append(h("div", { class: "dr-empty" },
        session.hasResults
          ? h("button", {
            class: "dr-primary-button",
            onclick: () => session.generateQuestions().catch((e) => DeepRead.Panes.reportError(session, e)),
          }, DeepRead.bilingual("生成阅读问题", "Write the reading questions"))
          : h("div", { class: "dr-muted" }, DeepRead.t("error.noParseData"))));
    }

    const list = h("div", { class: "dr-q-list" });
    for (const q of items) {
      const reached = session.questionReached(q);
      const item = h("div", { class: `dr-q-item${reached ? " dr-reached" : ""}${q.custom ? " dr-custom" : ""}` });
      item.append(h("div", { class: "dr-q-title" },
        h("span", { class: "dr-q-label" }, session.questionLabel(q)),
        h("span", { class: "dr-q-text" }, q.question),
        reached ? h("span", { class: "dr-q-state", title: DeepRead.bilingual("已读到答案所在的段落", "You have read the answer's paragraphs") }, "✓") : null,
        q.custom
          ? h("button", { class: "dr-q-remove", title: DeepRead.bilingual("删除这个问题", "Remove"), onclick: () => session.removeQuestion(q.id) }, "×")
          : null));
      if (q.pending) {
        item.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("AI 正在全文中找答案…", "Looking for the answer…")));
      }
      else if (hide && !reached && !shown.has(q.id) && q.answer) {
        const first = q.keys?.length ? session._paragraphByKey(q.keys[0]) : null;
        item.append(h("button", {
          class: "dr-q-reveal",
          onclick: () => {
            shown.add(q.id);
            session._emit("questions");
          },
        }, first
          ? DeepRead.bilingual(`读到第 ${first.page.pageIndex + 1} 页时揭晓 · 现在看`, `Revealed at p. ${first.page.pageIndex + 1} · show now`)
          : DeepRead.bilingual("显示答案", "Show the answer")));
      }
      else if (q.answer) {
        item.append(h("div", { class: "dr-q-answer" }, markdown(doc, q.answer)));
      }
      if (q.keys?.length && (!hide || reached || shown.has(q.id))) {
        item.append(h("div", { class: "dr-q-chips" }, q.keys.map((k) => blockChip(h, session, k))));
      }
      list.append(item);
    }
    root.append(list);

    if (session.hasResults) {
      const input = h("input", {
        type: "text",
        class: "dr-q-input",
        placeholder: DeepRead.bilingual("添加我的问题，AI 在全文中找答案…", "Add a question of your own…"),
      });
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        session.askQuestion(text).catch((e) => DeepRead.Panes.reportError(session, e));
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      root.append(h("div", { class: "dr-q-add" }, input, h("button", { class: "dr-primary-button", onclick: submit }, DeepRead.bilingual("提问", "Ask"))));
    }
    body.replaceChildren(root);
  };

  DeepRead.Panes.renderers.glossary = (ctx) => {
    const { body, doc, session, h, event } = ctx;
    if (event === "ask" || String(event).startsWith("chat")) return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    const root = h("div", { class: "dr-pane dr-glossary-pane" });
    if (!DeepRead.Modules.enabled(session, "lookup")) {
      root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("悬停查证已在「功能」菜单中关闭。", "Hover lookup is off in the Features menu.")));
      body.replaceChildren(root);
      return;
    }
    const glossary = session.glossary;
    if (session.buildingGlossary) root.append(h("div", { class: "dr-muted" }, DeepRead.bilingual("正在整理术语与符号…", "Collecting terms and symbols…")));
    if (!glossary && !session.buildingGlossary) {
      root.append(h("div", { class: "dr-empty" },
        h("div", { class: "dr-muted" }, DeepRead.bilingual("鼠标停在引用、图表引用、术语或符号上即可查看说明。术语和符号表需要先生成：",
          "Rest the pointer on a citation, figure reference, term or symbol to look it up. Terms and symbols need a glossary first:")),
        session.hasResults
          ? h("button", {
            class: "dr-primary-button",
            onclick: () => session.buildGlossary().catch((e) => DeepRead.Panes.reportError(session, e)),
          }, DeepRead.bilingual("生成术语与符号表", "Build the glossary"))
          : null));
    }
    const goTo = (key) => {
      const found = key ? session._paragraphByKey(key) : null;
      if (found) session.openBlock(found.page.pageIndex, found.paragraph.paragraphIndex);
    };
    const section = (title, entries, render) => {
      if (!entries?.length) return;
      root.append(h("div", { class: "dr-g-heading" }, title));
      const list = h("div", { class: "dr-g-list" });
      for (const entry of entries) list.append(render(entry));
      root.append(list);
    };
    section(DeepRead.bilingual("符号", "Symbols"), glossary?.symbols, (s) => {
      const name = h("span", { class: "dr-g-name" });
      name.append(DeepRead.Overlay.inlineMarkdown(doc, `$${s.symbol}$`));
      return h("div", { class: `dr-g-row${s.key ? " dr-clickable" : ""}`, title: s.key ? DeepRead.bilingual("跳到首次出现", "Go to its first use") : null, onclick: () => goTo(s.key) },
        name, h("span", { class: "dr-g-text" }, s.meaning));
    });
    section(DeepRead.bilingual("术语", "Terms"), glossary?.terms, (t) => h("div", {
      class: `dr-g-row${t.key ? " dr-clickable" : ""}`,
      title: t.key ? DeepRead.bilingual("跳到首次出现", "Go to its first use") : null,
      onclick: () => goTo(t.key),
    }, h("span", { class: "dr-g-name" }, t.aliases?.length ? `${t.term}（${t.aliases.join("、")}）` : t.term), h("span", { class: "dr-g-text" }, t.definition)));
    const refs = session.references().list;
    if (refs.length) root.append(h("div", { class: "dr-muted dr-g-foot" }, DeepRead.bilingual(`已识别 ${refs.length} 条参考文献，鼠标停在正文的引用上即可查看`, `${refs.length} references found; rest the pointer on a citation to see one`)));
    body.replaceChildren(root);
  };
})();
