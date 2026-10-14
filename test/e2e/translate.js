/* Full-document translation through (fake) ReadFlow: attachment saved + opened, both modes, replace on re-run.
 * Run: scripts/e2e.sh test/e2e/translate.js   (e2e.sh starts test/fake-readflow.mjs on 41999) */
/* global E2E, Zotero, setTimeout */

E2E.run = async function () {
  const steps = E2E.result.steps;
  const step = (name, data) => steps.push({ name, data });
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
  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  step("connection", await DR.ReadFlow.testConnection());

  // A regular parent item so the translation is stored as a sibling attachment.
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

  const progress = [];
  const off = session.on((type) => {
    if (type === "translation") progress.push(`${Math.round(session.translation.percent)} ${session.translation.message}`);
  });
  const dual = await session.translateDocument("dual");
  step("dual", {
    attachmentID: dual?.id, title: dual?.getField("title"), parent: dual?.parentItemID === pdf.parentItemID,
    fileExists: !!(await dual?.getFilePathAsync()), openedTab: !!Zotero.Reader._readers.find((r) => r.itemID === dual?.id),
    progressTail: progress.slice(-4),
  });
  if (E2E.env("E2E_TRANSLATE_QUICK") === "1") return { ok: true };
  const inplace = await session.translateDocument("inplace");
  step("inplace", { title: inplace?.getField("title"), existingDual: session.existingTranslation("dual")?.id === dual?.id });
  const dual2 = await session.translateDocument("dual");
  const siblings = Zotero.Items.get(Zotero.Items.get(pdf.parentItemID).getAttachments()).map((a) => a.getField("title"));
  step("replace", { newID: dual2?.id !== dual?.id, oldDeleted: !Zotero.Items.get(dual.id) || Zotero.Items.get(dual.id).deleted, siblings });
  off();
  return { ok: true };
};
