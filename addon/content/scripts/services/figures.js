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
  const MERGE_GAP = 30; // per-mille; max gap for an uncaptioned part to join a figure

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

  const VISUAL_TYPES = new Set(["image", "table", "chart", "figure"]);
  const CAPTION_KEYS = ["image_caption", "table_caption", "chart_caption", "img_caption", "caption"];

  // Caption of a visual item: starts at the first line matching CAPTION_RE (earlier lines are panel labels).
  function captionOf(it) {
    for (const key of CAPTION_KEYS) {
      const v = it[key];
      const entries = Array.isArray(v) ? v : [v];
      const lines = [];
      for (const e of entries) {
        for (const line of str(e).split(/\r?\n/)) {
          const t = line.trim();
          if (t) lines.push(t);
        }
      }
      const at = lines.findIndex((l) => CAPTION_RE.test(l));
      if (at >= 0) return lines.slice(at).join(" ");
    }
    return "";
  }

  function boxGap(a, b) {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
    const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return { dx, dy };
  }
  function unionInto(a, b) {
    a[0] = Math.min(a[0], b[0]);
    a[1] = Math.min(a[1], b[1]);
    a[2] = Math.max(a[2], b[2]);
    a[3] = Math.max(a[3], b[3]);
  }
  function closeness(a, b) {
    const { dx, dy } = boxGap(a, b);
    return dx <= MERGE_GAP && dy <= MERGE_GAP ? Math.hypot(dx, dy) : Infinity;
  }

  function list(contentList) {
    const items = Array.isArray(contentList) ? contentList : [];
    const entries = []; // { order, pageIndex, bbox, caption, textIdx, captionOnly }
    const used = new Set();
    const isVisual = (it) => !!it && VISUAL_TYPES.has(it.type);
    const hasBox = (it) => Array.isArray(it.bbox) && it.bbox.length >= 4;

    const figures = [];
    const loose = [];
    items.forEach((it, idx) => {
      if (!isVisual(it)) return;
      const caption = captionOf(it);
      const page = it.page_idx || 0;
      if (caption) {
        figures.push({ order: idx, pageIndex: page, bbox: hasBox(it) ? it.bbox.slice(0, 4) : null, caption });
      }
      else if (hasBox(it)) {
        loose.push({ order: idx, pageIndex: page, bbox: it.bbox.slice(0, 4), done: false });
      }
    });

    // Uncaptioned parts join the nearest captioned figure on the page; repeat so rows of sub-images chain.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of loose) {
        if (p.done) continue;
        let best = null;
        let bestD = Infinity;
        for (const f of figures) {
          if (!f.bbox || f.pageIndex !== p.pageIndex) continue;
          const d = closeness(f.bbox, p.bbox);
          if (d < bestD) {
            best = f;
            bestD = d;
          }
        }
        if (best) {
          unionInto(best.bbox, p.bbox);
          best.order = Math.min(best.order, p.order);
          p.done = true;
          changed = true;
        }
      }
    }
    entries.push(...figures);

    // Remaining uncaptioned parts: cluster, then look for a caption in a nearby text block.
    const rest = loose.filter((p) => !p.done);
    const clusters = [];
    for (const p of rest) {
      const hit = [];
      clusters.forEach((c, i) => {
        if (c.pageIndex === p.pageIndex && closeness(c.bbox, p.bbox) !== Infinity) hit.push(i);
      });
      const c = { pageIndex: p.pageIndex, bbox: p.bbox.slice(), order: p.order };
      for (const i of hit) {
        unionInto(c.bbox, clusters[i].bbox);
        c.order = Math.min(c.order, clusters[i].order);
      }
      for (let k = hit.length - 1; k >= 0; k--) clusters.splice(hit[k], 1);
      clusters.push(c);
    }
    // Merging order can leave touching clusters; fold them until stable.
    for (let again = true; again;) {
      again = false;
      outer: for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          if (clusters[i].pageIndex === clusters[j].pageIndex && closeness(clusters[i].bbox, clusters[j].bbox) !== Infinity) {
            unionInto(clusters[i].bbox, clusters[j].bbox);
            clusters[i].order = Math.min(clusters[i].order, clusters[j].order);
            clusters.splice(j, 1);
            again = true;
            break outer;
          }
        }
      }
    }
    clusters.sort((a, b) => a.order - b.order);
    for (const c of clusters) {
      let best = null;
      let bestGap = Infinity;
      items.forEach((tx, j) => {
        if (!tx || used.has(j) || isVisual(tx) || tx.page_idx !== c.pageIndex) return;
        if (typeof tx.text !== "string" || !hasBox(tx) || !CAPTION_RE.test(tx.text)) return;
        const below = tx.bbox[1] - c.bbox[3];
        const above = c.bbox[1] - tx.bbox[3];
        const gap = below >= -20 ? below : above >= -20 ? above : Infinity;
        if (gap <= NEAR && gap < bestGap) {
          best = j;
          bestGap = gap;
        }
      });
      if (best !== null) {
        used.add(best);
        entries.push({ order: c.order, pageIndex: c.pageIndex, bbox: c.bbox, caption: str(items[best].text) });
      }
    }

    // Strict caption text blocks no figure used.
    const listed = new Set();
    for (const e of entries) {
      const p = parseCaption(e.caption);
      if (p) listed.add(keyOf(p.kind, p.number));
    }
    items.forEach((tx, j) => {
      if (!tx || used.has(j) || isVisual(tx) || typeof tx.text !== "string" || !hasBox(tx)) return;
      if (!CAPTION_STRICT_RE.test(tx.text)) return;
      const p = parseCaption(str(tx.text));
      if (!p) return;
      const k = keyOf(p.kind, p.number);
      if (listed.has(k)) return;
      listed.add(k);
      entries.push({ order: j, pageIndex: tx.page_idx || 0, bbox: tx.bbox.slice(0, 4), caption: str(tx.text), captionOnly: true });
    });

    entries.sort((a, b) => a.order - b.order);
    const seen = new Map();
    const out = [];
    for (const e of entries) {
      const p = parseCaption(e.caption);
      if (!p) continue;
      const prefix = p.kind === "figure" ? "fig" : "tab";
      let id = `${prefix}_${p.number}`;
      const n = (seen.get(id) || 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}_${n}`;
      const f = {
        id,
        kind: p.kind,
        label: `${p.kind === "figure" ? "图" : "表"} ${p.number}`,
        number: p.number,
        pageIndex: e.pageIndex,
        bbox: e.bbox,
        caption: e.caption,
        title: shortTitle(p.rest),
      };
      if (e.captionOnly) f.captionOnly = true;
      out.push(f);
    }
    const top = (f) => (f.bbox ? f.bbox[1] : 0);
    const left = (f) => (f.bbox ? f.bbox[0] : 0);
    out.sort((a, b) => a.pageIndex - b.pageIndex || top(a) - top(b) || left(a) - left(b));
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
