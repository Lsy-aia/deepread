/* Paragraph-attached flashcards + "my understanding" notes (never folded).
 * Run: scripts/e2e.sh test/e2e/notes.js */
/* global E2E, Zotero, IOUtils, PathUtils, setTimeout */

E2E.run = async function () {
  const steps = E2E.result.steps;
  const step = (name, data) => {
    steps.push({ name, data });
    Zotero.debug(`[E2E] ${name} ${JSON.stringify(data)}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000, label = "condition") => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const win = Zotero.getMainWindow();
  win.resizeTo(1600, 1000);
  async function shot(name) {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0));
    const path = PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), `${name}.png`);
    await IOUtils.write(path, bytes);
    step("screenshot", path);
  }

  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) {
    item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  }
  DR.prefs.set("view.marginCards", true);
  await Zotero.Reader.open(item.id);
  const reader = Zotero.Reader._readers.find((r) => r.itemID === item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  if (!session.hasResults) await session.run();
  // Start clean: remove old flashcards and notes from earlier runs.
  for (const card of [...(session.flashcards || [])]) await session.deleteFlashcard(card.id);
  session.userState.notes = {};
  await sleep(800);

  const rail = session.rail;
  const page = session.data.hierarchicalData.find((p) => p.pageIndex === 1);
  const para = page.paragraphs.find((p) => (p.points || []).length > 1) || page.paragraphs[0];
  const key = `p_1_${para.paragraphIndex}`;
  await session.navigateToParagraph({ ...para, pageIndex: 1 });
  await sleep(1000);

  // 1) paragraph note
  session.setParagraphNote(key, "我的理解：RNN 的顺序计算限制了并行。\n第二行也要一直显示。");
  await sleep(500);
  const cardEl = () => rail.cards.get(key)?.el;
  step("paragraph-note", {
    noteShown: !!cardEl()?.querySelector(".dr-note .dr-note-text"),
    text: cardEl()?.querySelector(".dr-note-text")?.textContent,
    stored: session.paragraphNote(key),
  });

  // 2) flashcard from a selection inside that paragraph → attached to the paragraph card
  const selRects = [para.rects[0]];
  const card = await session.createFlashcard({ pageIndex: 1, rects: selRects, quote: para.paragraphText.slice(0, 200), source: "selection" });
  await sleep(800);
  const saved = session.flashcards.find((c) => c.id === card.id);
  step("flashcard-attached", {
    paragraphKey: saved?.paragraphKey,
    expectedKey: key,
    insideParagraphCard: !!cardEl()?.querySelector(".dr-attached .dr-fc-attached"),
    standaloneCardExists: rail.cards.has(`f_${card.id}`),
    answerFolded: !!cardEl()?.querySelector(".dr-fc-reveal") && !cardEl()?.querySelector(".dr-fc-a"),
  });

  // 3) add my understanding to the flashcard; it stays visible while the answer is folded
  await session.saveFlashcard({ ...saved, note: "我自己的理解：注意力把任意两位置的距离变成常数。" });
  await sleep(600);
  const block = cardEl()?.querySelector(".dr-fc-attached");
  step("flashcard-note", {
    noteVisible: !!block?.querySelector(".dr-fc-note .dr-note-text"),
    answerStillFolded: !block?.querySelector(".dr-fc-a"),
  });
  await shot("notes-folded");

  // 4) flip the answer: note remains
  session.flipped.add(card.id);
  rail.refresh();
  await sleep(600);
  const block2 = cardEl()?.querySelector(".dr-fc-attached");
  step("flipped", { answerShown: !!block2?.querySelector(".dr-fc-a"), noteStillVisible: !!block2?.querySelector(".dr-fc-note") });
  await shot("notes-flipped");

  // 5) pane shows the note in review mode; export includes notes
  DR.Panes.reveal(reader, "flashcards");
  await sleep(800);
  const pane = [...win.document.querySelectorAll(".dr-fc-pane")].find((n) => n.getBoundingClientRect().width > 0);
  step("pane", { noteInPane: !!pane?.querySelector(".dr-fc-note") });
  const note = await DR.Flashcards.exportToNote(session.parentItem, session.flashcards, { paragraphNotes: session.paragraphNotesList() });
  const html = note.getNote();
  step("export", { hasCardNote: html.includes("注意力把任意两位置"), hasParagraphNote: html.includes("RNN 的顺序计算") });
  return { ok: true };
};
