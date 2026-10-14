/* Dumps the structured text-layer chars of the demo PDF to test/fixtures/demo/chars.json. */
/* global E2E, Zotero, IOUtils, PathUtils, setTimeout */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Zotero.initializationPromise;
  const end0 = Date.now() + 60000;
  while (!Zotero.DeepRead && Date.now() < end0) await sleep(200);
  const DR = Zotero.DeepRead;
  const pdfPath = E2E.env("DEEPREAD_E2E_PDF");
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted);
  if (!item) {
    item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(pdfPath), libraryID: Zotero.Libraries.userLibraryID });
  }
  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  const app = session.pdfAdapter();
  const n = app.pdfDocument.numPages;
  const pages = [];
  for (let i = 0; i < n; i++) {
    const d = await app.pdfDocument.getPageData({ pageIndex: i });
    pages.push({ pageIndex: i, viewBox: Array.from(d.viewBox), chars: JSON.parse(JSON.stringify(d.chars)) });
  }
  const repo = E2E.env("DEEPREAD_REPO") || PathUtils.join(PathUtils.parent(E2E.env("DEEPREAD_E2E_PDF")));
  const out = PathUtils.join(PathUtils.parent(E2E.env("DEEPREAD_E2E_PDF")), "chars.json");
  await IOUtils.writeUTF8(out, JSON.stringify(pages));
  return { pages: n, chars: pages.map((p) => p.chars.length), out };
};
