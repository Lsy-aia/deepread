/*
 * Guide: "带读" (guided reading). Builds the paper Markdown for agents, the agent instruction, the API-written
 * Markdown (Stage A), turns the Markdown into the guide JSON (Stage B), and helpers for imports, notes and cards.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const XRAY_MARKER = "Paper (Markdown):";
  const SOURCE_MARKER = "Guide source (Markdown):";
  const BLOCKS_MARKER = "Paper blocks (JSON):";
  const DONE_LINE = "DEEPREAD_DONE";
  const DEFAULT_MAX_CHARS = 120000;
  const SKILLS_MAX_CHARS = 12000;
  const SOURCE_MAX_CHARS = 40000;
  const BLOCKS_BUDGET = 30000;
  const SUMMARY_MAX = 120;
  const MAX_CONTEXT_CHARS = 3000;
  const MAX_KEYS = 6;

  const CAPS = { path: 6, focus: 6, order: 8, questions: 5, moves: 20, terms: 30, components: 12, formulas: 6, chain: 12, checks: 12, hedges: 20, learned: 10, ideas: 6 };

  const TYPES = ["algorithmic", "methods", "hypothesis", "research", "review", "resource", "clinical", "other"];
  const ROLES = ["background", "gap", "prior", "contribution", "claim", "evidence", "limitation"];
  const VERDICTS = ["load-bearing", "contributing", "decorative", "unestablished", "pending"];
  const STATUSES = ["proven", "partial", "unproven", "pending"];
  const STRENGTHS = ["strong", "hedged", "speculative", "outlook"];
  const BASES = ["source", "inference", "pending"];
  const EFFECTS = ["changes", "weakens", "scopes", "wording"];
  const STATES = ["open", "ok", "problem"];

  const LABELS = {
    verdict: { "load-bearing": ["承重", "Load-bearing"], contributing: ["贡献", "Contributing"], decorative: ["装饰", "Decorative"], unestablished: ["未确立", "Unestablished"], pending: ["待定", "Pending"] },
    status: { proven: ["● 已证", "● Proven"], partial: ["◐ 部分", "◐ Partial"], unproven: ["✕ 未证", "✕ Unproven"], pending: ["○ 待读", "○ To read"] },
    strength: { strong: ["强断言", "Strong claim"], hedged: ["保留", "Hedged"], speculative: ["推测", "Speculative"], outlook: ["展望", "Outlook"] },
    role: { background: ["背景", "Background"], gap: ["缺口", "Gap"], prior: ["已有工作", "Prior work"], contribution: ["贡献", "Contribution"], claim: ["主张", "Claim"], evidence: ["证据", "Evidence"], limitation: ["局限", "Limitation"] },
  };

  const CARD_SECTIONS = [
    "basic information", "one-sentence summary", "research question", "background and lineage", "core pain point", "core idea",
    "method overview", "module breakdown", "key formulas", "evidence chain", "correct reading of the conclusions",
    "author-stated limitations", "critical analysis", "what I learned", "connection to existing knowledge", "research ideas",
  ];

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

  function label(group, value) {
    const pair = (LABELS[group] || {})[value];
    if (!pair) return str(value);
    return DeepRead.bilingual ? DeepRead.bilingual(pair[0], pair[1]) : pair[0];
  }

  /** Keep the start and the end of `text` when it is longer than `max`. */
  function clip(text, max) {
    const s = String(text || "");
    if (s.length <= max) return s;
    const head = Math.ceil(max * 0.6);
    const tail = max - head;
    return `${s.slice(0, head)}\n\n[... clipped ...]\n\n${s.slice(s.length - tail)}`;
  }

  // ---------- paper Markdown ----------

  function looksLikeLatex(s) {
    return /\\[a-zA-Z]+|[_^]\{|[_^][a-zA-Z0-9]/.test(s);
  }

  function paperMarkdown(hierarchicalData, opts = {}) {
    const out = [`# ${str(opts.title) || "Untitled"}`];
    for (const page of hierarchicalData || []) {
      const pageIndex = Number(page && page.pageIndex) || 0;
      for (const p of (page && page.paragraphs) || []) {
        const text = str(p && p.paragraphText);
        if (!text) continue;
        const type = str(p.paragraphType);
        if (type === "title") out.push(`## ${text}`);
        else if (type === "image" || type === "table") out.push(`> ${text}`);
        else if (type === "equation") out.push(looksLikeLatex(text) ? `$$${text}$$` : text);
        else out.push(`[p. ${pageIndex + 1} ¶${(Number(p.paragraphIndex) || 0) + 1}] ${text}`);
      }
    }
    return out.join("\n\n");
  }

  // ---------- Stage A ----------

  function outputSpec(targetLang, withSkills) {
    return [
      `Write both documents in ${languageInstruction(targetLang)}. Keep technical terms in English.`,
      withSkills ? "" : [
        "xray.md: a long-read X-ray of the paper. Reconstruct the research path (what failed, what the authors bet on, what holds the bet up); separate load-bearing parts from decoration; give worked examples for the key formulas with concrete numbers; state the evidence boundary (what the evidence supports and what it cannot); note the hedging strength of the authors' claims.",
        `paper-card.md: a paper card with exactly 16 numbered sections (## 01 … ## 16): ${CARD_SECTIONS.map((s, i) => `${String(i + 1).padStart(2, "0")} ${s}`).join("; ")}.`,
      ].join("\n"),
      "Cite paragraphs with their labels in square brackets, e.g. [p. 3 ¶2], exactly as in paper.md.",
    ].filter(Boolean).join("\n");
  }

  function agentPrompt(opts = {}) {
    const skills = (opts.skills || []).filter((s) => s && s.path);
    const lines = [
      "You are helping a researcher read an academic paper closely.",
      `Work directory: ${opts.workdir}`,
      "The paper is in `paper.md` in the work directory. Every paragraph starts with its block label, e.g. `[p. 3 ¶2] ...`; headings are `##`, figure and table captions are `>` lines.",
      `The original PDF is at: ${opts.pdfPath}`,
      "Do not modify paper.md.",
      "",
    ];
    if (skills.length) {
      lines.push("Read the SKILL.md of each of these skills and follow it:");
      for (const s of skills) lines.push(`- ${s.name}: ${s.path}`);
      lines.push(
        "",
        "Produce, both in the work directory:",
        "- `xray.md` with the nature-paper-xray skill",
        "- `paper-card.md` with the nature-paper-card skill (the fixed 16 sections)",
        "",
      );
    }
    else {
      lines.push(
        "No skills are available, so follow these compact instructions. Produce, both in the work directory, `xray.md` and `paper-card.md`.",
        "",
      );
    }
    lines.push(
      outputSpec(opts.targetLang, skills.length > 0),
      "",
      `When both files are written, print the single line \`${DONE_LINE}\`.`,
    );
    return lines.join("\n");
  }

  const SYSTEM_A = [
    "You are an expert research reader writing close-reading documents about an academic paper.",
    "The paper is given as Markdown where every paragraph starts with its block label, e.g. [p. 3 ¶2].",
    "Return only a JSON object.",
  ].join("\n");

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
        catch (e2) { /* not JSON */ }
      }
    }
    return null;
  }

  function contextPart(paperContext) {
    return str(paperContext) ? [`Paper context:\n${str(paperContext).slice(0, MAX_CONTEXT_CHARS)}`] : [];
  }

  async function withRetry(run, opts) {
    throwIfAborted(opts.signal);
    try {
      return await run();
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      DeepRead.log?.("guide request failed, retrying:", e?.message || e);
    }
    throwIfAborted(opts.signal);
    try {
      return await run();
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      throw e;
    }
  }

  /** Stage A with an API model → { xray, card } (Markdown). */
  async function writeWithApi(opts = {}) {
    const paper = clip(paperMarkdown(opts.hierarchicalData, { title: opts.title }), Number(opts.maxChars) > 0 ? Number(opts.maxChars) : DEFAULT_MAX_CHARS);
    const skillsText = str(opts.skillsText);
    const user = [
      ...contextPart(opts.paperContext),
      [
        "Write two Markdown documents about the paper below and return them as JSON only, in exactly this shape:",
        "{\"xray\":\"<markdown>\",\"card\":\"<markdown>\"}",
        "- xray: a long-read X-ray of the paper (the nature-paper-xray method).",
        "- card: a paper card with exactly 16 numbered sections (the nature-paper-card method).",
        outputSpec(opts.targetLang, !!skillsText),
      ].join("\n"),
      ...(skillsText ? [`Skill guidance:\n${clip(skillsText, SKILLS_MAX_CHARS)}`] : []),
      `${XRAY_MARKER}\n${paper}`,
    ].join("\n\n");
    const run = async () => {
      throwIfAborted(opts.signal);
      const res = await DeepRead.LLM.complete({
        system: `${SYSTEM_A}\nWrite in ${languageInstruction(opts.targetLang)}.`,
        messages: [{ role: "user", content: user }],
        responseFormat: { type: "json_object" },
        temperature: 0.3,
        signal: opts.signal,
        config: opts.config,
      });
      const content = res && res.content;
      const value = parseJson(content);
      if (value && typeof value === "object" && !Array.isArray(value) && (str(value.xray) || str(value.card))) {
        return { xray: str(value.xray), card: str(value.card) };
      }
      const text = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (!text) throw new Error("The model returned no text");
      return { xray: text, card: "" };
    };
    return withRetry(run, opts);
  }

  // ---------- normalization ----------

  const LABEL_RE = /p\.\s*(\d+)\s*¶\s*(\d+)/g;

  function keysFromText(text) {
    const out = [];
    for (const m of String(text || "").matchAll(LABEL_RE)) {
      const page = Number(m[1]) - 1;
      const para = Number(m[2]) - 1;
      if (page >= 0 && para >= 0) out.push(`p_${page}_${para}`);
    }
    return out;
  }

  function normalize(raw, blockKeys) {
    const known = new Set(blockKeys || []);
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    const arr = (v, cap) => (Array.isArray(v) ? v.slice(0, cap) : []);
    const pick = (v, list, dflt) => (list.includes(str(v).toLowerCase()) ? str(v).toLowerCase() : dflt);
    const keysOf = (it, texts) => {
      const list = Array.isArray(it.keys) ? it.keys : typeof it.keys === "string" ? [it.keys] : [];
      const all = [...list.map(str), ...texts.flatMap(keysFromText)];
      return [...new Set(all.filter((k) => known.has(k)))].slice(0, MAX_KEYS);
    };
    const strs = (v, cap) => arr(v, cap).map(str).filter(Boolean);
    const items = (v, cap, fn) => arr(v, cap).filter((x) => x && typeof x === "object" && !Array.isArray(x)).map(fn);

    const g = obj(raw);
    const position = obj(g.position);
    const skeleton = obj(g.skeleton);
    const method = obj(g.method);
    const evidence = obj(g.evidence);
    const takeaway = obj(g.takeaway);
    const insight = obj(method.insight);
    const type = str(g.type).toLowerCase();

    return {
      type: TYPES.includes(type) ? type : "other",
      position: {
        claim: str(position.claim),
        path: items(position.path, CAPS.path, (it) => ({
          step: str(it.step), text: str(it.text), basis: pick(it.basis, BASES, "pending"), keys: keysOf(it, [it.text]),
        })),
        focus: strs(position.focus, CAPS.focus),
        order: items(position.order, CAPS.order, (it) => ({
          text: str(it.text), minutes: Number(it.minutes) > 0 ? Math.round(Number(it.minutes)) : 0, keys: keysOf(it, [it.text]),
        })),
        questions: strs(position.questions, CAPS.questions),
      },
      skeleton: {
        moves: items(skeleton.moves, CAPS.moves, (it) => ({
          role: pick(it.role, ROLES, "background"), text: str(it.text), keys: keysOf(it, [it.text]), status: pick(it.status, STATUSES, "pending"),
        })),
        terms: items(skeleton.terms, CAPS.terms, (it) => ({
          term: str(it.term), translation: str(it.translation), variants: strs(it.variants, 8),
        })).filter((t) => t.term),
      },
      method: {
        components: items(method.components, CAPS.components, (it) => ({
          name: str(it.name), verdict: pick(it.verdict, VERDICTS, "pending"), basis: str(it.basis), keys: keysOf(it, [it.basis]),
        })),
        insight: { surface: str(insight.surface), core: str(insight.core), transferable: str(insight.transferable) },
        formulas: items(method.formulas, CAPS.formulas, (it) => ({
          latex: str(it.latex),
          purpose: str(it.purpose),
          symbols: items(it.symbols, 20, (s) => ({ symbol: str(s.symbol), shape: str(s.shape), meaning: str(s.meaning) })),
          example: str(it.example),
          keys: keysOf(it, [it.purpose]),
        })),
      },
      evidence: {
        chain: items(evidence.chain, CAPS.chain, (it) => ({
          claim: str(it.claim),
          evidence: str(it.evidence),
          supports: str(it.supports),
          notSupports: str(it.notSupports),
          status: pick(it.status, STATUSES, "pending"),
          keys: keysOf(it, [it.claim, it.evidence]),
        })),
        checks: items(evidence.checks, CAPS.checks, (it) => ({
          text: str(it.text), effect: pick(it.effect, EFFECTS, "wording"), state: pick(it.state, STATES, "open"),
        })),
        hedges: items(evidence.hedges, CAPS.hedges, (it) => ({
          quote: str(it.quote), strength: pick(it.strength, STRENGTHS, "hedged"), note: str(it.note), keys: keysOf(it, [it.note]),
        })),
      },
      takeaway: {
        summary: str(takeaway.summary),
        learned: strs(takeaway.learned, CAPS.learned),
        ideas: items(takeaway.ideas, CAPS.ideas, (it) => ({
          title: str(it.title), basis: str(it.basis), hypothesis: str(it.hypothesis), test: str(it.test), risk: str(it.risk),
        })),
      },
    };
  }

  // ---------- Stage B ----------

  const SYSTEM_B = [
    "You turn close-reading Markdown documents about an academic paper into a structured reading guide.",
    "Return only a JSON object.",
  ].join("\n");

  const STRUCTURE_PROMPT = [
    "Fill the five steps of the guide from the Markdown documents only. Do not add facts they do not contain, and keep their hedging strength (do not turn a hedged statement into a strong one).",
    "Respond with JSON only, in exactly this shape (every field may be empty):",
    "{\"type\":\"algorithmic|methods|hypothesis|research|review|resource|clinical|other\",",
    "\"position\":{\"claim\":\"\",\"path\":[{\"step\":\"\",\"text\":\"\",\"basis\":\"source|inference|pending\",\"keys\":[]}],\"focus\":[\"\"],\"order\":[{\"text\":\"\",\"minutes\":0,\"keys\":[]}],\"questions\":[\"\"]},",
    "\"skeleton\":{\"moves\":[{\"role\":\"background|gap|prior|contribution|claim|evidence|limitation\",\"text\":\"\",\"keys\":[],\"status\":\"proven|partial|unproven|pending\"}],\"terms\":[{\"term\":\"\",\"translation\":\"\",\"variants\":[]}]},",
    "\"method\":{\"components\":[{\"name\":\"\",\"verdict\":\"load-bearing|contributing|decorative|unestablished|pending\",\"basis\":\"\",\"keys\":[]}],\"insight\":{\"surface\":\"\",\"core\":\"\",\"transferable\":\"\"},\"formulas\":[{\"latex\":\"\",\"purpose\":\"\",\"symbols\":[{\"symbol\":\"\",\"shape\":\"\",\"meaning\":\"\"}],\"example\":\"\",\"keys\":[]}]},",
    "\"evidence\":{\"chain\":[{\"claim\":\"\",\"evidence\":\"\",\"supports\":\"\",\"notSupports\":\"\",\"status\":\"proven|partial|unproven|pending\",\"keys\":[]}],\"checks\":[{\"text\":\"\",\"effect\":\"changes|weakens|scopes|wording\",\"state\":\"open|ok|problem\"}],\"hedges\":[{\"quote\":\"\",\"strength\":\"strong|hedged|speculative|outlook\",\"note\":\"\",\"keys\":[]}]},",
    "\"takeaway\":{\"summary\":\"\",\"learned\":[\"\"],\"ideas\":[{\"title\":\"\",\"basis\":\"\",\"hypothesis\":\"\",\"test\":\"\",\"risk\":\"\"}]}}",
    "Rules:",
    "- Use the enum values exactly as listed.",
    "- The documents cite paragraphs as [p. N ¶M]. Map every cited label to the key of the block with that label (see the paper blocks) and put the keys on the related items. Use only keys that appear in the blocks.",
    "- Write prose in the target language; keep technical terms in English; write math as $...$ (latex fields without delimiters).",
    "- Use empty arrays when the documents have nothing for a field.",
  ].join("\n");

  function budgetBlocks(blocks) {
    const out = [];
    let used = 0;
    for (const b of blocks || []) {
      const key = str(b && b.key);
      if (!key) continue;
      const item = { key, label: str(b.label), summary: str(b.summary).slice(0, SUMMARY_MAX) };
      const size = JSON.stringify(item).length + 1;
      if (used + size > BLOCKS_BUDGET) break;
      used += size;
      out.push(item);
    }
    return out;
  }

  /** Stage B: { xray, card } Markdown → guide JSON. */
  async function structure(opts = {}) {
    const md = opts.markdown || {};
    const blocks = opts.blocks || [];
    const keys = blocks.map((b) => str(b && b.key)).filter(Boolean);
    const source = [
      `## xray\n${clip(str(md.xray), SOURCE_MAX_CHARS) || "(none)"}`,
      `## paper card\n${clip(str(md.card), SOURCE_MAX_CHARS) || "(none)"}`,
    ].join("\n\n");
    if (!str(md.xray) && !str(md.card)) throw new Error("No guide source");
    const user = [
      ...contextPart(opts.paperContext),
      STRUCTURE_PROMPT,
      `${SOURCE_MARKER}\n${source}`,
      `${BLOCKS_MARKER}\n${JSON.stringify({ blocks: budgetBlocks(blocks) })}`,
    ].join("\n\n");
    const run = async () => {
      throwIfAborted(opts.signal);
      const res = await DeepRead.LLM.complete({
        system: `${SYSTEM_B}\nWrite all prose in ${languageInstruction(opts.targetLang)}.`,
        messages: [{ role: "user", content: user }],
        responseFormat: { type: "json_object" },
        temperature: 0.2,
        signal: opts.signal,
        config: opts.config,
      });
      const value = parseJson(res && res.content);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The model returned no guide");
      return normalize(value, keys);
    };
    return withRetry(run, opts);
  }

  // ---------- imports and card sections ----------

  const HEADING_RE = /^#{1,6}\s*(\d{1,2})\s*[.、:：)）-]?\s*(.*?)\s*#*\s*$/;

  function cardSections(card) {
    const out = [];
    let cur = null;
    for (const line of String(card || "").split(/\r?\n/)) {
      const m = HEADING_RE.exec(line);
      const n = m ? Number(m[1]) : 0;
      if (m && n >= 1 && n <= 16) {
        cur = { number: String(n).padStart(2, "0"), title: str(m[2]), body: [] };
        out.push(cur);
      }
      else if (cur) cur.body.push(line);
    }
    return out.map((s) => ({ number: s.number, title: s.title, body: s.body.join("\n").trim() }));
  }

  function parseImported(text, blockKeys) {
    const s = String(text || "").trim();
    const empty = { xray: "", card: "" };
    const value = s.startsWith("{") || s.startsWith("```") ? parseJson(s) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const md = value.markdown && typeof value.markdown === "object" ? value.markdown : {};
      const hasSteps = ["position", "skeleton", "method", "evidence", "takeaway"].some((k) => value[k] && typeof value[k] === "object");
      if (hasSteps) return { markdown: { xray: str(md.xray), card: str(md.card) }, guide: normalize(value, blockKeys) };
      if (str(value.xray) || str(value.card)) return { markdown: { xray: str(value.xray), card: str(value.card) }, guide: null };
      return { markdown: empty, guide: null };
    }
    const isCard = /Paper Card|精读卡/i.test(s) || cardSections(s).length >= 10;
    return { markdown: isCard ? { xray: "", card: s } : { xray: s, card: "" }, guide: null };
  }

  // ---------- note HTML ----------

  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  /** Headings, paragraphs, lists, bold and inline code only. */
  function markdownToHTML(md) {
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    for (const line of String(md || "").split(/\r?\n/)) {
      let m;
      if (!line.trim()) { flushPara(); flushList(); }
      else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        const level = Math.min(6, m[1].length + 1);
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      }
      else if ((m = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line))) {
        flushPara();
        const tag = m[1] ? "ol" : "ul";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push(m[2]);
      }
      else { flushList(); para.push(line.trim()); }
    }
    flushPara(); flushList();
    return out.join("\n");
  }

  function toNoteHTML(guide, markdown, opts = {}) {
    const g = normalize(guide, []);
    const zh = DeepRead.bilingual ? DeepRead.bilingual(true, false) : true;
    const L = (a, b) => (zh ? a : b);
    const out = [`<h1>${esc(opts.title || L("精读", "Close reading"))}</h1>`];
    if (g.takeaway.summary) out.push(`<p><strong>${esc(g.takeaway.summary)}</strong></p>`);
    const steps = [];
    steps.push([L("① 定位", "① Position"), [g.position.claim, ...g.position.path.map((p) => `${p.step}: ${p.text}`)]]);
    steps.push([L("② 骨架", "② Skeleton"), g.skeleton.moves.map((m) => `${label("role", m.role)}: ${m.text}`)]);
    steps.push([L("③ 方法", "③ Method"), [g.method.insight.core, ...g.method.components.map((c) => `${c.name} (${label("verdict", c.verdict)}): ${c.basis}`)]]);
    steps.push([L("④ 证据", "④ Evidence"), g.evidence.chain.map((c) => `${c.claim} [${label("status", c.status)}]: ${c.evidence}`)]);
    steps.push([L("⑤ 带走", "⑤ Takeaway"), [...g.takeaway.learned, ...g.takeaway.ideas.map((i) => `${i.title}: ${i.hypothesis}`)]]);
    for (const [title, lines] of steps) {
      const items = lines.map(str).filter((l) => l && l !== ":");
      out.push(`<h2>${esc(title)}</h2>`);
      if (items.length) out.push(`<ul>${items.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
    }
    const card = str(markdown && markdown.card);
    if (card) {
      out.push(`<h2>${L("精读卡", "Paper Card")}</h2>`);
      out.push(markdownToHTML(card));
    }
    return out.join("\n");
  }

  // ---------- paragraph cards ----------

  function notesForKey(guide, key) {
    const g = guide || {};
    const has = (it) => it && Array.isArray(it.keys) && it.keys.includes(key);
    const out = [];
    for (const c of (g.method && g.method.components) || []) {
      if (has(c)) out.push({ kind: "component", label: label("verdict", c.verdict), text: `${str(c.name)}${str(c.basis) ? `: ${str(c.basis)}` : ""}` });
    }
    for (const h of (g.evidence && g.evidence.hedges) || []) {
      if (has(h)) out.push({ kind: "hedge", label: label("strength", h.strength), text: str(h.quote) });
    }
    for (const c of (g.evidence && g.evidence.chain) || []) {
      if (has(c)) out.push({ kind: "claim", label: label("status", c.status), text: str(c.claim) });
    }
    for (const m of (g.skeleton && g.skeleton.moves) || []) {
      if (has(m) && ["claim", "gap", "contribution"].includes(m.role)) out.push({ kind: "move", label: label("role", m.role), text: str(m.text) });
    }
    return out;
  }

  DeepRead.Guide = {
    XRAY_MARKER,
    SOURCE_MARKER,
    BLOCKS_MARKER,
    DONE_LINE,
    paperMarkdown,
    agentPrompt,
    writeWithApi,
    structure,
    normalize,
    parseImported,
    cardSections,
    toNoteHTML,
    notesForKey,
  };
})();
