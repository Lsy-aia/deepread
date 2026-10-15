/*
 * Glossary: notation and technical terms of a paper (LLM-built), plus matching helpers for
 * "hover lookup" over text extracted from the PDF.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const MARKER = "Paper blocks for the glossary (JSON):";
  const DEFAULT_MAX_CHARS = 60000;
  const MAX_TEXT = 600;
  const MAX_CONTEXT_CHARS = 3000;
  const MAX_ENTRIES = 30;
  const MAX_FORMS = 12;
  const AFTER_SYMBOL = "(),.;:"; // characters that may follow a symbol inside a text-layer token
  const SEP_CLASS = "[\\s\\-\\u2010\\u2011\\u2012\\u2013\\u2014]+";
  // Single letters that are ordinary English words; never treated as symbols when hovering.
  const STOP_TOKENS = new Set(["a", "A", "I"]);

  const SYSTEM_PROMPT = [
    "You build a glossary for a reader who is new to an academic paper.",
    "You are given the paper as a list of blocks (one per paragraph): key, label (page and paragraph), role, summary and explanation; text is given only for blocks that have no summary or explanation.",
    "List the mathematical symbols and the technical terms a newcomer needs, using only what the blocks support. Do not invent definitions.",
    "Return only a JSON object.",
  ].join("\n");

  const TASK_PROMPT = [
    "Build the glossary of this paper. Respond with JSON only, in exactly this shape:",
    "{\"symbols\":[{\"symbol\":\"<LaTeX>\",\"forms\":[\"<plain rendering>\"],\"meaning\":\"<meaning>\",\"key\":\"<block key>\"}],",
    "\"terms\":[{\"term\":\"<term>\",\"aliases\":[\"<abbreviation or variant>\"],\"definition\":\"<definition>\",\"key\":\"<block key>\"}]}",
    "Rules:",
    `- symbols: at most ${MAX_ENTRIES}, the notation that matters for understanding the paper. symbol is LaTeX without $, e.g. \\\\epsilon_\\\\theta.`,
    "- forms: how the symbol looks in text extracted from a PDF, with subscripts flattened, e.g. \"εθ\", \"ε_θ\", \"epsilon_theta\".",
    "- meaning: 1 to 2 sentences.",
    `- terms: at most ${MAX_ENTRIES} technical terms, abbreviations and named methods. term is written as in the paper (usually English); aliases are abbreviations and variants such as \"DDPM\".`,
    "- definition: 1 to 2 sentences, explained for a newcomer.",
    "- key: the key of the block where the symbol or term is defined or first used, copied exactly as given.",
  ].join("\n");

  const GREEK_NAMES = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
    vartheta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "π", rho: "ρ",
    varrho: "ρ", sigma: "σ", varsigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  };
  const FOLD = { "ϵ": "ε", "ϑ": "θ", "ϕ": "φ", "ϱ": "ρ", "ϖ": "π", "ς": "σ" };

  const str = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());

  function abortError() {
    const e = new Error("Aborted");
    e.name = "AbortError";
    return e;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function isAbort(e, signal) {
    return (e && e.name === "AbortError") || !!(signal && signal.aborted);
  }

  function languageInstruction(targetLang) {
    const langs = DeepRead.PARSE_LANGUAGES || {};
    const lang = langs[targetLang] || langs.zh;
    return lang?.instruction || "Simplified Chinese";
  }

  function systemPrompt(targetLang) {
    return `${SYSTEM_PROMPT}\nWrite all meanings and definitions in ${languageInstruction(targetLang)}.`;
  }

  /** Blocks that fit the budget: full metadata for each, `text` (clipped) only when there is no summary/explanation. */
  function budgetBlocks(blocks, maxChars) {
    const limit = Number(maxChars) > 0 ? Number(maxChars) : DEFAULT_MAX_CHARS;
    const out = [];
    let used = 0;
    for (const b of blocks || []) {
      const key = str(b && b.key);
      if (!key) continue;
      const item = { key, label: str(b.label), role: str(b.role), summary: str(b.summary), explanation: str(b.explanation) };
      if (!item.summary && !item.explanation) item.text = str(b.text).slice(0, MAX_TEXT);
      const size = JSON.stringify(item).length + 1;
      if (used + size > limit) break;
      used += size;
      out.push(item);
    }
    return out;
  }

  function parseJson(content) {
    let s = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      return JSON.parse(s);
    }
    catch (e) {
      const a = s.indexOf("{");
      const b = s.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(s.slice(a, b + 1));
        }
        catch (e2) { /* give up */ }
      }
    }
    return null;
  }

  function strList(raw) {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    return [...new Set(list.map(str).filter(Boolean))];
  }

  /** Reply → { symbols, terms } with ids s1.., t1..; entries without a name or a description are dropped. */
  function parse(content, blocks) {
    const valid = new Set((blocks || []).map((b) => str(b && b.key)).filter(Boolean));
    const value = parseJson(content);
    const obj = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const keyOf = (k) => (valid.has(str(k)) ? str(k) : "");
    const symbols = [];
    for (const it of Array.isArray(obj.symbols) ? obj.symbols : []) {
      if (!it || typeof it !== "object") continue;
      const symbol = str(it.symbol);
      const meaning = str(it.meaning);
      if (!symbol || !meaning) continue;
      const forms = strList(it.forms).filter((f) => f !== symbol).slice(0, MAX_FORMS);
      symbols.push({ symbol, forms, meaning, key: keyOf(it.key) });
      if (symbols.length >= MAX_ENTRIES) break;
    }
    const terms = [];
    for (const it of Array.isArray(obj.terms) ? obj.terms : []) {
      if (!it || typeof it !== "object") continue;
      const term = str(it.term);
      const definition = str(it.definition);
      if (!term || !definition) continue;
      const aliases = strList(it.aliases).filter((a) => a.toLowerCase() !== term.toLowerCase()).slice(0, MAX_FORMS);
      terms.push({ term, aliases, definition, key: keyOf(it.key) });
      if (terms.length >= MAX_ENTRIES) break;
    }
    symbols.forEach((s, i) => { s.id = `s${i + 1}`; });
    terms.forEach((t, i) => { t.id = `t${i + 1}`; });
    return {
      symbols: symbols.map(({ id, symbol, forms, meaning, key }) => ({ id, symbol, forms, meaning, key })),
      terms: terms.map(({ id, term, aliases, definition, key }) => ({ id, term, aliases, definition, key })),
    };
  }

  async function request(user, blocks, opts) {
    const res = await DeepRead.LLM.complete({
      system: systemPrompt(opts.targetLang),
      messages: [{ role: "user", content: user }],
      responseFormat: { type: "json_object" },
      temperature: 0.2,
      signal: opts.signal,
      config: opts.config,
    });
    return parse(res && res.content, blocks);
  }

  /** → { symbols: [{ id, symbol, forms, meaning, key }], terms: [{ id, term, aliases, definition, key }] }; one retry. */
  async function build(opts = {}) {
    const blocks = opts.blocks || [];
    const items = budgetBlocks(blocks, opts.maxChars);
    const parts = [];
    if (str(opts.paperContext)) parts.push(`Paper context:\n${str(opts.paperContext).slice(0, MAX_CONTEXT_CHARS)}`);
    parts.push(TASK_PROMPT, `${MARKER}\n${JSON.stringify({ blocks: items })}`);
    const user = parts.join("\n\n");
    throwIfAborted(opts.signal);
    try {
      return await request(user, blocks, opts);
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      DeepRead.log?.("glossary request failed, retrying:", e?.message || e);
    }
    throwIfAborted(opts.signal);
    try {
      return await request(user, blocks, opts);
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      throw e;
    }
  }

  /** NFKC, LaTeX Greek commands and Greek variants folded to one letter, spaces and _ ^ { } \ removed. */
  function normalize(s) {
    return String(s || "")
      .normalize("NFKC")
      .replace(/\\([A-Za-z]+)/g, (m, name) => GREEK_NAMES[name] || name)
      .replace(/[ϵϑϕϱϖς]/g, (c) => FOLD[c])
      .replace(/[\s_^{}\\]/g, "");
  }

  const isSingleLatin = (s) => /^[A-Za-z]$/.test(s);

  /** → the symbol entry whose form is the token, or starts the token followed by ( , ) . ; : — longest form wins; else null. */
  function matchSymbol(token, glossary) {
    const raw = String(token || "").trim();
    if (STOP_TOKENS.has(raw)) return null;
    const t = normalize(raw);
    if (!t || /^[a-z]{3,}$/.test(raw)) return null; // ordinary lowercase word
    const bare = t.replace(/[,.;:]+$/, "");
    let best = null;
    let bestLen = 0;
    for (const entry of (glossary && glossary.symbols) || []) {
      for (const form of [entry.symbol, ...(entry.forms || [])]) {
        const f = normalize(form);
        if (!f || f.length <= bestLen) continue;
        let ok = t === f || bare === f;
        if (!ok && !isSingleLatin(f) && t.startsWith(f) && AFTER_SYMBOL.includes(t[f.length])) ok = true;
        if (ok) {
          best = entry;
          bestLen = f.length;
        }
      }
    }
    return best;
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  const termIndexes = new WeakMap();

  function nameRegex(name) {
    const words = String(name).split(/[\s\-‐-—]+/).filter(Boolean);
    if (!words.length || words.join("").length < 2) return null;
    const abbreviation = /[A-Z]/.test(name) && !/[a-z]/.test(name); // "DDPM" must not match "ddpm"
    const body = words.map(escapeRe).join(SEP_CLASS);
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}s?(?![\\p{L}\\p{N}])`, abbreviation ? "gu" : "giu");
  }

  function termIndex(glossary) {
    let idx = glossary && typeof glossary === "object" ? termIndexes.get(glossary) : null;
    if (idx) return idx;
    idx = [];
    for (const entry of (glossary && glossary.terms) || []) {
      for (const name of [entry.term, ...(entry.aliases || [])]) {
        const re = nameRegex(str(name));
        if (re) idx.push({ entry, re });
      }
    }
    if (glossary && typeof glossary === "object") termIndexes.set(glossary, idx);
    return idx;
  }

  /** → { entry, start, end } for the longest term/alias match covering `offset` in `text`, else null. */
  function termAt(text, offset, glossary) {
    const s = String(text || "");
    let best = null;
    for (const { entry, re } of termIndex(glossary)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > offset) break;
        if (offset < end && (!best || end - start > best.end - best.start)) best = { entry, start, end };
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return best;
  }

  function textHasSymbol(normText, form) {
    const f = normalize(form);
    if (!f || STOP_TOKENS.has(f)) return false;
    const re = /^[A-Za-z0-9]+$/.test(f)
      ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(f)}(?![A-Za-z0-9])`)
      : new RegExp(escapeRe(f));
    return re.test(normText);
  }

  /** → keys of the blocks whose text contains the entry (symbol forms, or term and aliases as whole words). */
  function occurrences(entry, blocks) {
    const out = [];
    if (!entry) return out;
    const isSymbol = typeof entry.symbol === "string";
    const forms = isSymbol ? [entry.symbol, ...(entry.forms || [])] : null;
    const res = isSymbol ? null : [entry.term, ...(entry.aliases || [])].map((n) => nameRegex(str(n))).filter(Boolean);
    for (const b of blocks || []) {
      const text = String(b && b.text || "");
      if (!text) continue;
      let hit;
      if (isSymbol) {
        const norm = text.normalize("NFKC").replace(/[ϵϑϕϱϖς]/g, (c) => FOLD[c]).replace(/[_^{}\\]/g, "");
        hit = forms.some((f) => textHasSymbol(norm, f));
      }
      else hit = res.some((re) => { re.lastIndex = 0; return re.test(text); });
      if (hit) out.push(b.key);
    }
    return out;
  }

  DeepRead.Glossary = {
    SYSTEM_PROMPT,
    build,
    matchSymbol,
    termAt,
    occurrences,
    _parse: parse,
    _normalize: normalize,
  };
})();
