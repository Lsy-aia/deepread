/*
 * Skim: reading-depth layers (pure, no LLM calls). Ranks paragraphs into key / normal / minor tiers,
 * estimates reading time per depth and finds the next / previous key paragraph.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  // No role (explanations not generated yet) is neutral: only references / acknowledgements fade then.
  const ROLE_WEIGHT = { contribution: 3, result: 3, gap: 2.5, limitation: 2.5, method: 2, background: 1, prior: 1, "": 2 };
  const IMPORTANCE_BONUS = { 3: 1.5, 2: 0.75 };
  const KEY_MIN_SCORE = 3;
  const MINOR_MAX_SCORE = 1.75;
  const SHORT_WORDS = 25;
  const SHORT_CJK = 60;
  const WORDS_PER_MIN = 230;
  const CJK_PER_MIN = 450;

  const TEXT_TYPES = new Set(["text", "text_with_equation", "list"]);
  const REF_RE = /^(?:(?:\d+|[IVXivx]+)[.)]?\s*)?(?:references|bibliography|参考文献)\s*:?$/i;
  const ACK_RE = /^(?:(?:\d+|[IVXivx]+)[.)]?\s*)?(?:acknowledg(?:e)?ments?|致谢|致\s*谢)\s*:?$/i;
  const APPENDIX_RE = /^(?:(?:\d+|[A-Z])[.)]?\s*)?(?:appendix|appendices|supplementary|附录)\b/i;
  const WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g;
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;

  const keyOf = (p, page) => `p_${page.pageIndex}_${p.paragraphIndex}`;

  function count(text) {
    const s = String(text || "");
    return { words: (s.match(WORD_RE) || []).length, cjk: (s.match(CJK_RE) || []).length };
  }

  function level(pt) {
    const n = Number(pt && pt.importance_level);
    return n >= 1 && n <= 3 ? Math.floor(n) : 1;
  }

  function tiers(hierarchicalData, opts) {
    const roleOf = (opts && typeof opts.role === "function") ? opts.role : () => "";
    const tier = new Map();
    const keyPoints = new Set();
    let minorSection = null; // "refs" | "ack" | null
    for (const page of Array.isArray(hierarchicalData) ? hierarchicalData : []) {
      for (const p of (page && page.paragraphs) || []) {
        const type = p.paragraphType || "text";
        if (type === "title") {
          const t = String(p.paragraphText || "").replace(/\s+/g, " ").trim();
          if (REF_RE.test(t)) minorSection = "refs";
          else if (ACK_RE.test(t)) minorSection = "ack";
          else if (minorSection === "ack") minorSection = null;
          else if (minorSection === "refs" && APPENDIX_RE.test(t)) minorSection = null;
          continue;
        }
        if (!TEXT_TYPES.has(type)) continue;
        const key = keyOf(p, page);
        if (minorSection) { tier.set(key, "minor"); continue; }
        const role = String(roleOf(key) || "");
        const points = Array.isArray(p.points) ? p.points : [];
        const maxLevel = points.reduce((m, pt) => Math.max(m, level(pt)), 1);
        const base = Object.prototype.hasOwnProperty.call(ROLE_WEIGHT, role) ? ROLE_WEIGHT[role] : ROLE_WEIGHT[""];
        const score = base + (IMPORTANCE_BONUS[maxLevel] || 0);
        const c = count(p.paragraphText);
        const short = c.words < SHORT_WORDS && c.cjk < SHORT_CJK;
        let t = score >= KEY_MIN_SCORE ? "key" : score <= MINOR_MAX_SCORE ? "minor" : "normal";
        if (t === "key" && short) t = "normal";
        tier.set(key, t);
        if (t === "key" && points.length) {
          const strong = points.filter((pt) => level(pt) >= 2);
          for (const pt of strong.length ? strong : [points[0]]) {
            if (pt && pt.id != null) keyPoints.add(pt.id);
          }
        }
      }
    }
    return { tier, keyPoints };
  }

  function readingTime(paragraphs, opts) {
    const tier = (opts && opts.tier) || new Map();
    const mode = (opts && opts.mode) || "full";
    let words = 0, cjk = 0;
    const add = (text) => { const c = count(text); words += c.words; cjk += c.cjk; };
    for (const p of Array.isArray(paragraphs) ? paragraphs : []) {
      const type = p.paragraphType || "text";
      if (type === "title") { if (mode === "full") add(p.paragraphText); continue; }
      if (!TEXT_TYPES.has(type)) continue;
      const t = tier.get(keyOf(p, p)) || "normal";
      if (mode === "full") add(p.paragraphText);
      else if (mode === "key") {
        if (t === "key") add(p.paragraphText);
        else if (t === "normal") add(p.paragraphSummary);
      } else if (mode === "margin") {
        if (t === "key" || t === "normal") add(p.paragraphSummary);
      }
    }
    return Math.round((words / WORDS_PER_MIN + cjk / CJK_PER_MIN) * 60);
  }

  function pool(entries, tier) {
    const list = Array.isArray(entries) ? entries : [];
    return tier ? list.filter((e) => tier.get(e.key) === "key") : list;
  }
  const pos = (e) => (Number(e.pageIndex) || 0) * 1e6 + (Number(e.top) || 0);

  function nextKey(entries, from, tier) {
    const at = pos(from || {});
    let best = null;
    for (const e of pool(entries, tier)) if (pos(e) > at && (!best || pos(e) < pos(best))) best = e;
    return best;
  }

  function prevKey(entries, from, tier) {
    const at = pos(from || {});
    let best = null;
    for (const e of pool(entries, tier)) if (pos(e) < at && (!best || pos(e) > pos(best))) best = e;
    return best;
  }

  DeepRead.Skim = { tiers, readingTime, nextKey, prevKey };
})();
