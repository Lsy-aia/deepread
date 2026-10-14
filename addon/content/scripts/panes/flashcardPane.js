/* "闪卡" section: page-anchored Q&A study cards with review mode, inline editing and note export.
 * License: AGPL-3.0-or-later */
/* global DeepRead, Services */

(function () {
  const t = (zh, en) => DeepRead.bilingual(zh, en);

  function confirmDelete() {
    try {
      return Services.prompt.confirm(null, "DeepRead", t("删除这张闪卡？", "Delete this flashcard?"));
    }
    catch (e) {
      return true;
    }
  }

  function renderEditor(ctx, root, card) {
    const { h, session } = ctx;
    const question = h("textarea", { class: "dr-fc-input", rows: "2", placeholder: t("问题", "Question") });
    question.value = card.question || "";
    const answer = h("textarea", { class: "dr-fc-input", rows: "4", placeholder: t("答案（支持 Markdown / $公式$）", "Answer (Markdown / $math$)") });
    answer.value = card.answer || "";
    const note = h("textarea", { class: "dr-fc-input", rows: "3", placeholder: t("我的理解（始终展开显示）", "My understanding (always shown)") });
    note.value = card.note || "";
    const message = h("div", { class: "dr-small dr-muted dr-fc-msg" });
    const aiButton = h("button", { class: "dr-link-button" }, t("AI 生成答案", "AI answer"));
    const saveButton = h("button", { class: "dr-primary-button" }, t("保存", "Save"));
    const cancelButton = h("button", { class: "dr-link-button" }, t("取消", "Cancel"));
    let controller = null;

    const close = () => {
      controller?.abort();
      root._editingId = null;
      render(ctx, root);
    };

    aiButton.addEventListener("click", async () => {
      if (controller) {
        controller.abort();
        return;
      }
      const q = question.value.trim();
      if (!q) {
        message.textContent = t("请先填写问题", "Enter a question first");
        return;
      }
      controller = new AbortController();
      aiButton.textContent = t("停止", "Stop");
      message.textContent = t("生成中…", "Generating…");
      try {
        const text = await DeepRead.Flashcards.answer({
          question: q,
          quote: card.quote,
          context: session.flashcardContext(card.pageIndex),
          signal: controller.signal,
        });
        answer.value = text;
        message.textContent = "";
      }
      catch (error) {
        message.textContent = "";
        if (error?.name !== "AbortError") DeepRead.Panes.reportError(session, error);
      }
      finally {
        controller = null;
        aiButton.textContent = t("AI 生成答案", "AI answer");
      }
    });

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        controller?.abort();
        await session.saveFlashcard({ ...card, question: question.value, answer: answer.value, note: note.value });
        root._editingId = null;
        render(ctx, root);
      }
      catch (error) {
        saveButton.disabled = false;
        message.textContent = DeepRead.util.formatError(error);
      }
    });
    cancelButton.addEventListener("click", close);

    return h("div", { class: "dr-fc-editor" },
      question, answer, note, message,
      h("div", { class: "dr-fc-actions" }, saveButton, cancelButton, aiButton));
  }

  function renderCard(ctx, root, card) {
    const { h, doc, session } = ctx;
    const el = h("section", { class: "dr-fc-card", dataset: { id: card.id } });
    const editing = root._editingId === card.id;
    el.append(h("div", { class: "dr-fc-head" },
      h("span", { class: "dr-chip dr-fc-page" }, `p. ${card.pageIndex + 1}`),
      editing ? null : h("div", { class: "dr-fc-actions" },
        h("button", {
          class: "dr-link-button",
          onclick: () => session.navigateToFlashcard(card).catch((e) => DeepRead.Panes.reportError(session, e)),
        }, t("原文", "Source")),
        h("button", {
          class: "dr-link-button",
          onclick: () => {
            root._editingId = card.id;
            render(ctx, root);
          },
        }, t("编辑", "Edit")),
        h("button", {
          class: "dr-link-button dr-fc-delete",
          onclick: async () => {
            if (!confirmDelete()) return;
            try {
              await session.deleteFlashcard(card.id);
            }
            catch (e) {
              DeepRead.Panes.reportError(session, e);
            }
          },
        }, t("删除", "Delete")))));

    if (editing) {
      if (card.quote) el.append(h("div", { class: "dr-fc-quote dr-muted" }, card.quote));
      el.append(renderEditor(ctx, root, card));
      return el;
    }

    el.append(h("div", { class: "dr-fc-question" }, card.question || t("（无问题）", "(no question)")));
    if (card.quote) el.append(h("div", { class: "dr-fc-quote dr-muted", title: card.quote }, card.quote));
    const hidden = root._review && !root._flipped.has(card.id);
    if (hidden) {
      el.classList.add("dr-clickable", "dr-fc-hidden");
      el.append(h("div", { class: "dr-fc-reveal dr-muted dr-small" }, t("点击卡片显示答案", "Click the card to reveal the answer")));
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        root._flipped.add(card.id);
        render(ctx, root);
      });
    }
    else if (card.answer) {
      const answer = h("div", { class: "dr-fc-answer dr-markdown" });
      answer.append(DeepRead.Markdown.render(doc, card.answer, root));
      DeepRead.Markdown.wireLinks(answer);
      el.append(answer);
      if (root._review) {
        el.classList.add("dr-clickable");
        el.addEventListener("click", (e) => {
          if (e.target.closest("button, a, .katex")) return;
          root._flipped.delete(card.id);
          render(ctx, root);
        });
      }
    }
    else {
      el.append(h("div", { class: "dr-muted dr-small" }, t("尚无答案，点击「编辑」填写或让 AI 生成。", "No answer yet; click Edit to write one or let AI generate it.")));
    }
    // The reader's own understanding is never hidden, not even in review mode.
    if (card.note) {
      el.append(h("div", { class: "dr-fc-note" },
        h("div", { class: "dr-fc-note-label" }, t("我的理解", "My understanding")),
        h("div", { class: "dr-fc-note-text" }, card.note)));
    }
    return el;
  }

  function render(ctx, root) {
    const { h, session } = ctx;
    const cards = session.flashcards;
    root.replaceChildren();
    if (!cards) {
      root.append(h("div", { class: "dr-muted" }, "…"));
      return;
    }
    if (!cards.length) {
      root.append(h("div", { class: "dr-empty" },
        h("div", { class: "dr-muted" }, t(
          "还没有闪卡。在 PDF 中选中文字后点击「闪卡」，或点击段落卡片上的「卡」按钮即可创建。",
          "No flashcards yet. Select text in the PDF and click “Flashcard”, or use the “卡” button on a paragraph card.")),
        h("div", { class: "dr-muted dr-small" }, t("卡片会按阅读顺序排列，可复习并导出为 Zotero 笔记。", "Cards are listed in reading order, can be reviewed and exported to a Zotero note."))));
      return;
    }

    const message = h("div", { class: "dr-small dr-muted dr-fc-msg" });
    const reviewBox = h("input", { type: "checkbox", id: "dr-fc-review" });
    reviewBox.checked = !!root._review;
    reviewBox.addEventListener("change", () => {
      root._review = reviewBox.checked;
      root._flipped.clear();
      render(ctx, root);
    });
    const exportButton = h("button", { class: "dr-link-button" }, t("导出为笔记", "Export to note"));
    exportButton.addEventListener("click", async () => {
      exportButton.disabled = true;
      try {
        const note = await DeepRead.Flashcards.exportToNote(session.parentItem, cards, { paragraphNotes: session.paragraphNotesList() });
        const noteTitle = note.getNoteTitle?.() || "";
        message.textContent = t(`已导出为笔记：${noteTitle}`, `Exported to note: ${noteTitle}`);
      }
      catch (error) {
        DeepRead.Panes.reportError(session, error);
      }
      finally {
        exportButton.disabled = false;
      }
    });

    root.append(h("div", { class: "dr-fc-header" },
      h("span", { class: "dr-fc-count" }, t(`${cards.length} 张闪卡`, `${cards.length} flashcard${cards.length === 1 ? "" : "s"}`)),
      h("label", { class: "dr-fc-toggle", for: "dr-fc-review" }, reviewBox, t("复习模式", "Review")),
      exportButton), message);
    for (const card of cards) root.append(renderCard(ctx, root, card));
  }

  DeepRead.Panes.renderers.flashcards = (ctx) => {
    const { body, session, h, event } = ctx;
    if (event !== "change" && event !== "flashcards") return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    let root = body.querySelector(":scope > .dr-fc-pane");
    if (!root || root._session !== session) {
      root = h("div", { class: "dr-pane dr-fc-pane" });
      root._session = session;
      root._review = false;
      root._flipped = new Set();
      root._editingId = null;
      body.replaceChildren(root);
    }
    if (!session.flashcards) {
      render(ctx, root);
      session.loadFlashcards().catch((e) => DeepRead.Panes.reportError(session, e));
      return;
    }
    // Do not rebuild while an edit form is open, unless the edited card is gone.
    if (root._editingId) {
      if (session.flashcards.some((c) => c.id === root._editingId)) return;
      root._editingId = null;
    }
    render(ctx, root);
  };
})();
