/* Settings pane "检查更新" button: finds and installs the published newer version.
 * Run: E2E_ADDON_VERSION=<older> scripts/e2e.sh test/e2e/update-ui.js */
/* global E2E, Zotero, ChromeUtils, Services, IOUtils, PathUtils, setTimeout */

E2E.run = async function () {
  const steps = E2E.result.steps;
  const step = (name, data) => steps.push({ name, data });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000, label = "condition") => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  async function shot(win, name) {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0));
    await IOUtils.write(PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"), `${name}.png`), bytes);
  }
  const DR = await waitFor(() => Zotero.DeepRead, 15000, "plugin");
  const before = DR.version;
  const win = Zotero.Utilities.Internal.openPreferences(DR.prefPaneID) || await waitFor(() => Services.wm.getMostRecentWindow("zotero:pref"), 10000, "prefs");
  const doc = await waitFor(() => win.document.getElementById("deepread-pref-update-check") && win.document, 15000, "update button");
  win.resizeTo(1000, 700);
  await sleep(800);
  step("before", { pluginVersion: before, label: doc.getElementById("deepread-pref-update-version")?.value });
  await shot(win, "update-ui-before");
  doc.getElementById("deepread-pref-update-check").doCommand();
  const trace = [];
  const status = await waitFor(() => {
    const node = doc.getElementById("deepread-pref-update-status");
    const value = node?.value || "";
    if (trace[trace.length - 1] !== `${!!node}:${value}`) trace.push(`${!!node}:${value}`);
    return /已更新|Updated|已是最新|Up to date|失败|failed/.test(value) ? value : null;
  }, 60000, "update status").catch(() => null);
  step("trace", trace);
  await sleep(1500);
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const addon = await AddonManager.getAddonByID("deepread@lsy-aia.github.io");
  step("after", { status, addonVersion: addon.version, active: addon.isActive, pluginVersion: Zotero.DeepRead?.version });
  await shot(win, "update-ui-after");
  return { ok: true };
};
