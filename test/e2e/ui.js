/* UI smoke test: settings pane renders with localized labels and bound prefs; toolbar menu opens.
 * Run: scripts/e2e.sh test/e2e/ui.js */
/* global E2E, Zotero, IOUtils, PathUtils, setTimeout */

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
  async function shot(win, name) {
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

  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  const main = Zotero.getMainWindow();
  main.resizeTo(1600, 1000);

  // --- Settings pane ---
  const prefsWin = Zotero.Utilities.Internal.openPreferences(DR.prefPaneID);
  const win = prefsWin || await waitFor(() => Services.wm.getMostRecentWindow("zotero:pref"), 10000, "prefs window");
  await waitFor(() => win.document.getElementById("deepread-pref-root"), 15000, "pref pane");
  win.resizeTo(1000, 1100);
  await sleep(1500);
  const doc = win.document;
  const root = doc.getElementById("deepread-pref-root");
  const unlocalized = [...root.querySelectorAll("[data-l10n-id]")]
    .filter((el) => !el.textContent.trim() && !el.getAttribute("label") && !el.getAttribute("value")
      && !el.getAttribute("placeholder") && !el.getAttribute("title") && !el.getAttribute("tooltiptext")
      && el.tagName !== "html:link")
    .map((el) => `${el.tagName}#${el.id}:${el.dataset.l10nId}`);
  const baseInput = root.querySelector('[preference="extensions.zotero.deepread.llm.baseURL"]');
  step("prefs", {
    l10nElements: root.querySelectorAll("[data-l10n-id]").length,
    unlocalized: unlocalized.slice(0, 20),
    baseURLValue: baseInput?.value,
    baseURLPref: Zotero.Prefs.get("deepread.llm.baseURL"),
    providerVisible: [...root.querySelectorAll("[id*='mineru'], [id*='selfhost']")].filter((e) => !e.hidden).map((e) => e.id).slice(0, 8),
  });
  await shot(win, "prefs-top");
  {
    const fs = doc.getElementById("deepread-pref-card-fontsize");
    const before = Zotero.Prefs.get("deepread.view.cardFontSize");
    fs.value = "15";
    fs.dispatchEvent(new win.Event("input", { bubbles: true }));
    const after = Zotero.Prefs.get("deepread.view.cardFontSize");
    const lbl = doc.getElementById("deepread-pref-card-fontsize-value")?.value;
    Zotero.Prefs.set("deepread.view.cardFontSize", 12);
    step("prefs-cardfontsize", { before, after, label: lbl, ok: after === 15 });
    if (after !== 15) throw new Error("cardFontSize pref not updated by slider: " + after);
  }
  const llmTest = root.querySelector("[id*='llm'][id*='test']");
  if (llmTest) {
    llmTest.click();
    await sleep(2500);
    const status = root.querySelector("[id*='llm'][id*='status']");
    step("prefs-llm-test", { button: llmTest.id, status: status?.textContent, cls: status?.className });
  }
  const scroller = doc.querySelector("#prefs-content, .main-content, #content") || doc.documentElement;
  root.scrollIntoView?.({ block: "end" });
  await sleep(500);
  await shot(win, "prefs-bottom");
  win.close();

  // --- Toolbar menu ---
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) {
    item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  }
  await Zotero.Reader.open(item.id);
  const reader = Zotero.Reader._readers.find((r) => r.itemID === item.id);
  await reader._initPromise;
  const session = DR.Session.forReader(reader);
  await session.init();
  await sleep(1500);
  const rdoc = reader._iframeWindow.document;
  const menuButton = await waitFor(() => rdoc.querySelector(".deepread-toolbar .dr-menu-button"), 10000, "toolbar");
  menuButton.click();
  await sleep(400);
  const menu = rdoc.querySelector(".deepread-menu");
  step("toolbar-menu", { open: !!menu, items: [...(menu?.querySelectorAll("button") || [])].map((b) => b.textContent) });
  await shot(main, "toolbar-menu");
  return { ok: true };
};
