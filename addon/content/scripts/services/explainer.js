/*
 * Explainer: per-paragraph "AI 讲解" (tutor-style explanation, not a translation) for the margin cards.
 * One LLM request per page batch; results are streamed to the UI page by page.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const MIN_CHARS = 40;
  const MAX_BATCH_CHARS = 6000;
  const MAX_PREV_CHARS = 1500;
  const MAX_CONTEXT_CHARS = 3000;
  const MAX_NEIGHBOR_CHARS = 1200;
  const ELIGIBLE_TYPES = new Set(["text", "text_with_equation"]);
  const MARKER = "Paragraphs to explain (JSON):";
  // A paragraph's role in the paper's argument (shown as the card's tinted header).
  const ROLES = ["background", "gap", "prior", "contribution", "method", "result", "limitation"];

  const SYSTEM_PROMPT = [
    "You are a patient tutor helping a reader understand an academic paper, one paragraph at a time.",
    "For every paragraph you are given, write a short explanation in your own words:",
    "- say in plain language what the paragraph states and what it means;",
    "- say why it matters, i.e. its role in the paper's argument;",
    "- clarify the key terms, symbols and formulas it uses.",
    "Connect it to earlier content of the paper when that helps.",
    "Rules: explain, do not translate. Do not repeat the given summary. Do not add facts the paper does not support.",
    "Each explanation is 2 to 5 sentences, with no preamble such as \"This paragraph says\". Markdown is allowed (use **bold** for key terms); write math as $...$.",
    "Also label each paragraph's role in the argument with exactly one of: background (context the work builds on), gap (what is missing or fails so far), prior (prior approaches being described), contribution (what this paper proposes or claims), method (how the approach works), result (experiments, evidence, findings), limitation (limits, failure cases, future work).",
    "Return only a JSON object, with each key copied exactly from the input.",
  ].join("\n");

  const TASK_PROMPT = [
    "Explain each of the paragraphs below for a reader who is new to the topic.",
    "Respond with JSON only, in exactly this shape:",
    "{\"explanations\":[{\"key\":\"<key of the paragraph>\",\"role\":\"<one role>\",\"explanation\":\"<your explanation>\"}]}",
    "Include one entry for every item, and keep the keys exactly as given.",
  ].join("\n");

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
    return `${SYSTEM_PROMPT}\nWrite all explanations in ${languageInstruction(targetLang)}.`;
  }

  function key(pageIndex, paragraphIndex) {
    return `p_${pageIndex}_${paragraphIndex}`;
  }

  function eligible(paragraph) {
    if (!paragraph || !ELIGIBLE_TYPES.has(paragraph.paragraphType)) return false;
    return str(paragraph.paragraphText).length >= MIN_CHARS;
  }

  function pageBatches(hierarchicalData, opts = {}) {
    const only = opts.only || null;
    const batches = [];
    for (const page of hierarchicalData || []) {
      let items = [];
      let size = 0;
      const flush = () => {
        if (items.length) batches.push({ pageIndex: page.pageIndex, items });
        items = [];
        size = 0;
      };
      for (const p of page.paragraphs || []) {
        if (!eligible(p)) continue;
        const k = key(page.pageIndex, p.paragraphIndex);
        if (only && !only.has(k)) continue;
        const text = str(p.paragraphText);
        if (items.length && size + text.length > MAX_BATCH_CHARS) flush();
        items.push({ key: k, text, summary: str(p.paragraphSummary) });
        size += text.length;
      }
      flush();
    }
    return batches;
  }

  /** Lenient parse of a model reply into a Map(key -> text), restricted to `expected` keys. */
  function parseReply(content, expected) {
    let s = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    let value = null;
    try {
      value = JSON.parse(s);
    }
    catch (e) {
      for (const [open, close] of [["{", "}"], ["[", "]"]]) {
        const a = s.indexOf(open);
        const b = s.lastIndexOf(close);
        if (a < 0 || b <= a) continue;
        try {
          value = JSON.parse(s.slice(a, b + 1));
          break;
        }
        catch (e2) { /* try next shape */ }
      }
    }
    const out = new Map();
    out.roles = new Map(); // key -> role, when the model gave a known one
    if (!value || typeof value !== "object") return out;
    const add = (k, t, role) => {
      const kk = str(k);
      const tt = str(t);
      if (kk && tt && (!expected || expected.has(kk))) {
        out.set(kk, tt);
        const rr = str(role).toLowerCase();
        if (ROLES.includes(rr)) out.roles.set(kk, rr);
      }
    };
    let list = null;
    if (Array.isArray(value)) list = value;
    else if (Array.isArray(value.explanations)) list = value.explanations;
    if (list) {
      for (const it of list) {
        if (it && typeof it === "object") add(it.key, it.explanation ?? it.text ?? it.explain, it.role);
      }
    }
    else {
      const map = value.explanations && typeof value.explanations === "object" ? value.explanations : value;
      for (const [k, t] of Object.entries(map)) {
        if (typeof t === "string") add(k, t);
        else if (t && typeof t === "object") add(k, t.explanation ?? t.text, t.role);
      }
    }
    return out;
  }

  function buildUserMessage(items, { paperContext, previous, neighbors }) {
    const parts = [];
    if (str(paperContext)) parts.push(`Paper context:\n${str(paperContext).slice(0, MAX_CONTEXT_CHARS)}`);
    if (str(previous)) parts.push(`Summaries of the previous page (for connecting to earlier content):\n${str(previous)}`);
    if (neighbors && neighbors.length) {
      parts.push(`Preceding paragraphs:\n${neighbors.map((t) => String(t).slice(0, MAX_NEIGHBOR_CHARS)).join("\n\n")}`);
    }
    parts.push(TASK_PROMPT);
    parts.push(`${MARKER}\n${JSON.stringify({ items })}`);
    return parts.join("\n\n");
  }

  function previousPageSummaries(hierarchicalData, pageIndex) {
    const pages = hierarchicalData || [];
    const at = pages.findIndex((p) => p.pageIndex === pageIndex);
    const prev = at > 0 ? pages[at - 1] : null;
    if (!prev) return "";
    const lines = [];
    let total = 0;
    for (const p of prev.paragraphs || []) {
      const line = str(p.paragraphSummary).replace(/\s+/g, " ");
      if (!line) continue;
      if (total + line.length > MAX_PREV_CHARS) break;
      lines.push(`- ${line}`);
      total += line.length + 3;
    }
    return lines.join("\n");
  }

  async function request(items, ctx, opts) {
    const res = await DeepRead.LLM.complete({
      system: systemPrompt(opts.targetLang),
      messages: [{ role: "user", content: buildUserMessage(items, ctx) }],
      responseFormat: { type: "json_object" },
      temperature: 0.4,
      signal: opts.signal,
      config: opts.config,
    });
    return parseReply(res && res.content, new Set(items.map((i) => i.key)));
  }

  /** One request, retried once on a (non-abort) failure. */
  async function requestWithRetry(items, ctx, opts) {
    throwIfAborted(opts.signal);
    try {
      return await request(items, ctx, opts);
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      DeepRead.log?.("explainer request failed, retrying:", e?.message || e);
    }
    throwIfAborted(opts.signal);
    try {
      return await request(items, ctx, opts);
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      throw e;
    }
  }

  /** → Map(key → text); `.roles` is a Map(key → role). onPage(pageIndex, Map(key → text), Map(key → role)). */
  async function explainPages(hierarchicalData, opts = {}) {
    const results = new Map();
    results.roles = new Map();
    const batches = pageBatches(hierarchicalData, { only: opts.only });
    const total = batches.length;
    const cfgConcurrency = Number(DeepRead.prefs?.llmConfig?.()?.concurrency) || 4;
    const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || Math.min(4, cfgConcurrency), total || 1));
    let done = 0;
    let next = 0;
    const progress = (extra) => {
      if (typeof opts.onProgress === "function") opts.onProgress({ done, total, ...extra });
    };

    async function runBatch(batch) {
      const ctx = {
        paperContext: opts.paperContext,
        previous: previousPageSummaries(hierarchicalData, batch.pageIndex),
      };
      const got = new Map();
      got.roles = new Map();
      const take = (reply) => {
        for (const [k, t] of reply) got.set(k, t);
        for (const [k, r] of reply.roles || []) got.roles.set(k, r);
      };
      let error = null;
      try {
        take(await requestWithRetry(batch.items, ctx, opts));
        const missing = batch.items.filter((i) => !got.has(i.key));
        if (missing.length) {
          try {
            take(await request(missing, ctx, opts));
          }
          catch (e) {
            if (isAbort(e, opts.signal)) throw abortError();
            error = e;
          }
        }
      }
      catch (e) {
        if (isAbort(e, opts.signal)) throw abortError();
        error = e;
      }
      for (const [k, t] of got) results.set(k, t);
      for (const [k, r] of got.roles) results.roles.set(k, r);
      if (got.size && typeof opts.onPage === "function") opts.onPage(batch.pageIndex, got, got.roles);
      done++;
      progress(error ? { pageIndex: batch.pageIndex, error } : {});
    }

    async function worker() {
      while (next < batches.length) {
        throwIfAborted(opts.signal);
        await runBatch(batches[next++]);
      }
    }

    throwIfAborted(opts.signal);
    progress();
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
    return results;
  }

  async function explainOne(paragraph, opts = {}) {
    const k = key(opts.pageIndex, paragraph.paragraphIndex);
    const items = [{ key: k, text: str(paragraph.paragraphText), summary: str(paragraph.paragraphSummary) }];
    const neighbors = (opts.neighbors || []).slice(-2).map(str).filter(Boolean);
    const ctx = { paperContext: opts.paperContext, neighbors };
    const got = await requestWithRetry(items, ctx, opts);
    const text = got.get(k);
    if (!text) throw new Error("The model returned no explanation");
    if (opts.withRole) return { text, role: got.roles?.get(k) || "" };
    return text;
  }

  DeepRead.Explainer = {
    SYSTEM_PROMPT,
    TASK_PROMPT,
    ROLES,
    key,
    eligible,
    pageBatches,
    explainPages,
    explainOne,
    _parseReply: parseReply,
  };
})();
