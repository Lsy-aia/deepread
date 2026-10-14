/* v0.2 end-to-end: margin rail cards, inline edit/hide, flashcards (rail + pane), code pane detection.
 * Run: scripts/e2e.sh test/e2e/v02.js   (reuses parse results in the test profile if present) */
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
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) {
    item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  }
  DR.prefs.set("view.marginCards", true);
  await Zotero.Reader.open(item.id);
  const reader = Zotero.Reader._readers.find((r) => r.itemID === item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  if (!session.hasResults) await session.run();
  await sleep(1500);

  // --- rail ---
  const rail = session.rail;
  await waitFor(() => rail.root && rail.cards.size, 10000, "rail cards");
  await sleep(500);
  const railState = () => {
    const visible = [...rail.cards.entries()].filter(([, c]) => !c.el.hidden);
    const tops = visible.map(([k, c]) => ({ k, top: parseFloat(c.el.style.top), h: c.height }));
    tops.sort((a, b) => a.top - b.top);
    let overlaps = 0;
    for (let i = 1; i < tops.length; i++) if (tops[i].top < tops[i - 1].top + tops[i - 1].h) overlaps++;
    return { visible: visible.length, total: rail.cards.size, overlaps, first: tops.slice(0, 3), railWidth: rail.root.clientWidth };
  };
  step("rail-initial", railState());
  await shot("v02-rail-page1");

  const page2 = session.data.hierarchicalData.find((p) => p.pageIndex === 1);
  const para = page2.paragraphs.find((p) => (p.points || []).length > 1) || page2.paragraphs[0];
  await session.navigateToParagraph({ ...para, pageIndex: 1 });
  await sleep(1200);
  step("rail-page2", railState());
  await shot("v02-rail-page2");

  // inline edit + hide
  session.setParagraphSummary({ ...para, pageIndex: 1 }, "【已编辑】我改过的摘要");
  rail.refresh();
  await sleep(400);
  const key = `p_1_${para.paragraphIndex}`;
  step("edit", { text: rail.cards.get(key)?.el.querySelector(".dr-rsummary")?.textContent });
  session.setCardHidden(key, true);
  await sleep(400);
  step("hide", { stillThere: rail.cards.has(key), hiddenCount: session.hiddenCardCount });
  session.showHiddenCards();
  await sleep(300);

  // importance via rail
  const point = para.points?.[0];
  if (point) {
    session.setPointImportance(point.id, 3);
    await sleep(300);
    step("importance", { level: session.pointLevel(point), persistentRects: rail.overlay.pdfDoc.querySelectorAll(".dr-persistent .dr-rect").length });
  }

  // --- flashcards ---
  const before = (session.flashcards || []).length;
  const card = await session.createFlashcard({ pageIndex: 1, rects: para.rects, quote: para.paragraphText, source: "paragraph" });
  await sleep(600);
  const saved = session.flashcards.find((c) => c.id === card.id);
  step("flashcard", { before, after: session.flashcards.length, question: saved?.question, answer: saved?.answer?.slice(0, 60), inRail: rail.cards.has(`f_${card.id}`) || !!rail.cards.get(`p_1_${para.paragraphIndex}`)?.el.querySelector(".dr-fc-attached") });
  session.flipped.add(card.id);
  rail.refresh();
  await sleep(500);
  await shot("v02-rail-flashcard");

  // flashcard pane + export
  DR.Panes.reveal(reader, "flashcards");
  await sleep(800);
  const fcPane = [...win.document.querySelectorAll(".dr-fc-pane")].find((n) => n.getBoundingClientRect().width > 0);
  step("flashcard-pane", { found: !!fcPane, text: fcPane?.textContent?.slice(0, 200) });
  await shot("v02-flashcard-pane");
  const note = await DR.Flashcards.exportToNote(session.parentItem, session.flashcards, {});
  step("export", { noteID: note?.id, title: note?.getNoteTitle?.(), html: note?.getNote?.().slice(0, 200) });

  // --- code pane ---
  DR.Panes.reveal(reader, "code");
  await sleep(1500);
  const codePane = [...win.document.querySelectorAll("[data-pane*='deepread-code'] .dr-pane, .dr-code-pane")].find((n) => n.getBoundingClientRect().width > 0);
  step("code-pane", { found: !!codePane, text: codePane?.textContent?.slice(0, 300) });
  await shot("v02-code-pane");

  if (E2E.env("E2E_LIVE_GITHUB") === "1") {
    await session.setGitHubRepo("tensorflow/tensor2tensor");
    const loaded = await waitFor(() => {
      const pane = [...win.document.querySelectorAll(".dr-code-pane")].find((n) => n.getBoundingClientRect().width > 0);
      return pane && /★|stars|Apache/i.test(pane.textContent) && pane.querySelector(".dr-markdown") ? pane : null;
    }, 30000, "repo info + README").catch(() => null);
    const sidenavLeft = win.ZoteroContextPane?.sidenav?.getBoundingClientRect().left;
    const widest = [...win.document.querySelectorAll(".dr-pane")].filter((n) => n.getBoundingClientRect().width > 0)
      .map((n) => Math.round(n.getBoundingClientRect().right));
    const codeRoot = [...win.document.querySelectorAll(".dr-code-pane")].find((n) => n.getBoundingClientRect().width > 0);
    const wide = [];
    if (codeRoot) {
      for (const node of codeRoot.querySelectorAll("*")) {
        const w = node.getBoundingClientRect().width;
        if (w > 330 && ![...node.children].some((c) => c.getBoundingClientRect().width > 330)) {
          wide.push(`${node.tagName}.${node.className}#${node.id} w=${Math.round(w)} sw=${node.scrollWidth}`);
        }
      }
      let anc = codeRoot;
      const chain = [];
      while (anc && chain.length < 8) {
        chain.push(`${anc.tagName}.${String(anc.className).slice(0, 40)} w=${Math.round(anc.getBoundingClientRect().width)}`);
        anc = anc.parentElement;
      }
      step("code-wide", { wide: wide.slice(0, 12), chain });
    }
    step("code-live", { loaded: !!loaded, text: loaded?.textContent?.slice(0, 200), sidenavLeft, paneRights: widest });
    await sleep(500);
    await shot("v02-code-repo");
  }
  return { ok: true };
};
