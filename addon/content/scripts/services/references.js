/*
 * References: reference-list parsing and in-text citation markers (pure, no LLM).
 * Feeds the hover lookup of citation markers in the reader.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const BODY_TYPES = { text: 1, list: 1, text_with_equation: 1 };
  const REF_HEAD_RE = /^(?:\d+\.?|[ivx]+\.)?(?:references?|bibliography|参考文献)[:：]?$/;
  const END_HEAD_RE = /^(?:appendix|appendices|supplementary|附录|[A-Z][.:]?\s+\S)/i;
  const PARTICLES = "(?:(?:van|von|de|der|del|di|da|le|la|den|ter|dos|du)\\s+)*";
  const NAME = `${PARTICLES}\\p{Lu}[\\p{L}'’\\-]+`;
  const CITED = `${NAME}(?:\\s+et\\s+al\\.?|\\s+(?:and|&)\\s+${NAME})?`;
  const YEAR = "(?:19|20)\\d\\d[a-z]?";
  const SEG_RE = new RegExp(`^\\s*(?:(?:e\\.g\\.|i\\.e\\.|see|cf\\.|also)[,\\s]+)*(${CITED})\\s*,?\\s*(${YEAR}(?:\\s*,\\s*${YEAR})*)(?:\\s*,\\s*(?:pp?\\.|tab|fig|sec)[^;]*)?\\s*$`, "u");
  const NARR_RE = new RegExp(`(${CITED})\\s*\\((${YEAR}(?:\\s*,\\s*${YEAR})*)\\)`, "gu");
  const NUM_RE = /\[\s*(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?(?:\s*[,;]\s*\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)*)\s*\]/g;
  const MAX_NUMS = 50;

  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function itemText(it) {
    if (!it) return "";
    if (typeof it.text === "string" && it.text) return it.text;
    if (Array.isArray(it.list_items)) return it.list_items.join("\n");
    return "";
  }

  function headKey(s) {
    return norm(s).replace(/\s+/g, "").toLowerCase();
  }

  // { start, end } item indexes of the references section (heading to next appendix heading), or null.
  function sectionRange(cl) {
    let start = -1;
    for (let i = 0; i < cl.length; i++) {
      const it = cl[i];
      if (!it || it.type !== "text") continue;
      const t = norm(it.text);
      if (!t || t.length > 30) continue;
      if (REF_HEAD_RE.test(headKey(t))) { start = i; break; }
    }
    if (start < 0) return null;
    let end = cl.length;
    for (let i = start + 1; i < cl.length; i++) {
      const it = cl[i];
      if (!it || it.type !== "text" || !it.text_level) continue;
      const t = norm(it.text);
      if (t.length < 80 && END_HEAD_RE.test(t)) { end = i; break; }
    }
    return { start, end };
  }

  // Split a joined section string on sequential "[n]" or "n." / "n " starts; null when not numbered.
  function splitNumbered(s) {
    s = s.replace(/^\s+/, "");
    const hits = [];
    const sequential = (re, minHits) => {
      hits.length = 0;
      let prev = null, m;
      re.lastIndex = 0;
      while ((m = re.exec(s))) {
        const n = Number(m[1]);
        if (prev === null ? m.index > 0 && s.slice(0, m.index).trim() : n !== prev + 1) continue;
        hits.push({ n, at: m.index, to: m.index + m[0].length });
        prev = n;
      }
      return hits.length >= minHits && hits[0].at === 0;
    };
    const ok = sequential(/(?:^|\s)\[(\d{1,3})\]\s*/g, 1)
      || sequential(/(?:^|\n|(?<=[.?!”"')\]]\s))(\d{1,3})\.?[ \t]+(?=[\p{Lu}“"\[])/gu, 2);
    if (!ok) return null;
    return hits.map((h, i) => ({ n: h.n, text: s.slice(h.to, i + 1 < hits.length ? hits[i + 1].at : s.length) }));
  }

  // Conservative split of an author-year block where "Surname, X." / "Surname X," starts a new entry.
  const NEW_ENTRY_RES = [
    /(?<=[\p{L}0-9)\]”"]{2}\.)\s+(?=(?!In\s|Proc)\p{Lu}[\p{L}'’\-]+(?:\s\p{Lu}[\p{L}'’\-]+)?,\s\p{Lu}\.)/gu,
    /(?<=[\p{L}0-9)\]”"]{2}\.)\s+(?=(?!In\s|Proc)\p{Lu}[\p{L}'’\-]+\s\p{Lu}{1,3},\s)/gu,
  ];
  function splitAuthorYear(s) {
    for (const re of NEW_ENTRY_RES) {
      const parts = s.split(re).map(norm).filter(Boolean);
      if (parts.length > 1) return parts;
    }
    return [s];
  }

  function firstSentence(s) {
    const re = /[.?!](?=\s|$)/g;
    let m;
    while ((m = re.exec(s))) {
      const pre = s.slice(0, m.index);
      if (s[m.index] === "." && /(?:^|[\s.\-])\p{Lu}$/u.test(pre)) continue;
      if (!pre.trim()) continue;
      const cut = s[m.index] === "." ? m.index : m.index + 1;
      return [s.slice(0, cut).trim(), s.slice(m.index + 1).trim()];
    }
    return [s.trim(), ""];
  }

  function surnameOf(authors) {
    const a = authors.replace(/,?\s*et\s+al\.?/i, "").replace(/^\s*(?:and|&)\s+/i, "").trim();
    if (!a) return "";
    const chunks = a.split(/\s*,\s*|\s+and\s+|\s*&\s*/).map((c) => c.replace(/^(?:and|&)\s+/i, "").trim()).filter(Boolean);
    if (!chunks.length) return "";
    const c = chunks[0];
    const words = c.split(/\s+/);
    if (words.length === 1) return c.replace(/\.$/, "");
    if (/^\p{Lu}{1,3}\.?$/u.test(words[words.length - 1]) && !/^\p{Lu}{1,3}\.?$/u.test(words[0])) return words[0];
    const pi = words.findIndex((w, i) => i > 0 && /^(?:van|von|de|der|del|di|da|le|la|den|ter|dos|du)$/.test(w));
    if (pi > 0) return words.slice(pi).join(" ");
    return words[words.length - 1].replace(/\.$/, "");
  }

  function cleanTitle(t) {
    t = norm(t).replace(/^[“"'‘]+|[”"'’]+$/g, "").replace(/[\s,.;:]+$/, "").trim();
    if (/^(?:arxiv|in\b|proc|ieee|http)/i.test(t)) return "";
    return t;
  }

  function parseRef(text) {
    const out = { authors: "", firstAuthor: "", year: "", title: "", doi: "", arxiv: "" };
    const dm = text.match(/10\.\d{4,9}\/[^\s"”<>]+/);
    if (dm) out.doi = dm[0].replace(/[.,;)\]]+$/, "");
    const am = text.match(/arxiv[^0-9]{0,30}(\d{4}\.\d{4,5})(?:v\d+)?/i) || text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
    if (am) out.arxiv = am[1];

    const plain = text.replace(/https?:\/\/\S+|10\.\d{4,9}\/\S+|arxiv[^0-9]{0,30}\d{4}\.\d{4,5}(?:v\d+)?/gi, " ");
    let authors = "", title = "", year = "";

    const q = text.match(/[“"]([^”"]{4,}?)[”"]/);
    const apa = text.match(/^(\p{Lu}.{0,249}?)\s*\(((?:19|20)\d\d[a-z]?)\)\s*[.,]?\s*(\S.*)$/u);
    if (q) {
      authors = text.slice(0, q.index).replace(/[,\s]+$/, "");
      title = q[1];
    } else if (apa) {
      authors = apa[1].replace(/[,\s]+$/, "");
      year = apa[2];
      title = firstSentence(apa[3])[0];
    } else {
      const [a, rest] = firstSentence(text);
      if (a.length < 300 && /^\p{Lu}/u.test(a) && /\p{Lu}/u.test(a.slice(1)) && rest) {
        authors = a;
        title = firstSentence(rest)[0];
        if (!firstSentence(rest)[1] && /^\W*$/.test(rest.replace(/[.\w\s-]/g, ""))) title = firstSentence(rest)[0];
      }
    }
    out.authors = authors;
    out.title = cleanTitle(title);
    out.firstAuthor = surnameOf(authors);

    if (!year) {
      const ym = plain.match(/\(((?:19|20)\d\d[a-z]?)\)/);
      if (ym) year = ym[1];
      else {
        const all = plain.match(/\b(?:19|20)\d\d[a-z]?\b/g);
        if (all) year = all[all.length - 1];
      }
    }
    if (!year && out.arxiv) year = "20" + out.arxiv.slice(0, 2);
    out.year = year;
    return out;
  }

  function makeRef(n, text) {
    text = norm(text);
    const p = parseRef(text);
    const multi = /,|\band\b|&|et al/i.test(p.authors.replace(/^[^,]*?(?:,\s*)?$/, ""));
    const label = n != null ? `[${n}]`
      : (p.firstAuthor ? p.firstAuthor + (multi ? " et al." : "") + (p.year ? ", " + p.year : "") : p.year);
    return Object.assign({ id: "", n: n == null ? null : n, label, text }, p);
  }

  function assignIds(refs) {
    const seen = new Set();
    refs.forEach((r, i) => {
      let base = r.n != null ? "r" + r.n
        : "r_" + (fold(r.firstAuthor).replace(/[^a-z0-9]/g, "") + r.year || String(i + 1));
      let id = base, k = 2;
      while (seen.has(id)) id = base + "_" + k++;
      seen.add(id);
      r.id = id;
    });
    return refs;
  }

  function list(contentList) {
    const cl = Array.isArray(contentList) ? contentList : [];
    const refTexts = cl.filter((it) => it && it.type === "ref_text" && norm(itemText(it)));
    let entries = [];
    if (refTexts.length) {
      const texts = refTexts.map((it) => norm(itemText(it)));
      const plainRe = /^(\d{1,3})(?:\.\s*|\s+)(?=\S)/;
      const plainCount = texts.filter((t) => plainRe.test(t) && !/^\[/.test(t)).length;
      const plainOk = plainCount >= Math.max(2, texts.length / 2);
      for (const t of texts) {
        let m = t.match(/^\[(\d{1,3})\]\s*(.*)$/);
        if (!m && plainOk) m = t.match(/^(\d{1,3})(?:\.\s*|\s+)(\S.*)$/);
        entries.push(m ? { n: Number(m[1]), text: m[2] } : { n: null, text: t });
      }
    } else {
      const sec = sectionRange(cl);
      if (!sec) return [];
      const lines = [];
      for (let i = sec.start + 1; i < sec.end; i++) {
        const it = cl[i];
        if (!it || !BODY_TYPES[it.type] || (it.type === "text" && it.text_level && !itemText(it).trim())) continue;
        const t = itemText(it).trim();
        if (t) lines.push(t);
      }
      const joined = lines.join("\n");
      const numbered = splitNumbered(joined);
      if (numbered) entries = numbered;
      else {
        for (const line of lines) for (const part of splitAuthorYear(norm(line))) entries.push({ n: null, text: part });
      }
    }
    return assignIds(entries.filter((e) => norm(e.text)).map((e) => makeRef(e.n, e.text)));
  }

  function expandNums(a, b, out) {
    if (b < a || b - a >= MAX_NUMS) { out.push(a, b); return; }
    for (let k = a; k <= b; k++) out.push(k);
  }

  function citationsIn(text) {
    text = String(text || "");
    const groups = [];
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text))) {
      let end = m.index + m[0].length;
      const nums = [];
      for (const part of m[1].split(/[,;]/)) {
        const r = part.split(/[–—-]/).map((x) => Number(x.trim()));
        if (r.length === 2) expandNums(r[0], r[1], nums); else nums.push(r[0]);
      }
      const tail = text.slice(end).match(/^\s*[–—-]\s*\[(\d{1,3})\]/);
      if (tail) {
        const last = nums.pop();
        expandNums(last, Number(tail[1]), nums);
        end += tail[0].length;
        NUM_RE.lastIndex = end;
      }
      if (nums.some((n) => n < 1) || !nums.length) continue;
      groups.push({ start: m.index, end, raw: text.slice(m.index, end), items: nums.slice(0, MAX_NUMS).map((n) => ({ n })) });
    }

    const ay = [];
    const parenRe = /\(([^()]{4,200})\)/g;
    while ((m = parenRe.exec(text))) {
      const items = [];
      for (const seg of m[1].split(";")) {
        const sm = seg.match(SEG_RE);
        if (!sm) continue;
        const author = sm[1].replace(/\s+et\s+al\.?$/, "").split(/\s+(?:and|&)\s+/)[0].trim();
        for (const y of sm[2].split(/\s*,\s*/)) items.push({ author, year: y });
      }
      if (items.length) ay.push({ start: m.index, end: m.index + m[0].length, raw: m[0], items });
    }
    NARR_RE.lastIndex = 0;
    while ((m = NARR_RE.exec(text))) {
      const author = m[1].replace(/\s+et\s+al\.?$/, "").split(/\s+(?:and|&)\s+/)[0].trim();
      ay.push({ start: m.index, end: m.index + m[0].length, raw: m[0], items: m[2].split(/\s*,\s*/).map((y) => ({ author, year: y })) });
    }
    ay.sort((a, b) => a.start - b.start);
    let lastEnd = -1;
    for (const g of ay) {
      if (g.start < lastEnd) continue;
      groups.push(g);
      lastEnd = g.end;
    }
    return groups.sort((a, b) => a.start - b.start);
  }

  // Returns { group, item } or null. item: the single number/work under the offset (null when ambiguous).
  function citationAt(text, offset) {
    const g = citationsIn(text).find((x) => offset >= x.start && offset < x.end);
    if (!g) return null;
    if (g.items.length === 1) return { group: g, item: g.items[0] };
    let item = null;
    if (g.items[0].n !== undefined) {
      const re = /\d+/g;
      let m;
      while ((m = re.exec(g.raw))) {
        const s = g.start + m.index;
        if (offset >= s && offset < s + m[0].length) { item = { n: Number(m[0]) }; break; }
      }
    }
    return { group: g, item };
  }

  function resolve(item, refs) {
    if (!item || !Array.isArray(refs)) return null;
    if (item.n != null) return refs.find((r) => r.n === item.n) || null;
    if (!item.author) return null;
    const a = fold(item.author);
    const y = String(item.year || "");
    const hasSuffix = /[a-z]$/.test(y);
    return refs.find((r) => {
      const f = fold(r.firstAuthor);
      if (!f || !(f === a || f.endsWith(" " + a) || a.endsWith(" " + f))) return false;
      if (!y) return true;
      return hasSuffix ? r.year === y : r.year.slice(0, 4) === y;
    }) || null;
  }

  function occurrences(contentList, refs) {
    const cl = Array.isArray(contentList) ? contentList : [];
    const out = new Map();
    for (const r of refs || []) out.set(r.id, []);
    const sec = sectionRange(cl);
    for (let i = 0; i < cl.length; i++) {
      const it = cl[i];
      if (!it || !BODY_TYPES[it.type]) continue;
      if (sec && i >= sec.start && i < sec.end) continue;
      const text = itemText(it);
      for (const g of citationsIn(text)) {
        const hit = new Set();
        for (const item of g.items) {
          const r = resolve(item, refs);
          if (!r || hit.has(r.id)) continue;
          hit.add(r.id);
          const excerpt = norm(text.slice(Math.max(0, g.start - 60), Math.min(text.length, g.end + 60)));
          out.get(r.id).push({ pageIndex: it.page_idx, blockIndex: i, excerpt });
        }
      }
    }
    return out;
  }

  DeepRead.References = { list, citationsIn, citationAt, resolve, occurrences };
})();
