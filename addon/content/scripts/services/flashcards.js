/*
 * Flashcards: page-anchored Q&A study cards stored in deepread.sqlite (table `flashcards`),
 * LLM-assisted question/answer generation and export to a Zotero note.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, crypto */

(function () {
  const MAX_QUOTE = 3000;
  const MAX_PAGE_TEXT = 6000;
  const MAX_ABSTRACT = 2500;

  const isoNow = () => new Date().toISOString();
  const str = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());

  function newID() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `fc_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  function topOf(card) {
    let top = -Infinity;
    for (const r of card.rects || []) top = Math.max(top, r[1], r[3]);
    return top;
  }

  function languageInstruction() {
    const langs = DeepRead.PARSE_LANGUAGES || {};
    const lang = langs[DeepRead.prefs.language()] || langs.zh;
    return lang?.instruction || "Simplified Chinese";
  }

  function contextBlock(context) {
    const c = context || {};
    const parts = [];
    if (c.title) parts.push(`Title: ${c.title}`);
    if (c.abstract) parts.push(`Abstract: ${String(c.abstract).slice(0, MAX_ABSTRACT)}`);
    if (c.pageText) parts.push(`Text of the page:\n${String(c.pageText).slice(0, MAX_PAGE_TEXT)}`);
    return parts.join("\n\n");
  }

  function escapeHTML(text) {
    return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function paragraphsHTML(text) {
    return String(text ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .map((p) => `<p>${escapeHTML(p).replace(/\n/g, "<br/>")}</p>`).join("\n");
  }

  function parseJSONObject(text) {
    let s = String(text || "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object") return v;
    }
    catch (e) { /* fall through */ }
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      }
      catch (e) { /* fall through */ }
    }
    return null;
  }

  DeepRead.Flashcards = {
    async init() {
      const db = DeepRead.Store.db;
      await db.queryAsync(`CREATE TABLE IF NOT EXISTS flashcards (
        id TEXT PRIMARY KEY,
        attachment_key TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`);
      await db.queryAsync("CREATE INDEX IF NOT EXISTS flashcards_attachment_key ON flashcards (attachment_key)");
    },

    /** Normalize and validate a card; throws on invalid input. */
    validate(card) {
      if (!card || typeof card !== "object") throw new Error("Invalid flashcard");
      const pageIndex = card.pageIndex;
      if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("Invalid flashcard: pageIndex must be an integer >= 0");
      const rects = card.rects === undefined || card.rects === null ? [] : card.rects;
      if (!Array.isArray(rects) || !rects.every((r) => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n)))) {
        throw new Error("Invalid flashcard: rects must be an array of [x1,y1,x2,y2]");
      }
      const quote = str(card.quote);
      const question = str(card.question);
      if (!question && !quote) throw new Error("Invalid flashcard: question is empty");
      return {
        ...card,
        pageIndex,
        rects: rects.map((r) => r.slice()),
        quote,
        question,
        answer: str(card.answer),
        note: str(card.note), // the reader's own understanding (never folded in the UI)
        paragraphKey: str(card.paragraphKey), // "p_<page>_<paragraph>" when attached to a paragraph card
        color: str(card.color),
        source: ["selection", "paragraph", "manual"].includes(card.source) ? card.source : "manual",
      };
    },

    sort(cards) {
      return [...(cards || [])].sort((a, b) =>
        (a.pageIndex - b.pageIndex)
        || (topOf(b) - topOf(a) || 0)
        || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    },

    async list(attachmentKey) {
      const rows = await DeepRead.Store.db.queryAsync("SELECT data FROM flashcards WHERE attachment_key = ?", [attachmentKey]);
      const cards = [];
      for (const row of rows || []) {
        try {
          const card = JSON.parse(row.data);
          if (card && typeof card === "object") cards.push(card);
        }
        catch (e) {
          DeepRead.log("corrupt flashcard row skipped", String(e));
        }
      }
      return this.sort(cards);
    },

    async save(attachmentKey, card) {
      const clean = this.validate(card);
      delete clean._busy;
      const now = isoNow();
      clean.id = clean.id || newID();
      clean.createdAt = clean.createdAt || now;
      clean.updatedAt = now;
      const created = Math.floor(Date.parse(clean.createdAt) / 1000) || Math.floor(Date.now() / 1000);
      await DeepRead.Store.db.queryAsync(
        "INSERT OR REPLACE INTO flashcards (id, attachment_key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [clean.id, attachmentKey, JSON.stringify(clean), created, Math.floor(Date.now() / 1000)]
      );
      return clean;
    },

    async remove(attachmentKey, id) {
      await DeepRead.Store.db.queryAsync("DELETE FROM flashcards WHERE id = ? AND attachment_key = ?", [id, attachmentKey]);
    },

    async generate({ quote, context, signal } = {}) {
      const passage = str(quote).slice(0, MAX_QUOTE);
      if (!passage) throw new Error("Empty quote");
      const system = [
        "You write study flashcards for an academic paper.",
        "Given a quoted passage, write ONE good question that tests understanding of the passage (the why / how / what it implies), not trivia or exact wording, and a concise answer.",
        "The answer must be at most 120 words (or equivalent), grounded in the passage and context.",
        `Write both in ${languageInstruction()}. Write formulas in LaTeX with $...$.`,
        'Reply with JSON only: {"question": "...", "answer": "..."}',
      ].join("\n");
      const ctx = contextBlock(context);
      const user = `${ctx ? `${ctx}\n\n` : ""}Quoted passage:\n"""\n${passage}\n"""`;
      const res = await DeepRead.LLM.complete({
        system,
        messages: [{ role: "user", content: user }],
        responseFormat: { type: "json_object" },
        temperature: 0.3,
        signal,
      });
      const obj = parseJSONObject(res.content);
      const question = str(obj?.question);
      if (!question) throw new Error(DeepRead.bilingual("模型没有返回有效的问题，请重试", "The model did not return a valid question; please retry"));
      return { question, answer: str(obj.answer) };
    },

    async answer({ question, quote, context, signal } = {}) {
      const q = str(question);
      if (!q) throw new Error("Empty question");
      const system = [
        "You are an expert research assistant answering a study question about an academic paper.",
        "Ground the answer in the quoted passage and the paper context. If the paper does not support an answer, say so explicitly before adding any general knowledge.",
        `Answer concisely in ${languageInstruction()} using Markdown. Write formulas in LaTeX with $...$.`,
      ].join("\n");
      const ctx = contextBlock(context);
      const passage = str(quote).slice(0, MAX_QUOTE);
      const user = [ctx, passage ? `Quoted passage:\n"""\n${passage}\n"""` : "", `Question: ${q}`].filter(Boolean).join("\n\n");
      const res = await DeepRead.LLM.complete({
        system,
        messages: [{ role: "user", content: user }],
        temperature: 0.3,
        signal,
      });
      return str(res.content);
    },

    async exportToNote(parentItem, cards, { title, paragraphNotes = [] } = {}) {
      const paperTitle = parentItem?.getField?.("title") || "";
      const heading = title || `${DeepRead.bilingual("闪卡", "Flashcards")} · ${paperTitle}`;
      const html = [`<h1>${escapeHTML(heading)}</h1>`];
      for (const card of this.sort(cards)) {
        html.push(`<h3>${escapeHTML(card.question || card.quote)}</h3>`);
        if (card.quote) html.push(`<blockquote><p>${escapeHTML(card.quote)} (p. ${card.pageIndex + 1})</p></blockquote>`);
        if (card.answer) html.push(paragraphsHTML(card.answer));
        if (card.note) html.push(`<p><strong>${escapeHTML(DeepRead.bilingual("我的理解：", "My understanding: "))}</strong></p>`, paragraphsHTML(card.note));
      }
      if (paragraphNotes.length) {
        html.push(`<h2>${escapeHTML(DeepRead.bilingual("我的理解", "My understanding"))}</h2>`);
        for (const entry of paragraphNotes) {
          html.push(`<h3>${escapeHTML(entry.summary || "")} (p. ${entry.pageIndex + 1})</h3>`, paragraphsHTML(entry.note));
        }
      }
      const note = new Zotero.Item("note");
      note.libraryID = parentItem.libraryID;
      if (!parentItem.isAttachment() || parentItem.parentID) {
        note.parentID = parentItem.isAttachment() ? parentItem.parentID : parentItem.id;
      }
      note.setNote(html.join("\n"));
      await note.saveTx();
      return note;
    },
  };
})();
