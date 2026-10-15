/* v0.8.1: hover translation beside the paragraph on two-column pages (fitted to the paragraph's box),
 * merged paragraph cards, keep-open cards, configurable highlighter, folding the card rails, figure/table colours.
 * Run: E2E_PARSER=builtin E2E_PDF2=$PWD/test/fixtures/twocol/diffusion-policy-orig.pdf scripts/e2e.sh test/e2e/v081.js */
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
  win.resizeTo(1700, 1000);
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
  const fail = [];
  const check = (name, ok) => { if (!ok) fail.push(name); };

  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  for (const pref of ["view.marginCards", "view.translationPopup", "view.figureCards", "cards.autoExplain", "cards.keepOpen", "cards.groupParagraphs"]) DR.prefs.set(pref, true);
  DR.prefs.set("view.railLayout", "split");
  DR.prefs.set("view.railCollapsedLeft", false);
  DR.prefs.set("view.railCollapsedRight", false);
  DR.prefs.setHighlightColors(["#3b82f6", "#ef4444"]);

  async function open(path) {
    const name = path.split("/").pop();
    let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === name);
    if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(path), libraryID: Zotero.Libraries.userLibraryID });
    await Zotero.Reader.open(item.id);
    const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
    await reader._initPromise;
    const session = DR.Session.forReader(reader);
    await session.init();
    session.userState.modules = {};
    await session.run();
    await waitFor(() => session.explaining.size === 0 && Object.keys(session.explanations).length > 5, 60000, "explanations");
    await sleep(1500);
    return { reader, session };
  }

  // ======== two-column paper ========
  const { session } = await open(E2E.env("E2E_PDF2"));
  const overlay = session.overlay;
  const rail = session.rail;

  // ---- 1) hover translation beside the paragraph, same box ----
  const pageIndex = [...overlay.pages.keys()].find((p) => overlay.isTwoColumn(p) && (overlay.pages.get(p) || []).filter((x) => overlay._paragraphTranslation(x)).length > 3);
  await session.reader.navigate({ pageIndex });
  await sleep(1500);
  const geom = overlay._geometry(pageIndex);
  const paras = (overlay.pages.get(pageIndex) || []).filter((p) => overlay._paragraphTranslation(p) && p.paragraphType !== "title");
  const sideOf = (p) => { const pct = overlay._toPercent(geom, p.bbox); return pct.width > 60 ? "wide" : pct.left + pct.width / 2 < 50 ? "left" : "right"; };
  const hover = async (p) => {
    overlay._suppressPara = null;
    overlay._setHover(p);
    await sleep(450);
    const box = overlay.pdfDoc.querySelector(".dr-translation");
    const outline = overlay.pdfDoc.querySelector(".dr-outline");
    const b = box?.getBoundingClientRect();
    const o = outline?.getBoundingClientRect();
    const r = {
      shown: !!box, side: box?.dataset.side, scale: box?.dataset.scale,
      widthDiff: b && o ? Math.round(Math.abs(b.width - o.width)) : null,
      heightDiff: b && o ? Math.round(b.height - o.height) : null,
      topDiff: b && o ? Math.round(b.top - o.top) : null,
      overlaps: !!(b && o && b.left < o.right - 3 && b.right > o.left + 3 && b.top < o.bottom - 3 && b.bottom > o.top + 3),
    };
    overlay._setHover(null);
    await sleep(100);
    return r;
  };
  const leftPara = paras.find((p) => sideOf(p) === "left" && (p.bbox[3] - p.bbox[1]) > 40);
  const rightPara = paras.find((p) => sideOf(p) === "right" && (p.bbox[3] - p.bbox[1]) > 40);
  const left = await hover(leftPara);
  const right = await hover(rightPara);
  step("hover-twocol", { pageIndex, left, right });
  check("left→right", left.side === "right" && !left.overlaps && left.widthDiff < 16 && Math.abs(left.topDiff) < 8 && left.heightDiff > -8);
  check("right→left", right.side === "left" && !right.overlaps && right.widthDiff < 16 && Math.abs(right.topDiff) < 8);
  overlay._setHover(leftPara);
  await sleep(450);
  await shot("v081-hover-twocol");
  overlay._setHover(null);

  // ---- 2) merged cards ----
  const groups = Object.entries(session.explanations).filter(([, e]) => Array.isArray(e.members) && e.members.length > 1);
  const [lead, entry] = groups.find(([k]) => k.startsWith(`p_${pageIndex}_`)) || groups[0];
  const follower = entry.members[1];
  const [, fp, fi] = /^p_(\d+)_(\d+)$/.exec(follower);
  await session.reader.navigate({ pageIndex: Number(fp) });
  await sleep(1500);
  const followerPara = (overlay.pages.get(Number(fp)) || []).find((p) => p.paragraphIndex === Number(fi));
  overlay.openParagraph(followerPara);
  await sleep(900);
  const leadCard = rail.cards.get(lead)?.el;
  step("merged", {
    groups: groups.length, lead, members: entry.members, title: entry.title,
    followerHasNoCard: !rail.cards.has(follower), focus: rail.focusKey,
    groupClass: !!leadCard?.classList.contains("dr-group"), range: leadCard?.querySelector(".dr-range")?.textContent,
    headText: leadCard?.querySelector(".dr-rsummary")?.textContent,
    chatLabel: DR.ChatPane.systemPrompt(session).includes(`[${session.groupLabel(lead)}]`),
  });
  check("merged", groups.length > 0 && !rail.cards.has(follower) && rail.focusKey === lead && leadCard?.classList.contains("dr-group"));
  await shot("v081-merged");

  // ---- 3) keep cards open ----
  const others = [...rail.cards.keys()].filter((k) => k.startsWith("p_") && k !== lead);
  const other = session._paragraphByKey(others[0]);
  overlay.openParagraph(null); // blank click
  await sleep(400);
  const stillOpen = rail.isOpen(lead);
  overlay.openParagraph({ ...other.paragraph, pageIndex: other.page.pageIndex });
  await sleep(400);
  const both = rail.isOpen(lead) && rail.isOpen(rail.focusKey);
  const openCount = rail.openCount;
  rail.collapseAll();
  await sleep(300);
  step("keep-open", { stillOpen, both, openCount, afterCollapseAll: rail.openCount });
  check("keep-open", stillOpen && both && openCount >= 2 && rail.openCount === 0);
  DR.prefs.set("cards.keepOpen", false);
  overlay.openParagraph(followerPara);
  await sleep(300);
  overlay.openParagraph(null);
  await sleep(300);
  const foldsWhenOff = !rail.isOpen(lead);
  DR.prefs.set("cards.keepOpen", true);
  step("keep-open-off", { foldsWhenOff });
  check("keep-open-off", foldsWhenOff);

  // ---- 4) highlighter: three colours → four clicks back to none ----
  DR.prefs.setHighlightColors(["#22c55e", "#f59e0b", "#a855f7"]);
  await sleep(400);
  const withPoints = [...rail.cards.entries()].find(([k, c]) => k.startsWith("p_") && c.el.querySelector(".dr-points li"));
  const cardKey = withPoints[0];
  const levels = [];
  for (let i = 0; i < 4; i++) {
    rail.cards.get(cardKey).el.querySelector(".dr-points li").click();
    await sleep(300);
    const li = rail.cards.get(cardKey).el.querySelector(".dr-points li");
    levels.push(`${li.dataset.level}:${li.style.getPropertyValue("--dr-hl") || "-"}`);
  }
  const rects = overlay.pdfDoc.querySelectorAll(".deepread-layer .dr-persistent .dr-rect, .deepread-layer .dr-rect").length;
  step("highlighter", { levels, rects });
  check("highlighter", levels.join(",") === "2:#22c55e,3:#f59e0b,4:#a855f7,1:-");
  DR.prefs.setHighlightColors(["#3b82f6", "#ef4444"]);

  // ---- 5) fold the rails ----
  const widthBefore = rail.root.getBoundingClientRect().width;
  rail.root.querySelector(".dr-collapse").click();
  await sleep(600);
  const folded = {
    pref: DR.prefs.get("view.railCollapsedRight"), cls: rail.root.classList.contains("dr-collapsed"),
    width: Math.round(rail.root.getBoundingClientRect().width), cards: rail.root.querySelectorAll(".dr-rcard").length,
    leftCards: rail.leftRoot ? rail.leftRoot.querySelectorAll(".dr-rcard").length : null,
  };
  await shot("v081-folded");
  rail.root.click();
  await sleep(800);
  const unfolded = { pref: DR.prefs.get("view.railCollapsedRight"), width: Math.round(rail.root.getBoundingClientRect().width), cards: rail.root.querySelectorAll(".dr-rcard").length };
  step("fold", { widthBefore: Math.round(widthBefore), folded, unfolded });
  check("fold", folded.pref === true && folded.cls && folded.width <= 30 && folded.cards === 0 && unfolded.pref === false && unfolded.cards > 0);

  // ---- 6) 功能 menu rows ----
  const rdoc = session.reader._iframeWindow.document;
  rdoc.querySelector(".deepread-toolbar .dr-menu-button").click();
  await sleep(400);
  const menu = rdoc.querySelector(".deepread-menu.dr-features");
  const menuInfo = {
    keepOpen: menu.querySelector(".dr-keepopen")?.getAttribute("aria-checked"),
    swatches: menu.querySelectorAll(".dr-hl-row input[type=color]").length,
    fold: menu.querySelectorAll(".dr-fold-row button").length,
    rewrite: [...menu.querySelectorAll("button")].some((b) => /重新生成全部 AI 讲解|Rewrite all/.test(b.textContent)),
  };
  menu.querySelector(".dr-hl-row button:last-child").click(); // + colour
  await sleep(200);
  menuInfo.afterPlus = DR.prefs.highlightColors().length;
  await shot("v081-menu");
  menu.remove();
  DR.prefs.setHighlightColors(["#3b82f6", "#ef4444"]);
  step("menu", menuInfo);
  check("menu", menuInfo.keepOpen === "true" && menuInfo.swatches === 2 && menuInfo.fold === 2 && menuInfo.afterPlus === 3);

  // ======== one-column paper: figure / table card colours ========
  const second = await open(E2E.env("DEEPREAD_E2E_PDF"));
  const figs = second.session.figures();
  const kinds = {};
  for (const kind of ["figure", "table"]) {
    const f = figs.find((x) => x.kind === kind);
    if (!f) continue;
    await second.session.reader.navigate({ pageIndex: f.pageIndex });
    await sleep(1800);
    const el = await waitFor(() => second.session.rail.cards.get(`g_${f.id}`)?.el, 10000, `${kind} card`);
    const cs = second.session.rail.readerWin.getComputedStyle(el);
    kinds[kind] = { dataKind: el.dataset.kind, stripe: cs.borderInlineStartColor || cs.borderLeftColor, label: el.querySelector(".dr-flabel")?.textContent };
  }
  await shot("v081-figure");
  step("figure-kinds", { count: figs.length, kinds });
  check("figure-kinds", kinds.figure?.dataKind === "figure" && kinds.table?.dataKind === "table" && kinds.figure.stripe !== kinds.table.stripe);

  step("result", { fail });
  return { ok: !fail.length, fail };
};
