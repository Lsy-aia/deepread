/* Built-in full-document translation (no ReadFlow): parse-only content list, block translation with the
 * DeepRead model (fake), in-place translation view, translate menu, cached reload, PDF export.
 * Run: scripts/e2e.sh test/e2e/builtin-translate.js */
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
  DR.prefs.set("readflow.enabled", false);
  DR.prefs.set("translate.engine", "builtin");

  let pdf = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!pdf) pdf = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  if (!pdf.parentItemID) {
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Attention Is All You Need");
    await parent.saveTx();
    pdf.parentID = parent.id;
    await pdf.saveTx();
  }
  await Zotero.Reader.open(pdf.id);
  const reader = Zotero.Reader._readers.find((r) => r.itemID === pdf.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  // Start from nothing: no 精读 results, no parse, no cached translation.
  await session.clearResults();
  await sleep(500);

  // 1) translate without a deep read
  const progress = [];
  const off = session.on((type) => {
    if (type === "translation" && session.translation) progress.push(`${Math.round(session.translation.percent)} ${session.translation.message}`);
  });
  const t0 = Date.now();
  const result = await session.translateFull();
  const ids = Object.keys(result?.translations || {});
  step("translate", {
    ms: Date.now() - t0,
    units: result?.unitCount,
    translated: ids.length,
    failures: result?.failures?.length,
    sample: result?.translations?.[ids[3]]?.slice(0, 60),
    noDeepRead: !session.hasResults,
    parsedBlocks: session.parsed?.contentList?.length,
    status: session.translation?.status,
    progressHead: progress.slice(0, 3),
    progressTail: progress.slice(-2),
  });

  // 2) in-place view
  const pdfDoc = reader._internalReader._primaryView._iframeWindow.document;
  await waitFor(() => pdfDoc.querySelectorAll(".dr-tbox").length, 10000, "translation boxes");
  const boxes = [...pdfDoc.querySelectorAll(".dr-tbox")];
  step("view", {
    on: session.translationView,
    boxes: boxes.length,
    titles: boxes.filter((b) => b.classList.contains("dr-title")).length,
    firstText: boxes[0]?.textContent.slice(0, 40),
    fontSize: boxes[0] && pdfDoc.defaultView.getComputedStyle(boxes[0]).fontSize,
  });
  await shot("translate-view");

  // 3) menu: built-in section only (ReadFlow off), then ReadFlow section appears when enabled
  const rdoc = reader._iframeWindow.document;
  const menuItems = async () => {
    rdoc.querySelector(".dr-translate").click();
    await sleep(300);
    const menu = rdoc.querySelector(".deepread-menu");
    const items = [...menu.querySelectorAll("button, .dr-menu-heading")].map((b) => b.textContent);
    menu.remove();
    return items;
  };
  const builtinMenu = await menuItems();
  DR.prefs.set("readflow.enabled", true);
  const withReadflow = await menuItems();
  DR.prefs.set("readflow.enabled", false);
  step("menu", { builtinMenu, withReadflow });

  // 4) toggle off / on
  session.setTranslationView(false);
  await sleep(500);
  const offCount = pdfDoc.querySelectorAll(".dr-tbox").length;
  session.setTranslationView(true);
  await sleep(500);
  step("toggle", { offCount, onCount: pdfDoc.querySelectorAll(".dr-tbox").length });

  // 5) cached translation survives a reload of the session state
  session.fullTranslation = null;
  await session._loadFullTranslation();
  step("cache", { restored: Object.keys(session.fullTranslation?.translations || {}).length });

  // 6) export translated PDFs
  const font = await DR.PdfExport.findCJKFont();
  const exported = {};
  for (const mode of ["dual", "inplace"]) {
    const t1 = Date.now();
    const attachment = await session.exportTranslatedPDF(mode);
    const path = await attachment?.getFilePathAsync();
    exported[mode] = {
      ms: Date.now() - t1,
      title: attachment?.getField("title"),
      sibling: attachment?.parentItemID === pdf.parentItemID,
      bytes: path ? (await IOUtils.stat(path)).size : 0,
      opened: !!Zotero.Reader._readers.find((r) => r.itemID === attachment?.id),
    };
  }
  step("export", { font: font?.name, ...exported, status: session.translation?.status });
  off();
  await sleep(1500);
  await shot("translate-export");
  return { ok: true };
};
