/*
 * Structure: top-level paper sections derived from the MinerU content list (pure, no LLM).
 * Feeds the section banner strip in the reader.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const KNOWN = [
    "abstract", "introduction", "motivation", "related works?", "background", "preliminar(?:y|ies)",
    "methods?", "methodology", "approach", "experiments?", "experimental(?: results| setup| evaluation)?",
    "results?", "evaluation", "discussions?", "limitations?", "conclusions?", "future work", "references",
    "bibliography", "appendix", "appendices", "supplementary(?: materials?)?", "acknowledg(?:e)?ments?",
    "summary", "analysis", "overview",
    "摘要", "引言", "介绍", "绪论", "相关工作", "背景", "方法", "实验", "结果", "讨论", "结论", "总结", "参考文献", "附录", "致谢",
  ].join("|");
  const KNOWN_RE = new RegExp(`^(?:${KNOWN})(?:\\s*(?:and|&|/|与|和)\\s*(?:${KNOWN}))*$`, "i");
  const APPENDIX_RE = /^(?:appendix|appendices|supplementary|附录)\b/i;
  const CAPTION_RE = /^\s*(?:fig(?:ure)?s?|table|tab)\b\.?\s*[A-Z]?\d+|^\s*(?:图|表)\s*\d+/i;

  // [regex on lowercased title, Chinese label]
  const ZH = [
    [/^abstract$|^摘要$/, "摘要"],
    [/^introduction$|^引言$/, "引言"],
    [/^motivation$/, "动机"],
    [/^related works?$/, "相关工作"],
    [/^background$/, "背景"],
    [/^preliminar(?:y|ies)$/, "预备知识"],
    [/^methods?$|^methodology$|^approach$|^方法$/, "方法"],
    [/^model architecture$/, "模型结构"],
    [/^training$/, "训练"],
    [/^experiments?$|^实验$/, "实验"],
    [/^experimental results$|^results$|^result$|^结果$/, "结果"],
    [/^evaluation$/, "评估"],
    [/^discussions?$|^讨论$/, "讨论"],
    [/^limitations?$/, "局限"],
    [/^conclusions?$|^结论$/, "结论"],
    [/^conclusions? and future work$/, "结论与展望"],
    [/^future work$/, "未来工作"],
    [/^references$|^bibliography$|^参考文献$/, "参考文献"],
    [/^appendix$|^appendices$|^附录$/, "附录"],
    [/^acknowledg(?:e)?ments?$|^致谢$/, "致谢"],
  ];

  const ROLE_RULES = [
    ["references", /references|bibliography|参考文献|acknowledg|致谢/i],
    ["appendix", /appendix|appendices|supplementary|附录/i],
    ["front", /abstract|摘要/i],
    ["intro", /introduction|motivation|引言|介绍|绪论|动机/i],
    ["background", /related work|background|preliminar|相关工作|背景|预备/i],
    ["experiment", /experiment|evaluation|result|benchmark|ablation|实验|评估|结果|消融/i],
    ["discussion", /discussion|limitation|conclusion|future work|summary|讨论|局限|结论|总结|展望/i],
  ];

  const ROMAN = /^(?:I{1,3}|IV|V|VI{0,3}|IX|X{1,2}I{0,3}|XI{0,3})$/;

  function normalizeText(s) {
    let t = String(s || "").replace(/\s+/g, " ").trim();
    // Small caps artifacts: "D IFFUSION P OLICY" -> "DIFFUSION POLICY".
    t = t.replace(/\b([A-Z]) (?=[A-Z]{2,}\b)/g, "$1");
    return t.trim();
  }

  // → { number, title } or null when not a top-level numbering
  function splitNumber(t) {
    let m = /^(\d{1,2})\s*[.:)]?\s+(\S.*)$/.exec(t);
    if (m) return { number: m[1], title: m[2] };
    m = /^([IVX]+)\s*[.:)]\s*(\S.*)$/.exec(t);
    if (m && ROMAN.test(m[1])) return { number: m[1], title: m[2] };
    return null;
  }

  function isSubsection(t) {
    return /^\d+\.\d+/.test(t) // 3.1
      || /^[A-Z]\s*[.)]\s+\S/.test(t) && !ROMAN.test(/^([A-Z])/.exec(t)[1]) // A. / B)
      || /^[a-z]\s*[.)]\s+\S/.test(t)
      || /^\(?[a-z0-9]\)\s/.test(t);
  }

  function zhName(title) {
    const k = title.toLowerCase().replace(/[.:]+$/, "").trim();
    for (const [re, zh] of ZH) if (re.test(k)) return zh;
    return null;
  }

  function shorten(s, n) {
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
  }

  function roleOf(title) {
    for (const [role, re] of ROLE_RULES) if (re.test(title)) return role;
    return null;
  }

  function sections(contentList) {
    const list = Array.isArray(contentList) ? contentList : [];
    let maxPage = 0;
    for (const it of list) if (it && Number.isFinite(it.page_idx)) maxPage = Math.max(maxPage, it.page_idx);
    const found = [];
    let sawFirstPage0Heading = false;
    for (const it of list) {
      if (!it || it.type === "image" || it.type === "table" || it.text_level !== 1) continue;
      if (typeof it.text !== "string") continue;
      const text = normalizeText(it.text.split("\n")[0]);
      if (!text || text.length > 120) continue;
      const isFirstP0 = !sawFirstPage0Heading && (it.page_idx || 0) === 0;
      if (isFirstP0) sawFirstPage0Heading = true;
      if (CAPTION_RE.test(text)) continue;
      const num = splitNumber(text);
      let title;
      let number = null;
      if (num) {
        if (isSubsection(text)) continue;
        number = num.number;
        title = num.title.trim();
      }
      else {
        if (isSubsection(text)) continue;
        title = text.replace(/[.:]+$/, "");
        if (!KNOWN_RE.test(title) && !APPENDIX_RE.test(title)) continue;
        if (isFirstP0 && !/^(?:abstract|摘要)$/i.test(title) && !KNOWN_RE.test(title)) continue;
      }
      // The paper title is the first page-0 heading when it is not clearly a section.
      if (isFirstP0 && !number && !KNOWN_RE.test(title)) continue;
      const y = Array.isArray(it.bbox) && Number.isFinite(it.bbox[1]) ? it.bbox[1] / 1000 : 0;
      found.push({ title, number, start: (it.page_idx || 0) + y });
    }
    found.sort((a, b) => a.start - b.start);

    // Roles
    const out = found.map((f, i) => {
      const zh = zhName(f.title);
      const shown = zh || shorten(f.title, 28);
      const label = f.number ? `${f.number} ${shown}` : shown;
      return {
        id: `sec_${i}`,
        title: f.title,
        label,
        number: f.number,
        role: roleOf(f.title),
        start: f.start,
        end: f.start,
      };
    });
    let seenRefs = false;
    for (const s of out) {
      if (!s.role) s.role = seenRefs ? "appendix" : "method";
      if (s.role === "references") seenRefs = true;
      else if (s.role === "appendix") seenRefs = true;
    }
    for (let i = 0; i < out.length; i++) {
      out[i].end = i + 1 < out.length ? out[i + 1].start : Math.max(maxPage + 1, out[i].start);
    }
    return out;
  }

  function sectionAt(secs, pageIndex, yPermille) {
    if (!Array.isArray(secs) || !secs.length) return -1;
    const pos = Number(pageIndex) + (Number(yPermille) || 0) / 1000;
    if (!Number.isFinite(pos)) return -1;
    let idx = -1;
    for (let i = 0; i < secs.length; i++) {
      if (secs[i].start <= pos) idx = i;
      else break;
    }
    if (idx >= 0 && pos >= secs[idx].end && idx === secs.length - 1) return -1;
    return idx;
  }

  DeepRead.Structure = { sections, sectionAt };
})();
