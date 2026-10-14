/*
 * One Session per open PDF reader: loads cached results, runs the pipeline, owns the overlay,
 * and notifies panes/toolbar through a tiny listener API.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Components */

(function () {
  const sessions = new Map(); // ReaderInstance → Session
  let notifierID = null;

  function waived(obj) {
    return obj?.wrappedJSObject || obj;
  }

  /**
   * Chrome-side facade over the reader's pdf.js objects. Arguments are cloned into the content
   * compartment and page data is copied out as plain JSON (much faster to iterate than x-rays).
   */
  function createPdfAdapter(view) {
    const win = view._iframeWindow;
    const app = waived(win).PDFViewerApplication;
    const clone = (value) => Components.utils.cloneInto(value, win);
    const copyOut = (value) => JSON.parse(win.JSON.stringify(value));
    const doc = app.pdfDocument;
    // pageIndex → { viewport: { viewBox, originalViewBox, width, height } }; filled by prepareGeometry().
    const geometry = [];
    const pageViews = [];
    return {
      async prepareGeometry() {
        for (let i = 0; i < doc.numPages; i++) {
          if (geometry[i]) continue;
          const page = waived(await doc.getPage(i + 1));
          const view = Array.from(page.view);
          const viewport = { viewBox: view, originalViewBox: view, width: view[2] - view[0], height: view[3] - view[1] };
          geometry[i] = viewport;
          pageViews[i] = { viewport, originalPage: { viewport, div: null }, div: null };
        }
      },
      pdfDocument: {
        get numPages() {
          return doc.numPages;
        },
        async getPageData(params) {
          return copyOut(await doc.getPageData(clone({ pageIndex: params.pageIndex })));
        },
        async getPage(pageNumber) {
          const page = waived(await doc.getPage(pageNumber));
          return {
            view: Array.from(page.view),
            rotate: page.rotate,
            getViewport(params) {
              const viewport = waived(page.getViewport(clone({ scale: params?.scale ?? 1 })));
              return {
                width: viewport.width,
                height: viewport.height,
                viewBox: Array.from(viewport.viewBox),
                originalViewBox: viewport.originalViewBox ? Array.from(viewport.originalViewBox) : undefined,
                transform: Array.from(viewport.transform),
              };
            },
          };
        },
        async getOutline() {
          const outline = await doc.getOutline();
          return outline ? copyOut(outline) : null;
        },
      },
      pdfViewer: {
        get pagesCount() {
          return app.pdfViewer.pagesCount;
        },
        getPageView(index) {
          return pageViews[index] || null;
        },
        get _pages() {
          return pageViews;
        },
        get currentScale() {
          return app.pdfViewer.currentScale;
        },
      },
    };
  }

  DeepRead.Session = class Session {
    static forReader(reader) {
      if (!reader || reader.type !== "pdf") return null;
      let session = sessions.get(reader);
      if (!session) {
        session = new Session(reader);
        sessions.set(reader, session);
        Session._ensureNotifier();
      }
      return session;
    }

    static forWindow(win) {
      const tabID = win?.Zotero_Tabs?.selectedID;
      if (!tabID) return null;
      const reader = Zotero.Reader.getByTabID(tabID);
      return reader ? Session.forReader(reader) : null;
    }

    static forEachOverlay(fn) {
      for (const session of sessions.values()) fn(session.overlay);
    }

    static destroyAll() {
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
      if (notifierID) {
        Zotero.Notifier.unregisterObserver(notifierID);
        notifierID = null;
      }
    }

    static _ensureNotifier() {
      if (notifierID) return;
      notifierID = Zotero.Notifier.registerObserver({
        notify(event, type, ids) {
          if (type !== "tab" || event !== "close") return;
          for (const [reader, session] of sessions) {
            if (ids.includes(reader.tabID)) {
              session.destroy();
              sessions.delete(reader);
            }
          }
        },
      }, ["tab"], "deepread");
    }

    constructor(reader) {
      this.reader = reader;
      this.status = "idle"; // idle | loading | running | ready | error
      this.progress = { percent: 0, message: "" };
      this.error = null;
      this.data = null; // { hierarchicalData, articleSummary, blockMapping, sections, markdown, contentList, resultDir }
      this.userState = { pointImportance: {} };
      this.chat = null; // loaded lazily by the chat pane
      this.pendingQuotes = [];
      this.outlineStatus = "idle"; // idle | running | error
      this.summaryStatus = "idle";
      this._listeners = new Set();
      this._abort = null;
      this.flashcards = null;
      this.githubRepo = null;
      this.overlay = new DeepRead.Overlay(this);
      this.rail = DeepRead.Rail ? new DeepRead.Rail(this) : null;
      this.editingFlashcard = null;
      this.flipped = new Set();
      this.on((event) => {
        if (event === "change" || event === "flashcards") this.rail?.refresh();
        if (event === "change") for (const card of this.flashcards || []) delete card._autoKey;
      });
    }

    get item() {
      return Zotero.Items.get(this.reader.itemID);
    }

    get key() {
      return DeepRead.util.attachmentKey(this.item);
    }

    get parentItem() {
      const item = this.item;
      return item?.parentItemID ? Zotero.Items.get(item.parentItemID) : item;
    }

    get hasResults() {
      return !!this.data?.hierarchicalData?.length;
    }

    on(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    _emit(event = "change", payload = null) {
      for (const listener of [...this._listeners]) {
        try {
          listener(event, payload, this);
        }
        catch (e) {
          DeepRead.log("listener failed", String(e));
        }
      }
    }

    /** Idempotent: wait for the PDF view, attach overlay, load cached results. */
    init() {
      if (!this._initPromise) {
        this._initPromise = this._init().catch((e) => {
          DeepRead.log("session init failed", String(e));
          this._initPromise = null;
        });
      }
      return this._initPromise;
    }

    async _init() {
      this.status = "loading";
      this._emit();
      await this.reader._initPromise;
      const internal = waived(this.reader._internalReader);
      const view = internal?._primaryView;
      if (!view) throw new Error("no primary view");
      await view.initializedPromise;
      this.view = view;

      const stored = await DeepRead.Store.getPaper(this.key);
      this.githubRepo = stored?.github_url || null;
      if (stored?.hierarchical_data) {
        this.data = {
          hierarchicalData: stored.hierarchical_data,
          articleSummary: stored.article_summary,
          blockMapping: stored.block_mapping,
          sections: stored.sections,
          markdown: stored.markdown || "",
          contentList: stored.content_list,
          resultDir: stored.result_dir,
          language: stored.language,
        };
        this.userState = { pointImportance: {}, ...(stored.user_state || {}) };
        this.status = "ready";
      }
      else {
        this.status = "idle";
      }
      this.overlay.attach(view);
      if (this.data) this.overlay.setData(this.data.hierarchicalData);
      this.rail?.attach(view);
      this.loadFlashcards().catch((e) => DeepRead.log("loading flashcards failed", String(e)));
      this._emit();
    }

    destroy() {
      this.cancel();
      this.cancelTranslation();
      this.rail?.detach();
      this.overlay.detach();
      this._listeners.clear();
    }

    /* ---------- flashcards ---------- */

    async loadFlashcards() {
      this.flashcards = await DeepRead.Flashcards.list(this.key);
      this._emit("flashcards");
      return this.flashcards;
    }

    async saveFlashcard(card) {
      const saved = await DeepRead.Flashcards.save(this.key, card);
      const list = (this.flashcards || []).filter((c) => c.id !== saved.id);
      list.push(saved);
      this.flashcards = DeepRead.Flashcards.sort(list);
      this._emit("flashcards", { id: saved.id });
      return saved;
    }

    async deleteFlashcard(id) {
      await DeepRead.Flashcards.remove(this.key, id);
      this.flashcards = (this.flashcards || []).filter((c) => c.id !== id);
      this._emit("flashcards", { id });
    }

    async navigateToFlashcard(card) {
      if (!card) return false;
      const rects = Array.isArray(card.rects) && card.rects.length ? card.rects : null;
      await this.reader.navigate(rects
        ? { position: { pageIndex: card.pageIndex, rects: [DeepRead.Overlay.unionRect(rects)] } }
        : { pageIndex: card.pageIndex || 0 });
      if (rects) this.overlay.flash({ pageIndex: card.pageIndex, rects });
      return true;
    }

    /** Context passed to flashcard/QA prompts: title + abstract + the paragraph(s) around a page. */
    flashcardContext(pageIndex) {
      const item = this.parentItem;
      const title = item?.getField?.("title") || "";
      const abstract = item?.isRegularItem?.() ? String(item.getField("abstractNote") || "").slice(0, 3000) : "";
      const page = (this.data?.hierarchicalData || []).find((p) => p.pageIndex === pageIndex);
      const pageText = (page?.paragraphs || []).map((p) => p.paragraphText || "").join("\n\n").slice(0, 8000);
      return { title, abstract, pageText };
    }

    /* ---------- full-document translation (ReadFlow) ---------- */

    static translationTitle(mode) {
      return mode === "inplace"
        ? DeepRead.bilingual("译文（原位）", "Translation (in place)")
        : DeepRead.bilingual("译文（双栏对照）", "Translation (side by side)");
    }

    /** Existing translated attachment for this PDF and mode, if any. */
    existingTranslation(mode) {
      const parent = this.item?.parentItem;
      if (!parent) return null;
      const title = DeepRead.Session.translationTitle(mode);
      return Zotero.Items.get(parent.getAttachments()).find((a) => a.isPDFAttachment() && a.getField("title") === title) || null;
    }

    async translateDocument(mode = DeepRead.prefs.get("readflow.defaultMode") || "dual") {
      if (this.translation?.status === "running") {
        this._notify(DeepRead.bilingual("这篇文献正在翻译中", "This document is already being translated"), "warning");
        return null;
      }
      if (!DeepRead.ReadFlow) throw new Error("ReadFlow client unavailable");
      if (!DeepRead.LLM.isConfigured()) {
        throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
      }
      const filePath = await this.item.getFilePathAsync();
      if (!filePath) throw new Error(DeepRead.bilingual("找不到 PDF 文件", "PDF file not found"));
      const controller = new AbortController();
      this.translation = { status: "running", mode, percent: 1, message: DeepRead.bilingual("连接 ReadFlow…", "Connecting to ReadFlow…"), controller };
      this._emit("translation");
      try {
        const result = await DeepRead.ReadFlow.translatePDF({
          filePath,
          mode,
          targetLang: DeepRead.prefs.language(),
          signal: controller.signal,
          onStatus: (status) => {
            this.translation = { ...this.translation, percent: status.percent ?? this.translation.percent, message: status.message || this.translation.message, jobId: status.jobId || this.translation.jobId };
            this._emit("translation");
          },
        });
        this.translation = { ...this.translation, percent: 99, message: DeepRead.bilingual("保存译文附件…", "Saving the translated PDF…") };
        this._emit("translation");
        const attachment = await this._saveTranslation(result, mode);
        this.translation = { status: "done", mode, percent: 100, message: DeepRead.bilingual("翻译完成", "Translation finished"), attachmentID: attachment.id };
        this._emit("translation");
        await Zotero.Reader.open(attachment.id);
        return attachment;
      }
      catch (error) {
        const aborted = controller.signal.aborted || error?.name === "AbortError";
        this.translation = {
          status: aborted ? "idle" : "error",
          mode,
          percent: 0,
          message: aborted ? DeepRead.t("flow.cancelled") : DeepRead.util.formatError(error),
        };
        this._emit("translation");
        if (!aborted) throw error;
        return null;
      }
    }

    cancelTranslation() {
      const job = this.translation;
      if (job?.status !== "running") return;
      job.controller?.abort();
      if (job.jobId) DeepRead.ReadFlow.cancel(job.jobId).catch((e) => DeepRead.log("ReadFlow cancel failed", String(e)));
    }

    async _saveTranslation(result, mode) {
      const dir = PathUtils.join(PathUtils.tempDir, `deepread-${Date.now()}`);
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
      const base = (this.item.attachmentFilename || "paper.pdf").replace(/\.pdf$/i, "");
      const suffix = mode === "inplace" ? DeepRead.bilingual("译文", "translated") : DeepRead.bilingual("双语对照", "bilingual");
      const tmpPath = PathUtils.join(dir, `${base} - ${suffix}.pdf`);
      await IOUtils.write(tmpPath, result.pdfBytes);
      try {
        const old = this.existingTranslation(mode);
        const attachment = await Zotero.Attachments.importFromFile({
          file: Zotero.File.pathToFile(tmpPath),
          libraryID: this.item.libraryID,
          parentItemID: this.item.parentItemID || undefined,
          title: DeepRead.Session.translationTitle(mode),
        });
        // Replace an older translation of the same kind instead of piling up copies.
        if (old && old.id !== attachment.id) await old.eraseTx();
        return attachment;
      }
      finally {
        await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
      }
    }

    /* ---------- code repository ---------- */

    /** Plain text of the paper for repository detection (parse results first, then Zotero full text). */
    async paperText(maxChars = 400000) {
      await this.init();
      let text = "";
      if (this.data?.markdown) text = this.data.markdown;
      else if (this.data?.hierarchicalData) {
        text = this.data.hierarchicalData.flatMap((p) => (p.paragraphs || []).map((x) => x.paragraphText || "")).join("\n");
      }
      if (!text) {
        try {
          const cache = Zotero.Fulltext.getItemCacheFile(this.item);
          if (cache?.exists()) text = await Zotero.File.getContentsAsync(cache);
        }
        catch (e) {
          DeepRead.log("full-text cache read failed", String(e));
        }
      }
      const abstract = this.parentItem?.isRegularItem?.() ? String(this.parentItem.getField("abstractNote") || "") : "";
      return `${abstract}\n${text}`.slice(0, maxChars);
    }

    async setGitHubRepo(fullName) {
      this.githubRepo = fullName || null;
      await DeepRead.Store.savePaper(this.key, this.item.id, { github_url: this.githubRepo });
      this._emit("github");
    }

    pdfAdapter() {
      return createPdfAdapter(this.view);
    }

    /* ---------- configuration checks ---------- */

    _checkConfig({ parser = true } = {}) {
      if (!DeepRead.LLM.isConfigured()) {
        throw Object.assign(new Error(DeepRead.t("error.noLLM")), { configError: true });
      }
      if (parser && !DeepRead.Parser.isConfigured()) {
        throw Object.assign(new Error(DeepRead.t("error.noParser")), { configError: true });
      }
    }

    _newPipeline(signal, onProgress) {
      const adapter = this.pdfAdapter();
      return new DeepRead.Pipeline({
        getPdfApp: () => adapter,
        llm: (options) => DeepRead.LLM.complete({ ...options, signal: options.signal || signal }),
        parsePDF: async ({ onStatus } = {}) => {
          const filePath = await this.item.getFilePathAsync();
          if (!filePath) throw new Error(DeepRead.bilingual("找不到 PDF 文件", "PDF file not found"));
          return DeepRead.Parser.parsePDF({ filePath, attachmentKey: this.key, onStatus, signal, pdfApp: adapter });
        },
        onProgress: onProgress || (() => {}),
        notify: (message, type) => this._notify(message, type),
        language: DeepRead.prefs.language(),
        paperTitle: this.parentItem?.getField?.("title") || "",
        concurrency: DeepRead.prefs.llmConfig().concurrency,
        filterAuthors: DeepRead.prefs.get("filterAuthorBlocks") !== false,
        signal,
      });
    }

    _notify(message, type = "info") {
      DeepRead.log(`[${type}] ${message}`);
      this._emit("notify", { message, type });
    }

    _setProgress(next) {
      this.progress = {
        percent: typeof next.percent === "number" ? next.percent : this.progress.percent,
        message: next.message ?? this.progress.message,
      };
      this._emit("progress");
    }

    /* ---------- main flow ---------- */

    async run() {
      if (this.status === "running") {
        this._notify(DeepRead.t("flow.busy"), "warning");
        return false;
      }
      await this.init();
      if (this.item?.attachmentContentType !== "application/pdf") {
        throw new Error(DeepRead.t("error.notPDF"));
      }
      this._checkConfig();

      const controller = new AbortController();
      this._abort = controller;
      this.status = "running";
      this.error = null;
      this.progress = { percent: 1, message: DeepRead.t("flow.start") };
      this._emit();
      try {
        const pipeline = this._newPipeline(controller.signal, (p) => this._setProgress(p));
        const result = await pipeline.run();
        this._setProgress({ percent: 97, message: DeepRead.t("flow.saving") });
        const data = {
          hierarchicalData: DeepRead.Session.compactHierarchicalData(result.hierarchicalData),
          articleSummary: result.articleSummary?.article_summary ?? result.articleSummary ?? null,
          blockMapping: result.blockMapping || null,
          sections: null,
          markdown: result.markdown || "",
          contentList: result.contentList || null,
          resultDir: result.resultDir || null,
          language: DeepRead.prefs.language(),
        };
        await DeepRead.Store.savePaper(this.key, this.item.id, {
          result_dir: data.resultDir,
          language: data.language,
          content_list: data.contentList,
          hierarchical_data: data.hierarchicalData,
          article_summary: data.articleSummary,
          block_mapping: data.blockMapping,
          sections: null,
          markdown: data.markdown,
          user_state: { pointImportance: {} },
        });
        this.data = data;
        this.userState = { pointImportance: {} };
        this.overlay.setData(data.hierarchicalData);
        this.status = "ready";
        this.progress = { percent: 100, message: DeepRead.t("flow.done") };
        this._emit();
        return true;
      }
      catch (error) {
        const aborted = controller.signal.aborted || error?.name === "AbortError";
        this.status = this.data ? "ready" : "idle";
        this.error = aborted ? null : error;
        this.progress = {
          percent: 0,
          message: aborted ? DeepRead.t("flow.cancelled") : DeepRead.t("flow.failed", { error: DeepRead.util.formatError(error) }),
        };
        if (!aborted) {
          DeepRead.log("run failed", error?.stack || String(error));
          this.status = this.data ? "ready" : "error";
        }
        this._emit();
        if (!aborted) throw error;
        return false;
      }
      finally {
        this._abort = null;
      }
    }

    cancel() {
      this._abort?.abort();
    }

    _pipelineWithState(signal) {
      const pipeline = this._newPipeline(signal);
      pipeline.loadState({
        resultDir: this.data.resultDir,
        contentList: this.data.contentList,
        markdown: this.data.markdown,
        hierarchicalData: this.data.hierarchicalData,
        articleSummary: this.data.articleSummary,
        blockMapping: this.data.blockMapping,
        sections: this.data.sections,
      });
      return pipeline;
    }

    async generateOutline() {
      await this.init();
      if (!this.hasResults) throw new Error(DeepRead.t("error.noParseData"));
      this._checkConfig({ parser: false });
      this.outlineStatus = "running";
      this._emit();
      try {
        const pipeline = this._pipelineWithState(undefined);
        const outline = await pipeline.generateOutline();
        this.data.sections = outline;
        if (!this.data.blockMapping) this.data.blockMapping = pipeline.getState().blockMapping;
        await DeepRead.Store.savePaper(this.key, this.item.id, {
          sections: outline,
          block_mapping: this.data.blockMapping,
        });
        this.outlineStatus = "idle";
        this._emit();
        return outline;
      }
      catch (error) {
        this.outlineStatus = "error";
        this.outlineError = DeepRead.util.formatError(error);
        this._emit();
        throw error;
      }
    }

    async regenerateSummary() {
      await this.init();
      if (!this.hasResults) throw new Error(DeepRead.t("error.noParseData"));
      this._checkConfig({ parser: false });
      this.summaryStatus = "running";
      this._emit();
      try {
        const pipeline = this._pipelineWithState(undefined);
        const result = await pipeline.regenerateArticleSummary();
        this.data.articleSummary = result.articleSummary?.article_summary ?? result.articleSummary;
        if (result.blockMapping) this.data.blockMapping = result.blockMapping;
        await DeepRead.Store.savePaper(this.key, this.item.id, {
          article_summary: this.data.articleSummary,
          block_mapping: this.data.blockMapping,
        });
        this.summaryStatus = "idle";
        this._emit();
      }
      catch (error) {
        this.summaryStatus = "error";
        this.summaryError = DeepRead.util.formatError(error);
        this._emit();
        throw error;
      }
    }

    async clearResults() {
      this.cancel();
      await DeepRead.Store.deletePaper(this.key);
      this.data = null;
      this.chat = null;
      this.userState = { pointImportance: {} };
      this.status = "idle";
      this.progress = { percent: 0, message: "" };
      this.overlay.setData([]);
      this._emit();
    }

    /* ---------- user state ---------- */

    _saveUserStateSoon() {
      clearTimeout(this._saveUserStateTimer);
      this._saveUserStateTimer = setTimeout(() => {
        DeepRead.Store.savePaper(this.key, this.item.id, { user_state: this.userState })
          .catch((e) => DeepRead.log("saving user state failed", String(e)));
      }, 500);
    }

    static paragraphKey(paragraph) {
      return `p_${paragraph.pageIndex}_${paragraph.paragraphIndex}`;
    }

    /** Paragraph summary with the user's inline edit applied. */
    paragraphSummary(paragraph) {
      const edit = this.userState.edits?.[DeepRead.Session.paragraphKey(paragraph)];
      return edit?.summary ?? paragraph.paragraphSummary ?? "";
    }

    setParagraphSummary(paragraph, summary) {
      const key = DeepRead.Session.paragraphKey(paragraph);
      const edits = { ...(this.userState.edits || {}) };
      if (!summary || summary === paragraph.paragraphSummary) delete edits[key];
      else edits[key] = { ...(edits[key] || {}), summary };
      this.userState.edits = edits;
      this._saveUserStateSoon();
    }

    isCardHidden(key) {
      return !!this.userState.hidden?.[key];
    }

    get hiddenCardCount() {
      return Object.keys(this.userState.hidden || {}).length;
    }

    setCardHidden(key, hidden) {
      const map = { ...(this.userState.hidden || {}) };
      if (hidden) map[key] = true;
      else delete map[key];
      this.userState.hidden = map;
      this._saveUserStateSoon();
      this.rail?.refresh();
    }

    showHiddenCards() {
      this.userState.hidden = {};
      this._saveUserStateSoon();
      this.rail?.refresh();
    }

    /* ---------- the reader's own understanding ---------- */

    paragraphNote(key) {
      return this.userState.notes?.[key]?.text || "";
    }

    setParagraphNote(key, text) {
      const notes = { ...(this.userState.notes || {}) };
      const value = String(text || "").trim();
      if (value) notes[key] = { text: value, updatedAt: new Date().toISOString() };
      else delete notes[key];
      this.userState.notes = notes;
      this._saveUserStateSoon();
      this.rail?.refresh();
      this._emit("notes", { key });
    }

    /** Paragraph (as "p_<page>_<index>") whose text best overlaps the given rects, or "". */
    paragraphKeyForRects(pageIndex, rects) {
      const page = (this.data?.hierarchicalData || []).find((p) => p.pageIndex === pageIndex);
      if (!page || !Array.isArray(rects) || !rects.length) return "";
      const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
      const inter = (a, b) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
      let best = "";
      let bestScore = 0;
      for (const paragraph of page.paragraphs || []) {
        let score = 0;
        for (const r of rects) for (const pr of paragraph.rects || []) score += inter(r, pr);
        if (score > bestScore) {
          bestScore = score;
          best = `p_${pageIndex}_${paragraph.paragraphIndex}`;
        }
      }
      return best;
    }

    /** [{ key, pageIndex, summary, note }] for every paragraph with a note, in reading order. */
    paragraphNotesList() {
      const out = [];
      for (const page of this.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          const key = `p_${page.pageIndex}_${paragraph.paragraphIndex}`;
          const note = this.paragraphNote(key);
          if (note) out.push({ key, pageIndex: page.pageIndex, summary: this.paragraphSummary({ ...paragraph, pageIndex: page.pageIndex }), note });
        }
      }
      return out;
    }

    flashcardsForParagraph(key) {
      return (this.flashcards || []).filter((card) => this.flashcardParagraphKey(card) === key);
    }

    flashcardParagraphKey(card) {
      if (card.paragraphKey) return card.paragraphKey;
      // Older cards without an explicit link: attach by position.
      if (!card._autoKey) card._autoKey = this.paragraphKeyForRects(card.pageIndex, card.rects) || "-";
      return card._autoKey === "-" ? "" : card._autoKey;
    }

    /**
     * Create a flashcard anchored at `rects`; if an LLM is configured, generate question/answer
     * from the quote in the background, otherwise open it for editing.
     */
    async createFlashcard({ pageIndex, rects, quote, source = "selection", paragraphKey }) {
      const card = await this.saveFlashcard({
        pageIndex, rects: rects || [], quote: String(quote || "").trim().slice(0, 4000), question: "", answer: "", source,
        paragraphKey: paragraphKey || this.paragraphKeyForRects(pageIndex, rects),
      });
      if (!this.rail?.enabled) DeepRead.Panes.reveal(this.reader, "flashcards");
      if (!DeepRead.LLM.isConfigured() || !card.quote) {
        this.editingFlashcard = card.id;
        this._emit("flashcards", { id: card.id });
        return card;
      }
      const busy = { ...card, _busy: DeepRead.bilingual("AI 出题中…", "Generating…") };
      this.flashcards = DeepRead.Flashcards.sort([...(this.flashcards || []).filter((c) => c.id !== card.id), busy]);
      this._emit("flashcards", { id: card.id });
      try {
        const { question, answer } = await DeepRead.Flashcards.generate({ quote: card.quote, context: this.flashcardContext(pageIndex) });
        return await this.saveFlashcard({ ...card, question, answer });
      }
      catch (error) {
        this._notify(DeepRead.util.formatError(error), "error");
        this.editingFlashcard = card.id;
        await this.saveFlashcard(card);
        return card;
      }
    }

    pointLevel(point) {
      const override = this.userState.pointImportance?.[point.id];
      return Number(override || point.importance_level || 1);
    }

    setPointImportance(pointId, level) {
      this.userState.pointImportance = { ...(this.userState.pointImportance || {}), [pointId]: level };
      this.overlay.renderAllPages();
      this.rail?.refresh();
      this._saveUserStateSoon();
    }

    /* ---------- navigation ---------- */

    _allParagraphs() {
      const out = [];
      for (const page of this.data?.hierarchicalData || []) {
        for (const paragraph of page.paragraphs || []) {
          out.push({ ...paragraph, pageIndex: page.pageIndex });
        }
      }
      return out;
    }

    findParagraphByMinerUid(uid) {
      if (uid === undefined || uid === null) return null;
      return this._allParagraphs().find((p) => String(p.minerUid) === String(uid)) || null;
    }

    _blockByID(blockId) {
      for (const section of this.data?.blockMapping || []) {
        for (const block of section.blocks || []) {
          if (String(block.block_id) === String(blockId)) return block;
        }
      }
      return null;
    }

    _titleBlock(titleBlockId) {
      return (this.data?.blockMapping || []).find((s) => String(s.title_block_id) === String(titleBlockId)) || null;
    }

    async navigateToParagraph(paragraph) {
      if (!paragraph) return false;
      const rects = paragraph.rects?.length ? paragraph.rects : null;
      const position = rects
        ? { pageIndex: paragraph.pageIndex, rects: [DeepRead.Overlay.unionRect(rects)] }
        : { pageIndex: paragraph.pageIndex ?? paragraph.page_idx ?? 0, rects: [[0, 0, 1, 1]] };
      await this.reader.navigate({ position });
      if (rects) this.overlay.flash(paragraph);
      return true;
    }

    async navigateToBlockIds(blockIds) {
      for (const id of blockIds || []) {
        const block = this._blockByID(id);
        const paragraph = block && this.findParagraphByMinerUid(block.minerUid);
        if (paragraph) return this.navigateToParagraph(paragraph);
        if (block?.page_idx !== undefined) {
          await this.reader.navigate({ pageIndex: block.page_idx });
          return true;
        }
      }
      return false;
    }

    async navigateToTitleBlock(titleBlockId) {
      const title = this._titleBlock(titleBlockId);
      const paragraph = title && this.findParagraphByMinerUid(title.minerUid);
      if (paragraph) return this.navigateToParagraph(paragraph);
      if (title?.page_idx !== undefined) {
        await this.reader.navigate({ pageIndex: title.page_idx });
        return true;
      }
      return false;
    }

    /* ---------- AI chat bridge ---------- */

    askAI({ text, pageIndex }) {
      const quote = String(text || "").trim();
      if (quote) this.pendingQuotes.push({ text: quote.slice(0, 8000), pageIndex });
      this._emit("ask");
      DeepRead.Panes.reveal(this.reader, "chat");
    }

    /**
     * Strip bulky per-character mappings before persisting; overlays only need rects.
     */
    static compactHierarchicalData(hierarchicalData) {
      return (hierarchicalData || []).map((page) => ({
        pageIndex: page.pageIndex,
        paragraphs: (page.paragraphs || []).map((p) => ({
          paragraphIndex: p.paragraphIndex,
          paragraphType: p.paragraphType,
          paragraphText: p.paragraphText,
          paragraphSummary: p.paragraphSummary,
          minerUid: p.minerUid,
          importance_level: p.importance_level,
          bbox: p.bbox,
          rects: p.rects,
          sentences: (p.sentences || []).map((s) => ({ id: s.id, sentenceIndex: s.sentenceIndex, text: s.text, rects: s.rects })),
          points: (p.points || []).map((pt) => ({
            id: pt.id,
            pointIndex: pt.pointIndex,
            sentenceIndices: pt.sentenceIndices,
            summary: pt.summary,
            translation: pt.translation,
            rects: pt.rects,
            importance_level: pt.importance_level,
          })),
        })),
      }));
    }
  };
})();
