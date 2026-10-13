/* Preference access. License: AGPL-3.0-or-later */
/* global DeepRead, Zotero */

DeepRead.prefs = {
  PREFIX: "deepread.",

  get(key) {
    return Zotero.Prefs.get(this.PREFIX + key);
  },

  set(key, value) {
    return Zotero.Prefs.set(this.PREFIX + key, value);
  },

  number(key, fallback) {
    const n = Number(this.get(key));
    return Number.isFinite(n) ? n : fallback;
  },

  llmConfig({ chat = false } = {}) {
    const model = chat ? (this.get("llm.chatModel") || this.get("llm.model")) : this.get("llm.model");
    let extraHeaders = {};
    const rawHeaders = String(this.get("llm.extraHeaders") || "").trim();
    if (rawHeaders) {
      try {
        extraHeaders = JSON.parse(rawHeaders);
      }
      catch (e) {
        DeepRead.log("ignoring invalid llm.extraHeaders JSON");
      }
    }
    return {
      baseURL: String(this.get("llm.baseURL") || "").trim().replace(/\/+$/, ""),
      apiKey: String(this.get("llm.apiKey") || "").trim(),
      model: String(model || "").trim(),
      jsonMode: this.get("llm.jsonMode") || "json_object",
      temperature: this.number("llm.temperature", 0.6),
      concurrency: Math.max(1, Math.min(64, this.number("llm.concurrency", 8))),
      extraHeaders,
    };
  },

  parserConfig() {
    return {
      provider: this.get("parser.provider") || "mineru",
      mineruToken: String(this.get("parser.mineruToken") || "").trim(),
      mineruModel: this.get("parser.mineruModel") || "pipeline",
      mineruLanguage: this.get("parser.mineruLanguage") || "en",
      mineruOCR: !!this.get("parser.mineruOCR"),
      mineruFormula: this.get("parser.mineruFormula") !== false,
      mineruTable: this.get("parser.mineruTable") !== false,
      selfHostURL: String(this.get("parser.selfHostURL") || "").trim().replace(/\/+$/, ""),
      selfHostToken: String(this.get("parser.selfHostToken") || "").trim(),
      selfHostBackend: this.get("parser.selfHostBackend") || "pipeline",
    };
  },

  language() {
    const lang = this.get("language") || "zh";
    return DeepRead.PARSE_LANGUAGES?.[lang] ? lang : "zh";
  },
};
