/* v0.9: skim layers (reading depth, faded paragraphs, key sentences, folded cards, next key), hover lookup
 * (citations, figure references, glossary terms; library match), question-led reading (five questions, own
 * questions, card badges, bar markers, progress, toolbar count, side section).
 * Run: E2E_PARSER=builtin scripts/e2e.sh test/e2e/v09.js */
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
  for (const pref of ["view.marginCards", "view.structureBar", "view.figureCards", "view.skim", "view.lookup", "view.questions", "cards.autoExplain"]) DR.prefs.set(pref, true);
  DR.prefs.set("skim.depth", "full");
  DR.prefs.set("questions.hideAnswers", false);
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  session.userState.modules = {};
  session.userState.skimDepth = "full";
  await session.run();
  await waitFor(() => session.explaining.size === 0 && Object.keys(session.explanations).length > 10, 90000, "explanations");
  await waitFor(() => session.questions?.items?.length >= 5 && !session.generatingQuestions, 90000, "questions");
  await waitFor(() => session.glossary && !session.buildingGlossary, 60000, "glossary");
  const overlay = session.overlay;
  const rail = session.rail;
  const bar = session.structureBar;
  const rdoc = reader._iframeWindow.document;
  session.userState.readUpTo = 0;

  // ======== question-led reading ========
  const qs = session.questions.items;
  const firstKeys = qs.find((q) => q.keys?.length)?.keys || [];
  const [, kp] = /^p_(\d+)_/.exec(firstKeys[0] || "p_0_0");
  await session.reader.navigate({ pageIndex: Number(kp) });
  await sleep(1500);
  bar.refresh();
  await sleep(400);
  const lead = session.groupLead(firstKeys[0]);
  const badgeCard = rail.cards.get(lead)?.el;
  const questionsButton = rdoc.querySelector(".deepread-toolbar .dr-questions-button");
  const before = { button: questionsButton?.textContent, hidden: questionsButton?.hidden, marks: rdoc.querySelectorAll("#deepread-bar .dr-qmark").length };
  const asked = await session.askQuestion("Why does the model use multiple attention heads?");
  session.userState.readUpTo = 99;
  session._emit("questions");
  await sleep(500);
  step("questions", {
    count: qs.length, ids: qs.map((q) => q.id), withKeys: qs.filter((q) => q.keys?.length).length, sample: qs[0]?.question,
    badge: badgeCard?.querySelector(".dr-q")?.textContent, ...before,
    asked: { label: session.questionLabel(asked), keys: asked.keys, answer: asked.answer.slice(0, 40) },
    after: questionsButton?.textContent, progress: session.questionProgress(),
  });
  check("questions", qs.length === 5 && !!badgeCard?.querySelector(".dr-q") && before.marks > 0 && /\d\/5/.test(before.button || "")
    && asked.answer && asked.keys.length && session.questionProgress().reached === session.questionProgress().total && /6\/6/.test(questionsButton?.textContent || ""));

  // side section
  DR.Panes.reveal(reader, "questions");
  await sleep(1500);
  const pane = win.document.querySelector(".dr-questions-pane");
  step("questions-pane", { shown: !!pane, items: pane?.querySelectorAll(".dr-q-item").length, chips: pane?.querySelectorAll(".dr-q-chip").length });
  await shot("v09-questions");
  session.removeQuestion(asked.id);
  session.userState.readUpTo = 0;

  // ======== skim layers ========
  const { tier } = session.skimTiers();
  const counts = { key: 0, normal: 0, minor: 0 };
  for (const t of tier.values()) counts[t]++;
  const depthButtons = () => [...rdoc.querySelectorAll("#deepread-bar .dr-depth button")].map((b) => `${b.dataset.mode}:${b.getAttribute("aria-pressed")}`);
  const pageWith = (kind) => [...overlay.pages.keys()].find((p) => (overlay.pages.get(p) || []).some((x) => tier.get(`p_${p}_${x.paragraphIndex}`) === kind));
  const page = pageWith("minor") ?? pageWith("key");
  await session.reader.navigate({ pageIndex: page });
  await sleep(1500);
  rdoc.querySelector('#deepread-bar .dr-depth button[data-mode="key"]').click();
  await sleep(1200);
  const layer = (sel) => overlay.pdfDoc.querySelectorAll(`.deepread-layer ${sel}`).length;
  const minorOnPage = (overlay.pages.get(page) || []).filter((x) => tier.get(`p_${page}_${x.paragraphIndex}`) === "minor");
  const minorCard = minorOnPage.map((x) => rail.cards.get(session.groupLead(`p_${page}_${x.paragraphIndex}`))?.el).find(Boolean);
  const keyState = {
    depth: session.skimDepth, buttons: depthButtons(), dims: layer(".dr-dim"), keylines: layer(".dr-keyline"),
    minorCardCompact: minorCard ? minorCard.classList.contains("dr-compact") : null, time: rdoc.querySelector("#deepread-bar .dr-skimtime")?.textContent,
  };
  await shot("v09-skim-key");
  const scrollBefore = overlay.app.pdfViewer.container.scrollTop;
  const jumped = bar.goKey(1);
  await sleep(600);
  const moved = overlay.app.pdfViewer.container.scrollTop !== scrollBefore;
  rdoc.querySelector('#deepread-bar .dr-depth button[data-mode="margin"]').click();
  await sleep(1000);
  const marginState = { dims: layer(".dr-dim-strong"), compactCards: [...rail.cards.entries()].filter(([k, c]) => k.startsWith("p_") && c.el.classList.contains("dr-compact")).length, paraCards: [...rail.cards.keys()].filter((k) => k.startsWith("p_")).length };
  rdoc.querySelector('#deepread-bar .dr-depth button[data-mode="full"]').click();
  await sleep(800);
  step("skim", { counts, page, key: keyState, jumped, moved, margin: marginState, fullDims: layer(".dr-dim"), saved: session.userState.skimDepth });
  check("skim", counts.key > 0 && counts.minor > 0 && keyState.dims > 0 && keyState.buttons.includes("key:true") && jumped && moved
    && marginState.dims > 0 && marginState.compactCards === marginState.paraCards && layer(".dr-dim") === 0);

  // ======== hover lookup ========
  const lookup = session.lookup;
  const refs = session.references().list;
  // Find a text span on a page and hover its middle char: returns the probe result.
  async function hoverText(re) {
    for (const pageIndex of [...overlay.pages.keys()].sort((a, b) => a - b)) {
      const chars = await lookup._pageChars(pageIndex);
      let text = "";
      const index = [];
      chars.forEach((c, i) => {
        for (const ch of (c.u || "")) {
          text += ch;
          index.push(i);
        }
        if (c.spaceAfter) {
          text += " ";
          index.push(i);
        }
      });
      const m = re.exec(text);
      if (!m) continue;
      await session.reader.navigate({ pageIndex });
      await sleep(1500);
      const ci = index[m.index + Math.floor(m[0].length / 2)];
      const rect = chars[ci].rect;
      const geom = overlay._geometry(pageIndex);
      const pct = overlay._toPercent(geom, [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]);
      const box = geom.div.getBoundingClientRect();
      const x = box.left + geom.div.clientLeft + ((pct.left + pct.width / 2) / 100) * geom.div.clientWidth;
      const y = box.top + geom.div.clientTop + ((pct.top + pct.height / 2) / 100) * geom.div.clientHeight;
      const found = await lookup.probe(pageIndex, x, y);
      await sleep(200);
      return { pageIndex, match: m[0], found, popover: lookup.popover && !lookup.popover.hidden ? lookup.popover.textContent.slice(0, 120) : null };
    }
    return null;
  }
  const cite = await hoverText(/\[\d{1,2}\]/);
  await shot("v09-lookup-cite");
  lookup.hide();
  const figRef = await hoverText(/Figure 1\b/);
  await shot("v09-lookup-figure");
  lookup.hide();
  const termName = session.glossary.terms?.[0]?.term || "self-attention";
  const term = await hoverText(new RegExp(termName.replace(/[-\s]/g, "[-\\s]?"), "i"));
  lookup.hide();
  step("lookup", {
    refs: refs.length, sampleRef: refs[0] && { id: refs[0].id, title: refs[0].title, year: refs[0].year },
    glossary: { symbols: session.glossary.symbols?.length, terms: session.glossary.terms?.length },
    cite: cite && { kind: cite.found?.kind, match: cite.match, popover: cite.popover },
    figure: figRef && { kind: figRef.found?.kind, popover: figRef.popover },
    term: term && { kind: term.found?.kind, match: term.match, popover: term.popover },
  });
  check("lookup", refs.length > 20 && cite?.found?.kind === "citation" && !!cite.popover && figRef?.found?.kind === "figure" && term?.found?.kind === "term");

  // In the library: add a regular item titled like a cited reference → popover says so.
  const target = refs.find((r) => r.title && r.title.length > 15);
  const libItem = new Zotero.Item("journalArticle");
  libItem.setField("title", target.title);
  await libItem.saveTx();
  DR.Lookup._libCache = null;
  const inLib = await DR.Lookup.findInLibrary(target);
  step("library", { title: target.title, found: inLib?.id === libItem.id });
  check("library", inLib?.id === libItem.id);
  await libItem.eraseTx();

  // module off for this paper → no lookup
  DR.Modules.set(session, "lookup", false, "paper");
  const off = await hoverText(/\[\d{1,2}\]/);
  DR.Modules.set(session, "lookup", true, "paper");
  step("lookup-off", { found: off?.found || null });
  check("lookup-off", !off?.found);

  // 功能 menu lists the new modules
  rdoc.querySelector(".deepread-toolbar .dr-menu-button").click();
  await sleep(400);
  const menu = rdoc.querySelector(".deepread-menu.dr-features");
  const rows = [...menu.querySelectorAll(".dr-feature strong")].map((s) => s.textContent);
  menu.remove();
  step("menu", { rows, count: rdoc.querySelector(".deepread-toolbar .dr-count")?.textContent });
  check("menu", ["速读分层", "悬停查证", "问题导向"].every((r) => rows.includes(r)));

  step("result", { fail });
  return { ok: !fail.length, fail };
};
