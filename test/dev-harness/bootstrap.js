/*
 * TEST PROFILE ONLY. At startup, if DEEPREAD_E2E_SCRIPT points to a local test file, load it,
 * call its exported `run(ctx)` and write the JSON result to DEEPREAD_E2E_OUT, then quit Zotero
 * when DEEPREAD_E2E_QUIT=1. No network endpoints are opened.
 */
/* global Zotero, Services, Components, ChromeUtils */

function install() {}
function uninstall() {}
function shutdown() {}

function startup() {
  // Do not block Zotero's sequential plugin startup: run the test in the background.
  runE2E().catch((e) => Zotero.logError(e));
}

async function runE2E() {
  const script = Services.env.get("DEEPREAD_E2E_SCRIPT");
  const out = Services.env.get("DEEPREAD_E2E_OUT");
  if (!script || !out) return;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const result = { startedAt: new Date().toISOString(), steps: [] };
  try {
    const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const scope = {
      Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils,
      console: { log: (...a) => Zotero.debug("[E2E] " + a.join(" ")), warn: (...a) => Zotero.debug("[E2E] " + a.join(" ")), error: (...a) => Zotero.debug("[E2E] " + a.join(" ")) },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      E2E: { result, env: (name) => Services.env.get(name) },
    };
    Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(script)).spec, scope);
    result.output = await scope.E2E.run();
    result.ok = true;
  }
  catch (e) {
    result.ok = false;
    result.error = String(e);
    result.stack = e && e.stack;
  }
  result.finishedAt = new Date().toISOString();
  await IOUtils.writeUTF8(out, JSON.stringify(result, null, 2));
  if (Services.env.get("DEEPREAD_E2E_QUIT") === "1") {
    Zotero.Utilities.Internal.quit();
  }
}
