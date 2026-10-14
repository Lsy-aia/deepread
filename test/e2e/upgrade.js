/* In-place upgrade with a PDF open (what auto-update / 检查更新 does): old version's shutdown and the
 * new version's startup run back to back. The toolbar must work afterwards without reopening the tab.
 * Run: E2E_BASE_XPI=<old.xpi> E2E_UPDATE_XPI=<new.xpi> scripts/e2e.sh test/e2e/upgrade.js */
/* global E2E, Zotero, ChromeUtils, setTimeout */

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
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const describe = (doc) => ({
    toolbars: doc.querySelectorAll(".deepread-toolbar").length,
    buttons: [...doc.querySelectorAll(".deepread-toolbar button")].map((b) => b.textContent.trim()),
  });

  const OLD = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const doc = reader._iframeWindow.document;
  await waitFor(() => doc.querySelector(".deepread-toolbar"), 10000, "toolbar before upgrade");
  doc.querySelector(".deepread-toolbar").dataset.e2e = "old";
  step("before", { version: OLD.version, ...describe(doc) });

  const errors = [];
  const listener = { observe: (m) => { if (/deepread/i.test(String(m.message || m))) errors.push(String(m.message || m).slice(0, 300)); } };
  Services.console.registerListener(listener);
  const install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(E2E.env("E2E_UPDATE_XPI")));
  await install.install();
  const NEW = await waitFor(() => Zotero.DeepRead && Zotero.DeepRead !== OLD && Zotero.DeepRead, 20000, "new version");
  await sleep(2500);
  Services.console.unregisterListener(listener);
  const after = describe(doc);
  let menu = null;
  const button = doc.querySelector(".deepread-toolbar .dr-menu-button");
  if (button) {
    button.click();
    await sleep(300);
    const m = doc.querySelector(".deepread-menu");
    menu = m ? [...m.querySelectorAll("button")].map((b) => b.textContent) : null;
    m?.remove();
  }
  const replaced = !doc.querySelector('.deepread-toolbar[data-e2e="old"]');
  step("after", { version: NEW.version, started: !!NEW.prefPaneID, ...after, replaced, menu, errors: errors.filter((e) => !/DEBUG/.test(e)).slice(0, 8) });
  return { ok: after.toolbars === 1 && replaced };
};
