/* In-place plugin restart (what an update does) with a PDF already open: the toolbar must come back
 * without reopening the tab, and must not linger while the plugin is off.
 * Run: scripts/e2e.sh test/e2e/restart.js */
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

  await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  // Tabs restored at app start may have drawn their toolbar before the plugin registered.
  await sleep(4000);
  step("startup", {
    selectedTab: Zotero.getMainWindow().Zotero_Tabs.selectedType,
    readers: Zotero.Reader._readers.map((r) => {
      const d = r._iframeWindow?.document;
      return { itemID: r.itemID, toolbar: !!d?.querySelector(".deepread-toolbar"), sections: !!d?.querySelector(".end > .custom-sections") };
    }),
  });
  let item = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).find((i) => i.isPDFAttachment() && !i.deleted && i.attachmentFilename === "demo-paper.pdf");
  if (!item) item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env("DEEPREAD_E2E_PDF")), libraryID: Zotero.Libraries.userLibraryID });
  await Zotero.Reader.open(item.id);
  const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === item.id), 10000, "reader");
  await reader._initPromise;
  const doc = reader._iframeWindow.document;
  const toolbars = () => doc.querySelectorAll(".deepread-toolbar").length;
  await waitFor(() => toolbars(), 10000, "toolbar before restart");
  step("before", { toolbars: toolbars() });

  const addon = await AddonManager.getAddonByID("deepread@lsy-aia.github.io");
  await addon.disable();
  await sleep(1500);
  step("disabled", { plugin: !!Zotero.DeepRead, toolbars: toolbars() });

  await addon.enable();
  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin after enable");
  await sleep(1500);
  const after = toolbars();
  let menuItems = null;
  const button = doc.querySelector(".deepread-toolbar .dr-menu-button");
  if (button) {
    button.click();
    await sleep(300);
    const menu = doc.querySelector(".deepread-menu");
    menuItems = menu ? menu.querySelectorAll("button").length : 0;
    menu?.remove();
  }
  const session = DR.Session.forReader(reader);
  await session.init();
  await sleep(800);
  step("after", {
    toolbars: after,
    menuItems,
    runLabel: doc.querySelector(".deepread-toolbar .dr-run")?.textContent,
    hasResults: session.hasResults,
    railAttached: !!session.rail?.root?.isConnected || !session.hasResults,
  });
  return { ok: after === 1 };
};
