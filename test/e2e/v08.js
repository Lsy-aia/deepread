/* v0.8: 「功能」 menu (per-paper / default module switches), refreshed cards with paragraph roles,
 * section bar, figure cards (thumbnail + reading steps + mention focus), parser fallback.
 * Run: scripts/e2e.sh test/e2e/v08.js */
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
  for (const pref of ["view.marginCards", "view.translationPopup", "view.structureBar", "view.figureCards", "cards.autoExplain"]) DR.prefs.set(pref, true);
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  session.userState.modules = {};

  // ---- parser fallback: an unreachable self-hosted MinerU must not block the deep read ----
  const savedProvider = DR.prefs.get("parser.provider");
  const savedURL = DR.prefs.get("parser.selfHostURL");
  DR.prefs.set("parser.provider", "selfhost");
  DR.prefs.set("parser.selfHostURL", "http://127.0.0.1:9");
  const statuses = [];
  const off = session.on((type) => {
    if (type === "progress" && session.progress?.message) statuses.push(session.progress.message);
  });
  await session.run();
  off();
  DR.prefs.set("parser.provider", savedProvider);
  DR.prefs.set("parser.selfHostURL", savedURL);
  step("fallback", {
    ok: session.hasResults,
    blocks: session.data?.contentList?.length,
    sawFallback: statuses.some((m) => /内置文字层|built-in text layer/.test(m)),
  });

  // ---- explanations with roles, figure guides ----
  await waitFor(() => session.explaining.size === 0 && Object.keys(session.explanations).length > 10, 60000, "explanations");
  await waitFor(() => !session.explainingFigures && Object.keys(session.figureGuides).length > 0, 60000, "figure guides");
  const roles = Object.values(session.explanations).map((e) => e.role).filter(Boolean);
  step("roles", { explained: Object.keys(session.explanations).length, withRole: roles.length, kinds: [...new Set(roles)].sort() });

  // ---- section bar ----
  const rdoc = reader._iframeWindow.document;
  const bar = await waitFor(() => rdoc.getElementById("deepread-bar"), 10000, "section bar");
  const splitTop = rdoc.defaultView.getComputedStyle(rdoc.getElementById("split-view")).top;
  const segs = [...bar.querySelectorAll(".dr-seg")];
  step("bar", { segments: segs.length, labels: segs.map((s) => s.textContent), splitTop, read: bar.querySelector(".dr-read")?.textContent });
  const sections = DR.Structure.sections(session.data.contentList);
  const target = sections.find((s) => s.role === "experiment");
  segs[sections.indexOf(target)].click();
  await sleep(1500);
  const app = session.overlay.app;
  step("bar-jump", { want: target.label, wantPage: Math.floor(target.start) + 1, nowPage: app.pdfViewer.currentPageNumber, readUpTo: session.userState.readUpTo, current: bar.querySelector(".dr-current")?.textContent,
    start: target.start, viewTop: session.structureBar._positionAt(app.pdfViewer.container.scrollTop),
    viewBottom: session.structureBar._positionAt(app.pdfViewer.container.scrollTop + app.pdfViewer.container.clientHeight) });

  // ---- figure cards: go to the page with Figure 1 ----
  const fig = session.figures().find((f) => f.kind === "figure");
  await session.reader.navigate({ pageIndex: fig.pageIndex });
  await sleep(2500);
  const rail = session.rail;
  const figCard = await waitFor(() => rail.cards.get(`g_${fig.id}`)?.el, 10000, "figure card");
  const mentioning = [...(session.overlay.pages.values())].flat().find((p) => DR.Rail.figureMention(p.paragraphText || "", session.figures())?.id === fig.id);
  if (mentioning) rail.linkParagraph(mentioning);
  await sleep(600);
  const figEl = rail.cards.get(`g_${fig.id}`)?.el;
  step("figure-card", {
    label: figEl?.querySelector(".dr-flabel")?.textContent,
    title: figEl?.querySelector(".dr-ftitle")?.textContent,
    count: figEl?.querySelector(".dr-fcount")?.textContent,
    thumbDrawn: figEl?.querySelector(".dr-fthumb")?.dataset.drawn === "1",
    steps: figEl?.querySelectorAll(".dr-fsteps li").length,
    linkedByParagraph: !!mentioning && figEl?.classList.contains("dr-linked"),
    figures: session.figures().map((f) => f.label),
  });
  await shot("v08-figure");

  // ---- refreshed paragraph cards ----
  const paraCards = [...rail.cards.entries()].filter(([k]) => k.startsWith("p_")).map(([, c]) => c.el);
  const withRole = paraCards.filter((el) => el.dataset.role && el.querySelector(".dr-role"));
  step("cards", {
    paragraphCards: paraCards.length,
    withRolePill: withRole.length,
    sampleRole: withRole[0]?.querySelector(".dr-role")?.textContent,
    headerTint: withRole[0] && rail.readerWin.getComputedStyle(withRole[0].querySelector(".dr-phead")).backgroundColor,
  });

  // ---- 「功能」 menu ----
  const menuButton = rdoc.querySelector(".deepread-toolbar .dr-menu-button");
  const buttonText = menuButton.textContent;
  menuButton.click();
  await sleep(400);
  const menu = rdoc.querySelector(".deepread-menu.dr-features");
  const rows = () => [...menu.querySelectorAll(".dr-feature")];
  const before = rows().map((r) => `${r.querySelector("strong").textContent}:${r.getAttribute("aria-checked")}`);
  await shot("v08-menu");
  // paper scope: turn the section bar off for this paper only
  rows().find((r) => /结构条|Section bar/.test(r.textContent)).click();
  await sleep(500);
  const barGoneForPaper = !rdoc.getElementById("deepread-bar") && !rdoc.body.classList.contains("deepread-has-bar");
  const prefUntouched = DR.prefs.get("view.structureBar") === true;
  const override = session.userState.modules?.structureBar;
  rows().find((r) => /结构条|Section bar/.test(r.textContent)).click();
  await sleep(500);
  const barBack = !!rdoc.getElementById("deepread-bar");
  // default scope: figure cards off as the new default, then back
  menu.querySelectorAll(".dr-scope button")[1].click();
  rows().find((r) => /图表卡片|Figure cards/.test(r.textContent)).click();
  await sleep(500);
  const defaultOff = DR.prefs.get("view.figureCards") === false && !rail.cards.has(`g_${fig.id}`);
  rows().find((r) => /图表卡片|Figure cards/.test(r.textContent)).click();
  await sleep(500);
  menu.querySelectorAll(".dr-scope button")[0].click();
  // card placement row: global pref, rail rebuilt through its observer
  menu.querySelector(".dr-layout").click();
  await sleep(500);
  const layoutRight = DR.prefs.get("view.railLayout") === "right" && menu.querySelector(".dr-layout").getAttribute("aria-checked") === "false"
    && /右侧|right/.test(rows()[0].textContent) && !!rail.root;
  menu.querySelector(".dr-layout").click();
  await sleep(500);
  step("menu", {
    layoutRight, layoutBack: DR.prefs.get("view.railLayout") === "split" && !!rail.root,
    buttonText, before, barGoneForPaper, prefUntouched, override, barBack, defaultOff,
    defaultBackOn: DR.prefs.get("view.figureCards") === true,
    count: menuButton.querySelector(".dr-count")?.textContent,
  });
  menu.remove();
  await sleep(600);
  await shot("v08-reader");
  return { ok: true };
};
