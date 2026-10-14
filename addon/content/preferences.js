/*
 * DeepRead preferences pane script (runs in the preferences window scope).
 * License: AGPL-3.0-or-later
 */
(function () {
  var PREFIX = "extensions.zotero.deepread.";
  var PRESETS = {
    deepseek: ["https://api.deepseek.com/v1", "deepseek-chat"],
    dashscope: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
    zhipu: ["https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"],
    ark: ["https://ark.cn-beijing.volces.com/api/v3", ""],
    siliconflow: ["https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"],
    openrouter: ["https://openrouter.ai/api/v1", "deepseek/deepseek-chat"],
    openai: ["https://api.openai.com/v1", "gpt-4o-mini"],
    ollama: ["http://127.0.0.1:11434/v1", "qwen2.5:7b"],
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setField(id, prefKey, value) {
    var el = $(id);
    if (el) {
      el.value = value;
    }
    try {
      Zotero.Prefs.set(PREFIX + prefKey, value, true);
    } catch (e) {
      Zotero.debug("[DeepRead] pref set failed: " + e);
    }
  }

  function guessPreset() {
    var url = "";
    try {
      url = String(Zotero.Prefs.get(PREFIX + "llm.baseURL", true) || "").replace(/\/+$/, "");
    } catch (e) {}
    for (var k in PRESETS) {
      if (PRESETS[k][0] === url) return k;
    }
    return "custom";
  }

  function updateProviderVisibility() {
    var menu = $("deepread-pref-parser-provider");
    var provider = menu && menu.value;
    if (!provider) {
      try {
        provider = Zotero.Prefs.get(PREFIX + "parser.provider", true);
      } catch (e) {}
    }
    var known = ["builtin", "grobid", "mineru", "selfhost"];
    if (known.indexOf(provider) < 0) provider = "builtin";
    var blocks = {
      builtin: "deepread-pref-parser-builtin",
      grobid: "deepread-pref-parser-grobid",
      mineru: "deepread-pref-parser-mineru",
      selfhost: "deepread-pref-parser-selfhost",
    };
    for (var k in blocks) {
      var el = $(blocks[k]);
      if (el) el.hidden = k !== provider;
    }
  }

  function wireTest(btnId, statusId, getTarget) {
    var btn = $(btnId);
    var status = $(statusId);
    if (!btn || !status) return;
    btn.addEventListener("command", async function () {
      var target = getTarget();
      var setStatus = function (cls, text) {
        status.className = "deepread-pref-status" + (cls ? " " + cls : "");
        status.setAttribute("value", text);
        status.value = text;
      };
      if (!target || typeof target.testConnection !== "function") {
        setStatus("error", "DeepRead is not loaded");
        return;
      }
      btn.disabled = true;
      setStatus("", "…");
      try {
        // Make sure typed-but-unblurred values are committed to prefs.
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
        var res = await target.testConnection();
        setStatus(res && res.ok ? "ok" : "error", (res && res.message) || "");
      } catch (e) {
        setStatus("error", String((e && e.message) || e));
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireUpdate() {
    var versionLabel = $("deepread-pref-update-version");
    var button = $("deepread-pref-update-check");
    var status = $("deepread-pref-update-status");
    var releases = $("deepread-pref-update-releases");
    var deepread = Zotero.DeepRead;
    if (versionLabel) versionLabel.value = deepread ? deepread.version : "?";
    if (releases) {
      releases.addEventListener("click", function (event) {
        event.preventDefault();
        Zotero.launchURL((deepread && deepread.Updater && deepread.Updater.RELEASES_URL) || "https://github.com/Lsy-aia/deepread/releases");
      });
    }
    if (!button || !status) return;
    button.addEventListener("command", async function () {
      var updater = Zotero.DeepRead && Zotero.DeepRead.Updater;
      if (!updater) {
        status.value = "DeepRead is not loaded";
        status.className = "deepread-pref-status error";
        return;
      }
      button.disabled = true;
      try {
        await updater.checkAndInstall(function (state, text) {
          status.value = text;
          status.setAttribute("value", text);
          status.className = "deepread-pref-status" + (state === "ok" ? " ok" : state === "error" ? " error" : "");
        });
      }
      finally {
        button.disabled = false;
      }
    });
  }

  function wireSlider(id, valueId, prefKey, min, max, unit) {
    var input = $(id);
    var label = $(valueId);
    if (!input) return;
    var clamp = function (v) {
      v = Math.round(Number(v));
      if (!isFinite(v)) v = min;
      return Math.min(max, Math.max(min, v));
    };
    var show = function (v) {
      if (label) {
        label.value = v + " " + unit;
        label.setAttribute("value", v + " " + unit);
      }
    };
    var current = min;
    try {
      current = clamp(Zotero.Prefs.get(PREFIX + prefKey, true));
    } catch (e) {}
    input.value = String(current);
    show(current);
    var onInput = function () {
      var v = clamp(input.value);
      show(v);
      try {
        Zotero.Prefs.set(PREFIX + prefKey, v, true);
      } catch (e) {
        Zotero.debug("[DeepRead] pref set failed: " + e);
      }
    };
    input.addEventListener("input", onInput);
    input.addEventListener("change", onInput);
  }

  function init() {
    var root = $("deepread-pref-root");
    if (!root || root.dataset.deepreadInit === "1") return;
    root.dataset.deepreadInit = "1";

    var preset = $("deepread-pref-llm-preset");
    if (preset) {
      preset.value = guessPreset();
      preset.addEventListener("command", function () {
        var p = PRESETS[preset.value];
        if (!p) return; // custom: leave fields alone
        setField("deepread-pref-llm-baseurl", "llm.baseURL", p[0]);
        setField("deepread-pref-llm-model", "llm.model", p[1]);
      });
    }


    var provider = $("deepread-pref-parser-provider");
    if (provider) {
      provider.addEventListener("command", updateProviderVisibility);
      provider.addEventListener("change", updateProviderVisibility);
    }
    updateProviderVisibility();
    // Menulist value is synced from the pref slightly after load.
    setTimeout(updateProviderVisibility, 0);
    setTimeout(updateProviderVisibility, 300);

    wireUpdate();
    wireSlider("deepread-pref-card-width", "deepread-pref-card-width-value", "view.railWidth", 200, 520, "px");
    wireSlider("deepread-pref-card-fontsize", "deepread-pref-card-fontsize-value", "view.cardFontSize", 10, 18, "px");

    wireTest("deepread-pref-llm-test", "deepread-pref-llm-status", function () {
      return Zotero.DeepRead && Zotero.DeepRead.LLM;
    });
    wireTest("deepread-pref-parser-test", "deepread-pref-parser-status", function () {
      return Zotero.DeepRead && Zotero.DeepRead.Parser;
    });
  }

  // Zotero loads this script before inserting the pane fragment, then dispatches a
  // (non-bubbling) "load" event on the pane root: catch it in the capture phase.
  document.addEventListener("load", function (event) {
    if (event.target && event.target.id === "deepread-pref-root") init();
  }, true);
  // Fallback: poll briefly in case the event was missed.
  var tries = 0;
  (function poll() {
    if ($("deepread-pref-root")) {
      init();
      return;
    }
    if (++tries < 50) setTimeout(poll, 100);
  })();
})();
