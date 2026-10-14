/* Runs DeepRead.TextLayerParser.parse inside Zotero on the demo PDF and compares with the MinerU content list. */
/* global E2E, Zotero, IOUtils, PathUtils, setTimeout */
E2E.run = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Zotero.initializationPromise;
  const end0 = Date.now() + 60000;
  while (!Zotero.DeepRead && Date.now() < end0) await sleep(200);
  const DR = Zotero.DeepRead;
  const pdfPath = E2E.env("DEEPREAD_E2E_PDF");
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted);
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(pdfPath), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();

  const statuses = [];
  const t0 = Date.now();
  const { contentList, markdown } = await DR.TextLayerParser.parse({
    pdfApp: session.pdfAdapter(),
    onStatus: (s) => statuses.push(`${s.phase} ${s.extractedPages}/${s.totalPages}`),
  });
  const ms = Date.now() - t0;

  const ref = JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(pdfPath), "demo_content_list.json")));
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const refHeads = ref.filter((i) => i.text_level === 1);
  const outHeads = contentList.filter((i) => i.text_level === 1).map((i) => norm(i.text));
  const missing = refHeads.filter((r) => !outHeads.some((h) => h.startsWith(norm(r.text).slice(0, 20)))).map((r) => r.text.slice(0, 40));
  const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const refText = ref.filter((i) => i.type === "text" && i.page_idx < 9);
  const covered = refText.filter((r) => {
    const a = (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]);
    return contentList.some((o) => o.page_idx === r.page_idx && ov(o.bbox, r.bbox) > 0.3 * a);
  }).length;
  const cnt = (l, t) => l.filter((i) => i.type === t).length;
  return {
    ms, items: contentList.length, markdownChars: markdown.length, statuses: statuses.length,
    headings: `${refHeads.length - missing.length}/${refHeads.length}`, missingHeadings: missing,
    coverage: `${covered}/${refText.length}`,
    image: cnt(contentList, "image"), table: cnt(contentList, "table"), equation: cnt(contentList, "equation"), text: cnt(contentList, "text"),
    titleFound: contentList.some((i) => i.text_level === 1 && /Attention Is All You Need/.test(i.text)),
    arxivStampItems: contentList.filter((i) => /^arXiv:/.test(i.text || "")).length,
    sample: contentList.slice(0, 4).map((i) => ({ type: i.type, level: i.text_level, bbox: i.bbox, text: (i.text || "").slice(0, 50) })),
  };
};
