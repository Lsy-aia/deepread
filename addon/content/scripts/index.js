/*
 * DeepRead for Zotero — runtime entry.
 * Every module attaches itself to the shared `DeepRead` namespace; files are
 * loaded in dependency order into the bootstrap-provided scope object.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Services */

(function () {
  const MODULES = [
    "util.js",
    "prefs.js",
    "l10n.js",
    "services/store.js",
    "services/llm.js",
    "services/parser.js",
    "pipeline/languages.js",
    "pipeline/responseFormats.js",
    "pipeline/summaryManager.js",
    "pipeline/pipeline.js",
    "reader/overlay.js",
    "reader/session.js",
    "reader/toolbar.js",
    "reader/selection.js",
    "panes/common.js",
    "panes/summaryPane.js",
    "panes/outlinePane.js",
    "panes/chatPane.js",
  ];

  for (const file of MODULES) {
    Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/scripts/${file}`, this);
  }

  const PLUGIN_ID = DeepRead.id;
  const windows = new Set();

  DeepRead.startup = async function () {
    DeepRead.log(`starting ${DeepRead.version}`);
    await DeepRead.Store.init();

    DeepRead.prefPaneID = await Zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID,
      src: `${DeepRead.rootURI}content/preferences.xhtml`,
      scripts: [`${DeepRead.rootURI}content/preferences.js`],
      stylesheets: [`${DeepRead.rootURI}content/styles/preferences.css`],
      label: "DeepRead",
      image: `${DeepRead.rootURI}content/icons/deepread.svg`,
    });

    DeepRead.Toolbar.register(PLUGIN_ID);
    DeepRead.Selection.register(PLUGIN_ID);
    DeepRead.Panes.registerAll(PLUGIN_ID);

    for (const win of Zotero.getMainWindows()) {
      DeepRead.onMainWindowLoad(win);
    }
  };

  DeepRead.onMainWindowLoad = function (win) {
    if (windows.has(win)) return;
    windows.add(win);
    win.MozXULElement.insertFTLIfNeeded("deepread.ftl");
    DeepRead.util.injectStylesheet(win.document, "chrome://deepread/content/styles/panes.css", "deepread-panes-css");
    DeepRead.util.injectStylesheet(win.document, "chrome://deepread/content/lib/katex/katex.min.css", "deepread-katex-css");
  };

  DeepRead.onMainWindowUnload = function (win) {
    windows.delete(win);
  };

  DeepRead.shutdown = async function () {
    DeepRead.log("shutting down");
    DeepRead.Session.destroyAll();
    for (const win of windows) {
      win.document.getElementById("deepread-panes-css")?.remove();
      win.document.getElementById("deepread-katex-css")?.remove();
      win.document.querySelector('link[href="deepread.ftl"]')?.remove();
    }
    windows.clear();
    await DeepRead.Store.close();
  };
}).call(this);
