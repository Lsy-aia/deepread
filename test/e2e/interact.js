/* Reading interactions after a deep read: hover → in-place translation laid out like the original
 * (Alt / pressing shows the original); click a paragraph → its margin card opens (or a pinned card).
 * Run: scripts/e2e.sh test/e2e/interact.js
 * (Synthetic DOM events don't reach the plugin's privileged listeners, so handlers are called directly.) */
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
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  // Fresh results so the fake translations have the current (Chinese-length) shape.
  await session.run();
  await sleep(1000);
  const overlay = session.overlay;
  const rail = session.rail;
  const live = (pageIndex, paragraphIndex) => (overlay.pages.get(pageIndex) || []).find((p) => p.paragraphIndex === paragraphIndex);

  // ---- 1) hover translation, 1:1 layout ----
  const page = session.data.hierarchicalData.find((p) => p.pageIndex === 1);
  const target = page.paragraphs.find((p) => p.paragraphType === "text" && (p.paragraphText || "").length > 500) || page.paragraphs[1];
  await session.navigateToParagraph({ ...target, pageIndex: 1 });
  await sleep(1200);
  const para = live(1, target.paragraphIndex);
  overlay._setHover(para);
  const before = overlay.pdfDoc.querySelectorAll(".dr-translation").length; // not yet: dwell first
  await sleep(450);
  const box = overlay.pdfDoc.querySelector(".dr-translation");
  const geom = overlay._geometry(1);
  const metrics = overlay._lineMetrics(geom, para);
  const cs = box && overlay.pdfWin.getComputedStyle(box);
  step("hover-translation", {
    beforeDwell: before,
    shown: !!box,
    metrics: { fontSize: +metrics.fontSize.toFixed(2), lineHeight: +metrics.lineHeight.toFixed(2), indent: +metrics.indent.toFixed(1), lines: metrics.lines },
    applied: cs && { fontSize: cs.fontSize, lineHeight: cs.lineHeight, textIndent: cs.textIndent, textAlign: cs.textAlign },
    fits: box && box.scrollHeight <= box.clientHeight + 1,
    hasMath: !!box?.querySelector(".katex"),
    text: box?.textContent.slice(0, 50),
  });
  await shot("interact-hover-translation");

  overlay.altDown = true;
  overlay._drawHover(para);
  const altBoxes = overlay.pdfDoc.querySelectorAll(".dr-translation").length;
  const altOutline = overlay.pdfDoc.querySelectorAll(".dr-outline").length;
  overlay.altDown = false;
  overlay._drawHover(para);
  const afterAlt = overlay.pdfDoc.querySelectorAll(".dr-translation").length;
  overlay._suppressPara = para; // as after a press / text selection in this paragraph
  overlay._drawHover(para);
  const pressed = overlay.pdfDoc.querySelectorAll(".dr-translation").length;
  overlay._suppressPara = null;
  step("hover-original", { altBoxes, altOutline, afterAlt, pressed });

  // A heading: bold, left-aligned.
  const title = [...overlay.pages.values()].flat().find((p) => p.paragraphType === "title" && overlay._paragraphTranslation(p));
  if (title) {
    await session.navigateToParagraph({ ...title });
    await sleep(1000);
    overlay._setHover(title);
    await sleep(450);
    const t = overlay.pdfDoc.querySelector(".dr-translation");
    step("title-translation", { cls: t?.className, weight: t && overlay.pdfWin.getComputedStyle(t).fontWeight });
  }
  overlay._setHover(null);
  await sleep(400);

  // ---- 2) click → open the margin card ----
  await session.navigateToParagraph({ ...target, pageIndex: 1 });
  await sleep(1200);
  const key = `p_1_${target.paragraphIndex}`;
  const compactBefore = [...(rail.compactPages || [])];
  overlay.openParagraph(live(1, target.paragraphIndex));
  await sleep(900);
  const card = rail.cards.get(key);
  const railH = rail.root.clientHeight;
  step("open-card", {
    focusKey: rail.focusKey,
    open: card?.el.classList.contains("dr-open"),
    expanded: card?.el.classList.contains("dr-expanded"),
    compact: card?.el.classList.contains("dr-compact"),
    pointsVisible: !!card?.el.querySelector(".dr-points") && overlay.readerDoc.defaultView.getComputedStyle(card.el.querySelector(".dr-points")).display !== "none",
    top: card?.el.offsetTop,
    bottom: card && card.el.offsetTop + card.el.offsetHeight,
    railH,
    inView: card && card.el.offsetTop >= 0 && card.el.offsetTop + card.el.offsetHeight <= railH,
    compactPages: compactBefore,
  });
  await shot("interact-open-card");

  // Another paragraph replaces it; a click on blank space closes.
  const other = page.paragraphs.find((p) => p.paragraphIndex !== target.paragraphIndex && p.paragraphType === "text");
  overlay.openParagraph(live(1, other.paragraphIndex));
  await sleep(700);
  const firstStillOpen = rail.cards.get(key)?.el.classList.contains("dr-open");
  const second = rail.cards.get(`p_1_${other.paragraphIndex}`)?.el.classList.contains("dr-open");
  overlay.openParagraph(null);
  await sleep(600);
  step("switch-close", { firstStillOpen, secondOpen: second, afterBlank: rail.focusKey, openCards: rail.root.querySelectorAll(".dr-open").length });

  // Unsaved "my understanding" text survives the card closing (re-render).
  overlay.openParagraph(live(1, target.paragraphIndex));
  await sleep(600);
  rail.noteEditing = key;
  rail._invalidate(key);
  await sleep(500);
  rail.drafts.set(`note:${key}`, "还没保存的理解");
  overlay.openParagraph(null);
  await sleep(700);
  const area = rail.cards.get(key)?.el.querySelector(".dr-note-editing textarea");
  step("draft", { editorStillThere: !!area, value: area?.value });
  rail.noteEditing = null;
  rail._clearDrafts(`note:${key}`);
  rail._invalidate(key);
  await sleep(300);

  // ---- 3) margin cards off: click pins the floating card ----
  DR.prefs.set("view.marginCards", false);
  DR.Session.forEachOverlay((o) => o.session.rail?.refresh());
  await sleep(800);
  const p2 = live(1, target.paragraphIndex);
  overlay.openParagraph(p2);
  await sleep(300);
  const pinnedShown = !!overlay.card && !overlay.card.hidden;
  overlay._scheduleHide();
  await sleep(600);
  const pinnedAfterLeave = !!overlay.card && !overlay.card.hidden;
  await shot("interact-pinned-card");
  overlay.openParagraph(null);
  await sleep(200);
  step("pinned-card", { railActive: overlay.railActive, pinnedShown, pinnedAfterLeave, closed: !overlay.card || overlay.card.hidden });
  DR.prefs.set("view.marginCards", true);
  DR.Session.forEachOverlay((o) => o.session.rail?.refresh());
  return { ok: true };
};
