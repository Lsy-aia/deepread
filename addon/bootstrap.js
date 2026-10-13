/* DeepRead for Zotero — bootstrap entry. License: AGPL-3.0-or-later */
/* global Zotero, Services, Components, ChromeUtils, APP_SHUTDOWN */

var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;

  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "deepread", rootURI + "content/"],
  ]);

  // Privileged globals the bootstrap sandbox does not expose by default.
  const globalNames = [
    "fetch", "URL", "URLSearchParams", "TextDecoder", "TextEncoder", "Blob", "FormData",
    "AbortController", "crypto", "btoa", "atob", "IOUtils", "PathUtils", "structuredClone",
  ];
  for (const name of globalNames) {
    try {
      Components.utils.importGlobalProperties([name]);
    }
    catch (e) {
      Zotero.debug(`DeepRead: global ${name} unavailable: ${e}`);
    }
  }
  const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  const scope = {
    Zotero, Services, Components, ChromeUtils,
    Cc: Components.classes, Ci: Components.interfaces, Cu: Components.utils,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    console,
    DeepRead: { id, version, rootURI },
  };
  for (const name of globalNames) {
    if (typeof globalThis[name] !== "undefined") {
      scope[name] = globalThis[name];
    }
  }
  Services.scriptloader.loadSubScript(rootURI + "content/scripts/index.js", scope);
  Zotero.DeepRead = scope.DeepRead;
  await scope.DeepRead.startup();
}

function onMainWindowLoad({ window }) {
  Zotero.DeepRead?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  Zotero.DeepRead?.onMainWindowUnload(window);
}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  try {
    await Zotero.DeepRead?.shutdown();
  }
  finally {
    delete Zotero.DeepRead;
    chromeHandle?.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
