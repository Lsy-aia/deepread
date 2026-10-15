/*
 * Figures: figure/table index from the MinerU content list, in-text mentions, and
 * LLM-written "how to read this figure" guides.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const MARKER = "Figures to explain (JSON):";
  const BATCH = 6;
  const CONCURRENCY = 3;
  const MAX_CAPTION = 700;
  const MAX_MENTIONS = 4;
  const NEAR = 80; // per-mille

  const NUM = "(?:\\d+|[IVX]+|[A-Z]\\d+)";
  const CAPTION_RE = new RegExp(
    `^\\s*(fig(?:ure)?s?|table|tab)\\b\\.?\\s*(${NUM})(?![A-Za-z])\\s*[:.|\\-\\u2013\\u2014)]?\\s*([\\s\\S]*)$`, "i"
  );
  // A body sentence may start with "Figure 3 shows ..."; only a separator marks a caption block.
  const CAPTION_STRICT_RE = new RegExp(`^\\s*(?:fig(?:ure)?s?|table|tab)\\b\\.?\\s*${NUM}(?![A-Za-z])\\s*(?:[:|\\u2013\\u2014]|\\.(?:\\s|$)|$)`, "i");
  const MENTION_RE = new RegExp(
    `(?<![A-Za-z])(Figs?|Figures?|Tables?|Tab)\\b\\.?\\s*(${NUM})(?![A-Za-z]{2})(?:\\s*\\(([a-z])\\)|([a-z])(?![A-Za-z]))?`, "gi"
  );
  const MORE_RE = /^\s*(?:,|and|&|or|-|–|to)\s*(\d+)(?:\s*\(([a-z])\)|([a-z])(?![A-Za-z]))?/i;

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

  function kindOf(word) {
    return /^fig/i.test(word) ? "figure" : "table";
  }
  function normNumber(n) {
    return /^[ivx]+$/i.test(n) && !/^\d/.test(n) ? n.toUpperCase() : n;
  }
  function keyOf(kind, number) {
    return `${kind === "figure" ? "fig" : "tab"}:${number}`;
  }

  function joinCaption(v) {
    if (Array.isArray(v)) return v.map(str).filter(Boolean).join(" ");
    return str(v);
  }

  function parseCaption(caption) {
    const m = CAPTION_RE.exec(caption);
    if (!m) return null;
    return { kind: kindOf(m[1]), number: normNumber(m[2]), rest: m[3] || "" };
  }

  function shortTitle(rest) {
    let t = str(rest).replace(/\s+/g, " ");
    const m = /^(.+?[.;。；:])(?:\s|$)/.exec(t);
    if (m && m[1].length >= 6) t = m[1].replace(/[.;。；:]$/, "");
    if (t.length > 40) t = `${t.slice(0, 39).trimEnd()}…`;
    return t;
  }

  function list(contentList) {
    const items = Array.isArray(contentList) ? contentList : [];
    const out = [];
    const used = new Set();
    const seen = new Map();
    const push = (it, caption, textIdx) => {
      const p = parseCaption(caption);
      if (!p) return;
      const prefix = p.kind === "figure" ? "fig" : "tab";
      let id = `${prefix}_${p.number}`;
      const n = (seen.get(id) || 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}_${n}`;
      out.push({
        id,
        kind: p.kind,
        label: `${p.kind === "figure" ? "图" : "表"} ${p.number}`,
        number: p.number,
        pageIndex: it.page_idx || 0,
        bbox: Array.isArray(it.bbox) ? it.bbox.slice() : null,
        caption,
        title: shortTitle(p.rest),
        blockId: textIdx,
      });
    };
    items.forEach((it, idx) => {
      if (!it || (it.type !== "image" && it.type !== "table")) return;
      const caption = joinCaption(it.type === "table" ? (it.table_caption?.length ? it.table_caption : it.image_caption) : it.image_caption);
      if (caption) {
        push(it, caption, undefined);
        return;
      }
      // Caption stored as a separate text block right above/below.
      if (!Array.isArray(it.bbox)) return;
      let best = null;
      let bestGap = Infinity;
      items.forEach((tx, j) => {
        if (!tx || used.has(j) || tx.type === "image" || tx.type === "table" || tx.page_idx !== it.page_idx) return;
        if (typeof tx.text !== "string" || !Array.isArray(tx.bbox) || !CAPTION_RE.test(tx.text)) return;
        const below = tx.bbox[1] - it.bbox[3];
        const above = it.bbox[1] - tx.bbox[3];
        const gap = below >= -20 ? below : above >= -20 ? above : Infinity;
        if (gap <= NEAR && gap < bestGap) {
          best = j;
          bestGap = gap;
        }
      });
      if (best !== null) {
        used.add(best);
        push(it, str(items[best].text), best);
      }
    });
    for (const f of out) delete f.blockId;
    return out;
  }

  function excerptAround(text, start, end) {
    const half = 80;
    let a = Math.max(0, start - half);
    let b = Math.min(text.length, end + half);
    let s = text.slice(a, b).replace(/\s+/g, " ").trim();
    if (a > 0) s = `…${s}`;
    if (b < text.length) s = `${s}…`;
    return s;
  }

  function mentions(figures, contentList) {
    const result = new Map();
    const byKey = new Map();
    for (const f of figures || []) {
      result.set(f.id, []);
      const k = keyOf(f.kind, f.number);
      if (!byKey.has(k)) byKey.set(k, f);
    }
    const items = Array.isArray(contentList) ? contentList : [];
    items.forEach((it, idx) => {
      if (!it || typeof it.text !== "string") return;
      if (it.type !== "text" && it.type !== "list" && it.type !== "text_with_equation" && it.type) return;
      if (it.text_level === 1) return;
      const text = it.text;
      if (CAPTION_STRICT_RE.test(text)) return;
      const seenInBlock = new Set();
      const add = (kind, number, panel, mStart, mEnd) => {
        const f = byKey.get(keyOf(kind, normNumber(number)));
        if (!f) return;
        const dk = `${f.id}|${panel || ""}`;
        if (seenInBlock.has(dk)) return;
        seenInBlock.add(dk);
        result.get(f.id).push({
          pageIndex: it.page_idx || 0,
          blockId: idx,
          panel: panel ? panel.toLowerCase() : null,
          excerpt: excerptAround(text, mStart, mEnd),
        });
      };
      MENTION_RE.lastIndex = 0;
      let m;
      while ((m = MENTION_RE.exec(text))) {
        const kind = kindOf(m[1]);
        let end = m.index + m[0].length;
        add(kind, m[2], m[3] || m[4] || null, m.index, end);
        // "Figs. 3 and 4", "Figures 3, 4(b)"
        let rest = text.slice(end);
        let mm;
        while ((mm = MORE_RE.exec(rest))) {
          const e2 = end + mm[0].length;
          add(kind, mm[1], mm[2] || mm[3] || null, m.index, e2);
          end = e2;
          rest = text.slice(end);
        }
        MENTION_RE.lastIndex = end;
      }
    });
    return result;
  }

  // ---- explain ----

  function languageInstruction(targetLang) {
    const langs = DeepRead.PARSE_LANGUAGES || {};
    const lang = langs[targetLang] || langs.zh;
    return lang?.instruction || "Simplified Chinese";
  }

  const SYSTEM_PROMPT = [
    "You write short \"how to read this figure\" guides for readers of an academic paper.",
    "For each figure or table you are given its caption and excerpts of the paper text that mention it.",
    "For a figure: say what to look at first, what the axes / panels / colors / arrows show, and what to take away.",
    "For a table: say which rows and columns to compare, and what the highlighted (e.g. bold) result means.",
    "Give 2 to 4 short steps per item. Use only the caption and the excerpts; do not invent numbers or facts.",
    "If a step is about one panel of a multi-panel figure, set \"panel\" to its letter (e.g. \"b\"), otherwise null.",
    "Markdown is allowed (**bold** for key terms); write math as $...$. Return only a JSON object.",
  ].join("\n");

  const TASK_PROMPT = [
    "Write a reading guide for each figure or table below.",
    "Respond with JSON only, in exactly this shape:",
    "{\"figures\":[{\"id\":\"<id>\",\"title\":\"<short title>\",\"steps\":[{\"text\":\"<step>\",\"panel\":\"b\" or null}]}]}",
    "Include one entry for every item, with ids copied exactly.",
  ].join("\n");

  function clip(s, n) {
    s = str(s).replace(/\s+/g, " ");
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  function stripJson(content) {
    let s = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    return s;
  }

  function parseReply(content) {
    const s = stripJson(content);
    const candidates = [s];
    const o1 = s.indexOf("{");
    const o2 = s.lastIndexOf("}");
    if (o1 >= 0 && o2 > o1) candidates.push(s.slice(o1, o2 + 1));
    const a1 = s.indexOf("[");
    const a2 = s.lastIndexOf("]");
    if (a1 >= 0 && a2 > a1) candidates.push(s.slice(a1, a2 + 1));
    for (const c of candidates) {
      let v;
      try { v = JSON.parse(c); }
      catch (e) { continue; }
      const arr = Array.isArray(v) ? v : Array.isArray(v?.figures) ? v.figures : null;
      if (arr) return arr;
    }
    return null;
  }

  function cleanEntry(e) {
    if (!e || typeof e !== "object") return null;
    const id = str(e.id);
    if (!id) return null;
    const steps = (Array.isArray(e.steps) ? e.steps : [])
      .map((s) => {
        if (typeof s === "string") return { text: str(s), panel: null };
        const panel = str(s?.panel).replace(/[()]/g, "").toLowerCase();
        return { text: str(s?.text), panel: /^[a-z]$/.test(panel) ? panel : null };
      })
      .filter((s) => s.text)
      .slice(0, 5);
    if (!steps.length) return null;
    return { id, title: str(e.title), steps };
  }

  async function explainBatch(batch, ctx) {
    const { mentionMap, targetLang, paperContext, signal, config } = ctx;
    const payload = {
      figures: batch.map((f) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        caption: clip(f.caption, MAX_CAPTION),
        mentions: (mentionMap?.get(f.id) || []).slice(0, MAX_MENTIONS).map((m) => clip(m.excerpt, 240)),
      })),
    };
    const ctxLine = paperContext ? `Paper context:\n${clip(paperContext, 1500)}\n\n` : "";
    const user = `${ctxLine}${TASK_PROMPT}\n\n${MARKER}\n${JSON.stringify(payload)}`;
    const system = `${SYSTEM_PROMPT}\nWrite all text in ${languageInstruction(targetLang)}.`;
    const ids = new Set(batch.map((f) => f.id));
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      try {
        const res = await DeepRead.LLM.complete({
          system,
          messages: [{ role: "user", content: user }],
          responseFormat: { type: "json_object" },
          temperature: 0.3,
          signal,
          config,
        });
        const arr = parseReply(res?.content);
        if (!arr) throw new Error("Unparseable figure guide reply");
        const got = new Map();
        for (const raw of arr) {
          const e = cleanEntry(raw);
          if (e && ids.has(e.id)) got.set(e.id, { title: e.title, steps: e.steps });
        }
        if (!got.size) throw new Error("Figure guide reply had no usable entries");
        return got;
      }
      catch (e) {
        if (isAbort(e, signal)) throw abortError();
        lastErr = e;
      }
    }
    DeepRead.log?.("Figures.explain batch failed:", lastErr?.message || lastErr);
    return new Map();
  }

  async function explain(figures, opts = {}) {
    const { signal, onProgress } = opts;
    const out = new Map();
    const all = (figures || []).filter((f) => f && f.id);
    const batches = [];
    for (let i = 0; i < all.length; i += BATCH) batches.push(all.slice(i, i + BATCH));
    const ctx = {
      mentionMap: opts.mentions,
      targetLang: opts.targetLang,
      paperContext: opts.paperContext,
      signal,
      config: opts.config,
    };
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        throwIfAborted(signal);
        const b = batches[next++];
        const got = await explainBatch(b, ctx);
        for (const [k, v] of got) out.set(k, v);
        done += b.length;
        try { onProgress?.({ done, total: all.length }); } catch (e) { /* ignore UI errors */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    throwIfAborted(signal);
    return out;
  }

  DeepRead.Figures = { list, mentions, explain, parseCaption, parseReply };
})();
