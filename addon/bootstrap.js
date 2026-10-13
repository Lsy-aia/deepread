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

  // The bootstrap sandbox has no `console`; route the (chatty) ported code to Zotero's debug log.
  const fmt = (args) => args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || String(a);
    try {
      return JSON.stringify(a)?.slice(0, 2000);
    }
    catch (e) {
      return String(a);
    }
  }).join(" ");
  const verbose = () => Zotero.Prefs.get("deepread.debug") === true;
  const consoleShim = {
    log: (...args) => verbose() && Zotero.debug(`[DeepRead] ${fmt(args)}`, 5),
    debug: (...args) => verbose() && Zotero.debug(`[DeepRead] ${fmt(args)}`, 5),
    info: (...args) => Zotero.debug(`[DeepRead] ${fmt(args)}`, 4),
    warn: (...args) => Zotero.debug(`[DeepRead][warn] ${fmt(args)}`, 3),
    error: (...args) => Zotero.debug(`[DeepRead][error] ${fmt(args)}`, 2),
  };

  const scope = {
    Zotero, Services, Components, ChromeUtils,
    Cc: Components.classes, Ci: Components.interfaces, Cu: Components.utils,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    console: consoleShim,
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
