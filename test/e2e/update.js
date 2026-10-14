/* Self-update check against the published update.json (network).
 * Run: E2E_ADDON_VERSION=0.3.0 scripts/e2e.sh test/e2e/update.js */
/* global E2E, Zotero, ChromeUtils, setTimeout */

E2E.run = async function () {
  const steps = E2E.result.steps;
  const step = (name, data) => steps.push({ name, data });
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const ID = "deepread@lsy-aia.github.io";
  let addon = await AddonManager.getAddonByID(ID);
  step("installed", { version: addon.version, updateURL: addon.updateURL, active: addon.isActive });

  const found = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    addon.findUpdates({
      onUpdateAvailable: (a, install) => finish({ available: true, version: install.version, install }),
      onNoUpdateAvailable: () => finish({ available: false }),
      onUpdateFinished: (a, error) => finish({ available: false, error }),
    }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
    setTimeout(() => finish({ available: false, error: "timeout" }), 60000);
  });
  step("findUpdates", { available: found.available, version: found.version, error: found.error ?? null });

  if (found.install) {
    await found.install.install();
    await new Promise((r) => setTimeout(r, 2000));
    addon = await AddonManager.getAddonByID(ID);
    step("after-install", { version: addon.version, active: addon.isActive, pluginLoaded: !!Zotero.DeepRead, pluginVersion: Zotero.DeepRead?.version });
  }
  return { ok: true };
};
