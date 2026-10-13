/* End-to-end smoke test, executed inside the isolated test Zotero by test/dev-harness.
 * Assumes fake MinerU/LLM services (scripts/e2e.sh starts them). */
/* global E2E, Zotero, IOUtils, PathUtils, setTimeout */

E2E.run = async function () {
  const steps = E2E.result.steps;
  const step = (name, data) => {
    steps.push({ name, data, t: new Date().toISOString() });
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
    try {
      const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const data = canvas.toDataURL("image/png").split(",")[1];
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const path = PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), `${name}.png`);
      await IOUtils.write(path, bytes);
      step("screenshot", path);
    }
    catch (e) {
      step("screenshot-failed", String(e));
    }
  }

  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  step("plugin", { version: DR.version, prefPane: DR.prefPaneID });

  // Import the demo PDF once.
  const pdfPath = E2E.env("DEEPREAD_E2E_PDF");
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted);
  if (!item) {
    item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(pdfPath), libraryID: Zotero.Libraries.userLibraryID });
  }
  step("item", { id: item.id, key: item.key });

  const reset = E2E.env("E2E_RESET") !== "0";
  if (reset) await DR.Store.deletePaper(DR.util.attachmentKey(item));

  const reader = await Zotero.Reader.open(item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  step("session", { status: session.status, attached: session.overlay.attached });
  await sleep(1500);

  const progress = [];
  const off = session.on((type) => {
    if (type === "progress") progress.push(`${Math.round(session.progress.percent)} ${session.progress.message}`);
  });
  const t0 = Date.now();
  await session.run();
  off();
  const hd = session.data.hierarchicalData;
  const paragraphs = hd.flatMap((p) => p.paragraphs || []);
  const withPoints = paragraphs.filter((p) => (p.points || []).length);
  step("run", {
    ms: Date.now() - t0,
    status: session.status,
    pages: hd.length,
    paragraphs: paragraphs.length,
    withPoints: withPoints.length,
    withRects: paragraphs.filter((p) => (p.rects || []).length).length,
    articleSummary: (session.data.articleSummary || []).map((s) => s.title),
    blockMappingSections: (session.data.blockMapping || []).length,
    progressTail: progress.slice(-6),
    samplePara: withPoints[0] && {
      page: withPoints[0].pageIndex,
      summary: withPoints[0].paragraphSummary,
      rects: withPoints[0].rects.slice(0, 2),
      point: withPoints[0].points[0],
    },
  });

  const stored = await DR.Store.getPaper(session.key);
  step("stored", { has: !!stored, paragraphs: stored?.hierarchical_data?.flatMap((p) => p.paragraphs).length });

  await session.generateOutline();
  step("outline", { title: session.data.sections?.title, children: (session.data.sections?.children || []).length });

  const translation = await DR.Translate.translate("Attention is all you need.");
  step("translate", translation.slice(0, 80));

  // Navigate to the first paragraph with points and simulate a hover over it.
  const target = hd.find((p) => (p.paragraphs || []).some((x) => (x.points || []).length));
  const para = target.paragraphs.find((x) => (x.points || []).length);
  await session.navigateToParagraph({ ...para, pageIndex: target.pageIndex });
  await sleep(1200);
  const overlay = session.overlay;
  const r = overlay._rectInReaderDoc(target.pageIndex, DR.Overlay.unionRect(para.rects));
  const frame = overlay.iframeEl.getBoundingClientRect();
  const cx = (r.left + r.right) / 2 - frame.left;
  const cy = (r.top + r.bottom) / 2 - frame.top;
  const elAt = overlay.pdfDoc.elementFromPoint(cx, cy);
  const geom = overlay._geometry(target.pageIndex);
  const pdfPoint = geom && overlay._clientToPdf(geom, cx, cy);
  const fakeEvent = { target: elAt, clientX: cx, clientY: cy };
  const hit = overlay._hitTest(fakeEvent);
  let directError = null;
  let handlerError = null;
  try {
    overlay._onPointerMove({ target: elAt, clientX: cx, clientY: cy, altKey: false, buttons: 0 });
  }
  catch (e) {
    handlerError = String(e) + " " + e.stack;
  }
  await sleep(400);
  try {
    if (!overlay.card || overlay.card.hidden) {
      overlay.hoverPara = hit;
      overlay._showCard(hit);
    }
  }
  catch (e) {
    directError = String(e) + " " + e.stack;
  }
  step("hover-debug", { handlerError, directError, hoverAfter: overlay.hoverPara?.paragraphSummary });
  elAt?.dispatchEvent(new overlay.pdfWin.PointerEvent("pointermove", { bubbles: true, clientX: cx, clientY: cy }));
  await sleep(600);
  step("hover", {
    elementAt: `${elAt?.tagName}.${elAt?.className}`,
    pageOfEl: elAt?.closest?.(".page")?.dataset?.pageNumber,
    paraBBox: DR.Overlay.unionRect(para.rects),
    pdfPoint,
    geom: geom && { t: geom.t, w: geom.w, h: geom.h, divW: geom.div.clientWidth },
    hit: hit?.paragraphSummary,
    pagesKnown: [...overlay.pages.keys()],
    hoverPara: overlay.hoverPara?.paragraphSummary,
    cardVisible: !!overlay.card && !overlay.card.hidden,
    cardText: overlay.card?.textContent?.slice(0, 160),
    layers: overlay.pdfDoc.querySelectorAll(".deepread-layer").length,
  });
  await shot("reader-hover");

  // Alt-hover: in-place translation over a body paragraph.
  const bodyPage = hd.find((p) => p.pageIndex === 1) || target;
  const bodyPara = bodyPage.paragraphs.find((x) => x.paragraphType === "text" && (x.points || []).length && (x.paragraphText || "").length > 300);
  if (bodyPara) {
    await session.navigateToParagraph({ ...bodyPara, pageIndex: bodyPage.pageIndex });
    await sleep(1500);
    overlay._hideCard(true);
    overlay.altDown = true;
    const altPara = [...(overlay.pages.get(bodyPage.pageIndex) || [])].find((p) => p.paragraphIndex === bodyPara.paragraphIndex);
    overlay.hoverPara = altPara;
    overlay._drawHover(altPara);
    await sleep(300);
    step("alt-translation", { boxes: overlay.pdfDoc.querySelectorAll(".dr-translation").length });
    await shot("reader-alt-translation");
    overlay.altDown = false;
    overlay._clearTransient();
  }

  // Chat (streamed from the fake LLM).
  session.askAI({ text: para.paragraphText?.slice(0, 200), pageIndex: target.pageIndex });
  await DR.ChatPane.send(session, "这段在讲什么？");
  const last = session.chat.messages[session.chat.messages.length - 1];
  step("chat", { messages: session.chat.messages.length, last: last?.content?.slice(0, 120), error: session.chat.error });
  await sleep(800);
  await shot("reader-chat");

  const rect = (el) => el && (({ left, right, width }) => ({ left: Math.round(left), right: Math.round(right), width: Math.round(width) }))(el.getBoundingClientRect());
  const ctxPane = win.document.getElementById("zotero-context-pane");
  const sidenavEl = win.ZoteroContextPane?.sidenav;
  const chatBody = [...win.document.querySelectorAll(".dr-chat-pane")].find((n) => n.getBoundingClientRect().width > 0);
  const summaryCard = [...win.document.querySelectorAll(".dr-summary-card")].find((n) => n.getBoundingClientRect().width > 0);
  step("layout", {
    contextPane: rect(ctxPane),
    sidenav: rect(sidenavEl),
    chatPane: rect(chatBody),
    chatParent: rect(chatBody?.parentElement),
    chatSection: rect(chatBody?.closest("collapsible-section, item-pane-custom-section")),
    summaryCard: rect(summaryCard),
    summaryCardScrollW: summaryCard?.scrollWidth,
    quoteRect: rect(win.document.querySelector(".dr-quote")),
  });
  const sections = win.document.querySelectorAll("[data-pane^='deepread'], [data-pane*='deepread']");
  step("panes", { count: sections.length, ids: [...sections].map((s) => s.dataset.pane) });
  return { ok: true };
};
