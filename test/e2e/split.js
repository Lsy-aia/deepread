/* Split margin rails on a two-column paper: left-column paragraphs → left rail, right → right.
 * Run: E2E_PARSER=builtin E2E_PDF2=test/fixtures/twocol/<paper>.pdf scripts/e2e.sh test/e2e/split.js */
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
  win.resizeTo(2000, 1200);
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
  DR.prefs.set("view.railLayout", "split");
  const pdfPath = E2E.env("E2E_PDF2");
  const name = pdfPath.split("/").pop();
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID))
    .find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === name);
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(pdfPath), libraryID: Zotero.Libraries.userLibraryID });

  // open() returns nothing when the tab is already open (restored session): look the reader up instead.
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  if (!session.hasResults) await session.run();
  await sleep(1500);
  const rail = session.rail;
  await waitFor(() => rail.root && rail.cards.size, 15000, "rail cards");
  await waitFor(() => rail.leftRoot, 5000, "left rail").catch(() => null);
  await sleep(800);

  const describe = () => {
    const sides = { left: 0, right: 0 };
    const wrong = [];
    for (const [key, card] of rail.cards) {
      if (card.el.hidden) continue;
      const side = card.el.parentNode === rail.leftRoot ? "left" : "right";
      sides[side]++;
      const m = key.match(/^p_(\d+)_(\d+)$/);
      if (!m) continue;
      const paragraph = (rail.overlay.pages.get(Number(m[1])) || []).find((p) => p.paragraphIndex === Number(m[2]));
      const geom = rail.overlay._geometry(Number(m[1]));
      const pct = paragraph && geom && rail.overlay._toPercent(geom, paragraph.bbox);
      const expected = !pct || pct.width > 60 ? "right" : (pct.left + pct.width / 2 < 50 ? "left" : "right");
      if (expected !== side) wrong.push(key);
    }
    return {
      hasLeftRail: !!rail.leftRoot,
      leftWidth: rail.leftRoot?.clientWidth,
      rightWidth: rail.root?.clientWidth,
      visible: sides,
      wrongSide: wrong,
    };
  };
  step("page1", describe());
  await shot("split-page1");

  const page = session.data.hierarchicalData.find((p) => p.pageIndex === 2) || session.data.hierarchicalData[1];
  await session.navigateToParagraph({ ...page.paragraphs[0], pageIndex: page.pageIndex });
  await sleep(1500);
  step("page3", describe());
  await shot("split-page3");

  DR.prefs.set("view.railLayout", "right");
  rail.refresh();
  await sleep(800);
  step("single", { hasLeftRail: !!rail.leftRoot });
  DR.prefs.set("view.railLayout", "split");
  rail.refresh();
  return { ok: true };
};
