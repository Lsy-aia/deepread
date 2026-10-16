/* v1.0: guided reading (带读) through the ③ Agent channel — a local CLI agent (test/fake-agent.mjs standing in
 * for Codex), cancel / failure, the remote API kind, importing a result, the panel's five steps, notes on the cards,
 * saving as a Zotero note.
 * Run: scripts/e2e.sh test/e2e/v10.js */
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
  for (const pref of ["view.marginCards", "view.guided", "cards.autoExplain"]) DR.prefs.set(pref, true);
  const pdf = E2E.env("DEEPREAD_E2E_PDF");
  const repo = PathUtils.parent(PathUtils.parent(PathUtils.parent(PathUtils.parent(pdf))));
  const node = await DR.AgentRunner.findExecutable("node");
  const fakeAgent = PathUtils.join(repo, "test", "fake-agent.mjs");
  const agentCommand = (extra = "") => `"${node}" "${fakeAgent}" --cd {workdir} ${extra} {prompt}`;
  DR.prefs.set("agent.kind", "codex");
  DR.prefs.set("agent.command", agentCommand());
  DR.prefs.set("agent.timeoutMin", 2);

  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(pdf), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  session.userState.modules = {};
  if (!session.hasResults) await session.run();
  await waitFor(() => session.explaining.size === 0, 90000, "explanations");
  session.guide = null;
  const rdoc = reader._iframeWindow.document;
  const panel = session.guidePanel;

  // ---- 1) toolbar button + empty panel ----
  const guideButton = rdoc.querySelector(".deepread-toolbar .dr-guide-button");
  guideButton.click();
  await sleep(500);
  const host = rdoc.querySelector("#primary-view .deepread-guide");
  const railHidden = rdoc.defaultView.getComputedStyle(session.rail.root).display === "none";
  step("open", { button: guideButton.textContent, hostShown: !!host, railHidden, emptyText: host?.textContent.slice(0, 80) });
  check("open", !!host && railHidden && panel.isOpen);

  // ---- 2) local agent (fake Codex) ----
  const logs = [];
  const off = session.on((type) => {
    if (type === "guide" && session.guideRun) logs.push(session.guideRun.status);
  });
  const t0 = Date.now();
  await session.runGuide();
  off();
  const g = session.guide;
  const workdirs = await IOUtils.getChildren(PathUtils.join(Zotero.DataDirectory.dir, "deepread", "agent", session.key));
  const last = workdirs.sort().at(-1);
  const files = (await IOUtils.getChildren(last)).map((p) => PathUtils.filename(p)).sort();
  step("agent", {
    ms: Date.now() - t0, statuses: [...new Set(logs)], kind: g?.meta?.kind, files,
    xray: g?.markdown?.xray?.length, card: g?.markdown?.card?.length,
    counts: DR.GuideView.stepCounts(g), components: g?.method?.components?.map((c) => `${c.name}:${c.verdict}:${c.keys.length}`),
    questions: g?.position?.questions?.length,
  });
  check("agent", g?.meta?.kind === "codex" && files.includes("paper.md") && files.includes("xray.md") && files.includes("paper-card.md")
    && logs.includes("running") && logs.includes("structuring") && g.method.components.length > 0 && DR.GuideView.stepCounts(g).every((n) => n > 0));

  // ---- 3) the five steps in the panel ----
  const bodies = {};
  for (let n = 1; n <= 5; n++) {
    panel.actions().setStep(n);
    await sleep(250);
    bodies[n] = host.textContent.length;
    if (n === 3) await shot("v10-guide-method");
  }
  panel.actions().setStep(4);
  await sleep(250);
  await shot("v10-guide-evidence");
  const chips = host.querySelectorAll("[data-key], .dr-chip, .dr-gchip").length;
  panel.actions().setStep(1);
  step("panel", { bodies, tabs: host.querySelectorAll("[role=tab], .dr-gtab, .dr-guide-tab").length, chips, header: host.textContent.slice(0, 60) });
  check("panel", Object.values(bodies).every((n) => n > 80));

  // ---- 4) notes on the cards ----
  panel.close();
  await sleep(500);
  const noteKey = g.method.components.flatMap((c) => c.keys)[0] || g.evidence.hedges.flatMap((h) => h.keys)[0];
  const [, np, ni] = /^p_(\d+)_(\d+)$/.exec(noteKey);
  await session.openBlock(Number(np), Number(ni));
  await sleep(1200);
  const card = session.rail.cards.get(session.groupLead(noteKey))?.el;
  step("card-notes", { key: noteKey, notes: [...(card?.querySelectorAll(".dr-guide-note") || [])].map((n) => n.textContent), railBack: rdoc.defaultView.getComputedStyle(session.rail.root).display !== "none" });
  check("card-notes", !!card?.querySelector(".dr-guide-note"));
  await shot("v10-card-notes");

  // ---- 5) cancel and failure keep the previous result ----
  DR.prefs.set("agent.command", agentCommand("--slow 8000"));
  const pending = session.runGuide().catch((e) => e);
  await sleep(1200);
  const whileRunning = { status: session.guideStatus, button: guideButton.textContent };
  session.cancelGuide();
  await pending;
  const afterCancel = { status: session.guideStatus, kept: session.guide === g };
  DR.prefs.set("agent.command", agentCommand("--fail"));
  const err = await session.runGuide().catch((e) => e);
  const afterFail = { status: session.guideStatus, error: String(err?.message || err).slice(0, 80) };
  step("cancel-fail", { whileRunning, afterCancel, afterFail });
  check("cancel-fail", whileRunning.status === "running" && afterCancel.status === "ready" && afterCancel.kept && afterFail.status === "error" && /xray|退出码|exit/.test(afterFail.error));
  session.guideRun = null;

  // ---- 6) remote API kind ----
  DR.prefs.set("agent.kind", "api");
  DR.prefs.set("agent.api.baseURL", DR.prefs.get("llm.baseURL"));
  DR.prefs.set("agent.api.model", "agent-model");
  await session.runGuide();
  step("api", { kind: session.guide?.meta?.kind, model: session.guide?.meta?.model, xray: session.guide?.markdown?.xray?.length, counts: DR.GuideView.stepCounts(session.guide) });
  check("api", session.guide?.meta?.kind === "api" && session.guide.markdown.xray.length > 50);

  // ---- 7) import a paper card produced elsewhere ----
  const importPath = PathUtils.join(PathUtils.tempDir, "deepread-e2e-card.md");
  const sections = ["基本信息", "一句话总结", "研究问题", "背景与发展脉络", "核心痛点", "核心思想", "方法总览", "模块拆解", "关键公式", "证据链", "结论的正确解读", "作者承认的局限", "批判性分析", "学到的知识", "与已有知识的联系", "研究想法"];
  await IOUtils.writeUTF8(importPath, `# 精读卡\n\n${sections.map((s, i) => `## ${String(i + 1).padStart(2, "0")} ${s}\n\n内容 ${i + 1}，见 [p. 1 ¶2]。`).join("\n\n")}\n`);
  await session.importGuide(importPath);
  step("import", { kind: session.guide?.meta?.kind, source: session.guide?.meta?.source, card: session.guide?.markdown?.card?.length, sections: DR.Guide.cardSections(session.guide.markdown.card).length });
  check("import", session.guide?.meta?.kind === "import" && DR.Guide.cardSections(session.guide.markdown.card).length === 16);
  await IOUtils.remove(importPath);

  // ---- 8) save as a Zotero note ----
  const note = await session.saveGuideNote();
  const html = note?.getNote() || "";
  step("note", { id: note?.id, parent: note?.parentID, length: html.length, hasCard: /研究想法/.test(html) });
  check("note", !!note && html.length > 200);
  await note?.eraseTx();

  // ---- 9) settings: the module switch hides the button ----
  DR.Modules.set(session, "guided", false, "paper");
  await sleep(300);
  const hiddenOff = guideButton.hidden;
  DR.Modules.set(session, "guided", true, "paper");
  await sleep(300);
  step("module", { hiddenOff, shownOn: !guideButton.hidden });
  check("module", hiddenOff && !guideButton.hidden);

  panel.open(5);
  await sleep(500);
  await shot("v10-guide-takeaway");
  panel.close();
  DR.prefs.set("agent.kind", "none");
  DR.prefs.set("agent.command", "");
  step("result", { fail });
  return { ok: !fail.length, fail };
};
