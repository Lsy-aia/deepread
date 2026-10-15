/* v0.7 cards: AI explanation as the card body (filled page by page after a deep read), translation folded,
 * card font size / width settings (live) + drag handle, hover translation beside (not over) the paragraph,
 * chat grounded in the blocks, "p. N ¶M" opening a card.
 * Run: scripts/e2e.sh test/e2e/cards.js */
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
  DR.prefs.set("view.marginCards", true);
  DR.prefs.set("view.translationPopup", true);
  DR.prefs.set("cards.autoExplain", true);
  DR.prefs.set("cards.translationOpen", false);
  DR.prefs.set("view.cardFontSize", 12);
  DR.prefs.set("view.railWidth", 280);
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  const overlay = session.overlay;
  const rail = session.rail;

  // ---- 1) deep read → explanations fill in ----
  const pagesFilled = [];
  const off = session.on((type) => {
    if (type === "explanations") pagesFilled.push(Object.keys(session.explanations).length);
  });
  await session.run();
  const eligible = session.data.hierarchicalData.flatMap((p) => p.paragraphs).filter((p) => DR.Explainer.eligible(p)).length;
  await waitFor(() => session.explaining.size === 0 && Object.keys(session.explanations).length >= eligible, 60000, "explanations");
  off();
  const stored = await DR.Store.getPaper(session.key);
  step("explanations", {
    eligible,
    explained: Object.keys(session.explanations).length,
    progressive: [...new Set(pagesFilled)].length > 2,
    stored: Object.keys(stored?.explanations || {}).length,
    sample: session.explanation("p_1_2").slice(0, 60),
  });

  // ---- 2) card layout: explanation body, folded translation ----
  const page = session.data.hierarchicalData.find((p) => p.pageIndex === 1);
  const target = page.paragraphs.find((p) => p.paragraphIndex === 2);
  await session.navigateToParagraph({ ...target, pageIndex: 1 });
  await sleep(1000);
  const key = session.groupLead("p_1_2"); // a merged card is keyed by its first paragraph
  overlay.openParagraph((overlay.pages.get(1) || []).find((p) => p.paragraphIndex === 2));
  await sleep(800);
  const cardEl = () => rail.cards.get(key)?.el;
  const body = cardEl()?.querySelector(".dr-explain");
  step("card", {
    explainFirst: cardEl()?.querySelector(".dr-phead")?.nextElementSibling?.classList.contains("dr-explain"),
    bold: !!body?.querySelector("strong"),
    math: !!body?.querySelector(".katex"),
    toggle: cardEl()?.querySelector(".dr-trtoggle")?.textContent,
    translationFolded: !cardEl()?.querySelector(".dr-trbody"),
    pointsKept: cardEl()?.querySelectorAll(".dr-points li").length,
  });
  cardEl().querySelector(".dr-trtoggle").click();
  await sleep(500);
  const unfolded = !!cardEl()?.querySelector(".dr-trbody");
  await shot("cards-open");
  cardEl().querySelector(".dr-trtoggle").click();
  await sleep(300);
  step("fold", { unfolded, refolded: !cardEl()?.querySelector(".dr-trbody") });

  // ---- 3) font size / width, live ----
  const fontOf = () => parseFloat(rail.readerWin.getComputedStyle(cardEl()).fontSize);
  const before = { font: fontOf(), width: rail.root.clientWidth };
  DR.prefs.set("view.cardFontSize", 15);
  DR.prefs.set("view.railWidth", 360);
  await sleep(800);
  const after = { font: fontOf(), width: rail.root.clientWidth };
  await shot("cards-big");
  DR.prefs.set("view.cardFontSize", 12);
  DR.prefs.set("view.railWidth", 280);
  await sleep(500);
  step("sizing", { before, after, restored: { font: fontOf(), width: rail.root.clientWidth }, handle: !!rail.root.querySelector(".dr-resize") });

  // ---- 4) hover translation sits beside the paragraph, not over it ----
  overlay.openParagraph(null);
  const live = (overlay.pages.get(1) || []).find((p) => p.paragraphIndex === 2);
  overlay._setHover(live);
  await sleep(450);
  const box = overlay.pdfDoc.querySelector(".dr-translation");
  const outline = overlay.pdfDoc.querySelector(".dr-outline");
  const b = box?.getBoundingClientRect();
  const o = outline?.getBoundingClientRect();
  step("hover-panel", {
    shown: !!box,
    side: box?.dataset.side,
    overlapsParagraph: !!(b && o && b.top < o.bottom - 3 && b.bottom > o.top + 3),
    sameWidth: b && o ? Math.abs(b.width - o.width) < 16 : null,
    outlined: !!outline,
  });
  await shot("cards-hover-panel");
  overlay._setHover(null);

  // ---- 5) chat grounded in the blocks; block refs open cards ----
  const prompt = DR.ChatPane.systemPrompt(session);
  await session.openBlock(1, 4);
  await sleep(800);
  step("chat", {
    hasBlocks: prompt.includes("# Paragraph blocks"),
    hasLabel: prompt.includes(`[${session.groupLabel(key)}]`),
    hasExplanation: prompt.includes("AI explanation:"),
    openBlock: rail.focusKey,
  });

  // ---- 6) regenerate one; menu rows ----
  const old = session.explanation(key);
  delete session.explanations[key];
  await session.explainParagraph(key);
  const rdoc = reader._iframeWindow.document;
  rdoc.querySelector(".deepread-toolbar .dr-menu-button").click();
  await sleep(300);
  const menu = rdoc.querySelector(".deepread-menu");
  const rows = [...(menu?.querySelectorAll(".dr-menu-row") || [])].map((r) => r.textContent);
  menu?.remove();
  step("regen-menu", { regenerated: !!session.explanation(key), changedOrSame: typeof old === "string", rows });
  return { ok: true };
};
