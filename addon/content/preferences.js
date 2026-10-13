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
    var selfhost = provider === "selfhost";
    var m = $("deepread-pref-parser-mineru");
    var s = $("deepread-pref-parser-selfhost");
    if (m) m.hidden = selfhost;
    if (s) s.hidden = !selfhost;
  }

  function wireToggle(btnId, inputId) {
    var btn = $(btnId);
    var input = $(inputId);
    if (!btn || !input) return;
    btn.addEventListener("command", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("data-l10n-id", show ? "deepread-pref-hide" : "deepread-pref-show");
    });
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

    wireToggle("deepread-pref-llm-apikey-toggle", "deepread-pref-llm-apikey");
    wireToggle("deepread-pref-parser-mineru-token-toggle", "deepread-pref-parser-mineru-token");
    wireToggle("deepread-pref-parser-selfhost-token-toggle", "deepread-pref-parser-selfhost-token");

    var provider = $("deepread-pref-parser-provider");
    if (provider) {
      provider.addEventListener("command", updateProviderVisibility);
      provider.addEventListener("change", updateProviderVisibility);
    }
    updateProviderVisibility();
    // Menulist value is synced from the pref slightly after load.
    setTimeout(updateProviderVisibility, 0);
    setTimeout(updateProviderVisibility, 300);

    wireTest("deepread-pref-llm-test", "deepread-pref-llm-status", function () {
      return Zotero.DeepRead && Zotero.DeepRead.LLM;
    });
    wireTest("deepread-pref-parser-test", "deepread-pref-parser-status", function () {
      return Zotero.DeepRead && Zotero.DeepRead.Parser;
    });
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }
  // Pane fragments are inserted after window load; also try shortly after.
  setTimeout(init, 0);
})();
