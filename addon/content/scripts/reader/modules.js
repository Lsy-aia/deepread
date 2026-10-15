/*
 * Feature modules the reader can switch per paper (toolbar 「功能」 menu) or globally (settings).
 * Effective state = the paper's override (session.userState.modules[key]) if set, else the global pref.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

DeepRead.Modules = {
  LIST: [
    { key: "cards", pref: "view.marginCards", zh: "页边卡片", en: "Margin cards" },
    { key: "hoverTranslation", pref: "view.translationPopup", zh: "悬停翻译", en: "Hover translation", hintZh: "译文显示在段落下方", hintEn: "Shown below the paragraph" },
    { key: "highlights", pref: "view.highlights", zh: "要点高亮", en: "Key-point highlights", hintZh: "重要 / 关键要点在原文中着色", hintEn: "Colour important points in the PDF" },
    { key: "structureBar", pref: "view.structureBar", zh: "全文结构条", en: "Section bar", hintZh: "工具栏下的章节横条", hintEn: "Section strip under the toolbar" },
    { key: "figureCards", pref: "view.figureCards", zh: "图表卡片", en: "Figure cards", hintZh: "图表成卡，附读图步骤", hintEn: "Figures as cards with reading steps" },
  ],

  get(key) {
    return this.LIST.find((m) => m.key === key) || null;
  },

  /** Is the module on for this paper? */
  enabled(session, key) {
    const module = this.get(key);
    if (!module) return false;
    const override = session?.userState?.modules?.[key];
    if (typeof override === "boolean") return override;
    return DeepRead.prefs.get(module.pref) !== false;
  },

  /** Paper-level override (scope "paper") or new global default (scope "default", which drops the paper's override). */
  set(session, key, value, scope = "paper") {
    const module = this.get(key);
    if (!module) return;
    if (scope === "default") {
      DeepRead.prefs.set(module.pref, !!value);
      if (session?.userState?.modules) delete session.userState.modules[key];
    }
    else if (session) {
      session.userState.modules = { ...(session.userState.modules || {}), [key]: !!value };
    }
    session?._saveUserStateSoon?.();
    session?.applyModules?.();
  },

  count(session) {
    return { on: this.LIST.filter((m) => this.enabled(session, m.key)).length, total: this.LIST.length };
  },

  label(module) {
    return DeepRead.bilingual(module.zh, module.en);
  },

  hint(module) {
    return module.hintZh ? DeepRead.bilingual(module.hintZh, module.hintEn) : "";
  },
};
