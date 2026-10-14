/*
 * DeepRead.Translator — built-in lightweight full-document translation.
 *
 * Ported from ReadFlow / RetainPDF (MIT, Copyright (c) 2026 RetainPDF contributors):
 *   translate/prompts/*.txt (system, task, output protocol, general-science rule profile),
 *   core/placeholder_tokens.py + llm/placeholder_*.py (placeholder format / guard),
 *   llm/result_validator.py + llm/validation/* (missing items, placeholder loss, English residue, protocol junk),
 *   workflow/batch_plan.py (page batches with a char budget), batch_runner.py (concurrency, individual retries).
 * Left out: formula-to-Typst modes, continuation groups, hard-glossary runtime injection, caching/disk
 * artifacts, OCR-structure policies, multi-provider routing.
 *
 * License: AGPL-3.0-or-later (plugin); ported logic MIT.
 */
/* global DeepRead */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------------------------
  // Prompts (ported verbatim from ReadFlow; {target_language_name} is substituted at call time)
  // ---------------------------------------------------------------------------------------------
  const SYSTEM_PROMPT = [
    "你是一名科研文献翻译助手。请将当前原文翻译为适合论文排版的{target_language_name}，准确、客观、自然、凝练。",
    "只翻译当前原文明示的内容，不增添解释或推断。上下文仅供消歧，不得并入译文。",
    "即使当前原文是未写完的半句，也必须照翻半句，严禁从前后文借词补全。",
    "占位符必须逐字保留且顺序不变；代码、命令、配置、路径、API 字段、变量名、版本、邮箱、人名、技术缩写等字面量不得改写，人名不要音译。数学排版遵循专项规则，不改变科学含义。",
    "明显损坏且少于 4 个拉丁字母的 OCR 乱码保持原样；正常词语（包括 and、or、the、vs）不按乱码处理。",
    "遵守块级术语、风格和结构约束；按指定输出协议返回，不附加解释。",
  ].join("\n");

  const TASK_PROMPT = [
    "请将每个 source_text 翻译成适合科研论文排版的{target_language_name}，同时保持原意、术语精度和版面友好性。",
    "优先使用自然的{target_language_name}学术表达，不要机械照搬原文语序。",
    "在不损失信息和技术精度的前提下，优先采用更凝练、更自然的{target_language_name}措辞。",
    "译文长度在可能时尽量接近原文，不要添加冗余解释。",
    "不要翻译占位符，不要改写代码、命令、配置、文件路径、API 字段、变量名、版本号和字面量示例。",
    "如果某个 item 混合了说明文字和字面量，只翻译说明文字，字面量部分逐字保留。",
    "如果某个 item 只是明显损坏的极短 OCR 片段，且少于 4 个拉丁字母，则保持原样，不要借上下文扩写。",
    "但这个规则不适用于正常英文虚词，例如 “and”“or”“the”。",
    "如果提供了 style_hint，请把它视为块级风格约束，但仍然只能翻译当前 source_text 本身。",
    "如果 source_text 本身不完整、被截断或突然结束，译文也应保持同等程度的不完整，不要自行补全。",
    "不要添加 source_text 中不存在的内容。",
    "如果提供了 continuation_group、context_before、context_after，只能用于术语消歧和句法顺滑，最终返回内容仍然只能覆盖当前 item_id 对应的 source_text。",
    "即使当前原文是未写完的半句，也必须照翻半句，严禁从前后文借词补全。",
  ].join("\n");

  const OUTPUT_PROMPT = [
    "只返回符合以下结构的 JSON：",
    "{\"translations\":[{\"item_id\":\"ITEM_ID\",\"translated_text\":\"translated text\",\"decision\":\"translate\"}]}.",
    "每个请求的 item_id 都必须输出一个对象。不要包含 Markdown、代码块或解释说明。",
  ].join("\n");

  const RULE_PROFILE = [
    "科技论文默认规则档：",
    "- 翻译正常散文、段落正文、小标题、条目说明、图表题注和简短的技术性标题。",
    "- 字面代码、字面命令、输入卡片、坐标行、赋值语句、shell 示例，以及独立成行的参数或示例行，保持原样。",
    "- 如果一个块以命令或示例前缀开头、随后转为说明性散文，保留字面前缀，翻译说明部分。",
    "- 对\"跳过翻译\"要保守：成句的长段英文正文通常应当翻译。",
    "- 前几页的元信息片段——作者行、单位署名、编辑日期，以及孤立出现的短连接词（例如 'and'）——通常不翻译。",
  ].join("\n");

  const ITEMS_MARKER = "待翻译 items（JSON）：";
  const MAX_BATCH_CHARS = 3500;
  const MAX_BATCH_ITEMS = 12;
  const CONTEXT_CHARS = 160;
  const RETRY_ATTEMPTS = 2;

  function fill(tpl, name) {
    return tpl.split("{target_language_name}").join(name);
  }

  function targetName(targetLang) {
    const lang = DeepRead.PARSE_LANGUAGES && DeepRead.PARSE_LANGUAGES[targetLang];
    return (lang && (lang.displayName || lang.instruction)) || String(targetLang || "简体中文");
  }

  function isCJKTarget(targetLang) {
    return /^(zh|ja|ko)(-|$)/i.test(String(targetLang || ""));
  }

  function abortError() {
    const e = new Error("Translation aborted");
    e.name = "AbortError";
    return e;
  }

  // ---------------------------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------------------------
  const REFERENCES_RE = /^(?:\d+(?:\.\d+)*\.?\s*)?(references|bibliography|参考文献)(?![a-z])/i;

  function letterCount(text) {
    const m = String(text || "").match(/\p{L}/gu);
    return m ? m.length : 0;
  }

  function buildUnits(contentList) {
    const units = [];
    let inReferences = false;
    for (const item of contentList || []) {
      if (!item || inReferences) continue;
      const id = item.id;
      const page = item.page_idx || 0;
      let kind = null;
      let text = "";
      if (item.type === "text" || item.type === "list") {
        text = item.type === "list" ? (item.list_items || []).join("\n") : String(item.text || "");
        text = text.trim();
        kind = item.type === "text" && item.text_level === 1 ? "title" : "text";
        if (kind === "title" && REFERENCES_RE.test(text)) { inReferences = true; continue; }
      }
      else if (item.type === "image" || item.type === "table") {
        const caps = item.type === "image" ? item.image_caption : item.table_caption;
        text = (Array.isArray(caps) ? caps : []).map((s) => String(s || "").trim()).filter(Boolean).join(" ");
        kind = "caption";
      }
      else continue;
      if (!text || letterCount(text) < 3) continue;
      units.push({ id, page_idx: page, kind, text });
    }
    return units;
  }

  // ---------------------------------------------------------------------------------------------
  // Placeholder protection. Token format (as ReadFlow's formal placeholders): <KN-xyz/>
  //   K = kind letter (f formula/math/LaTeX, c citation, u url/email, t code-like literal),
  //   N = running index within the text, xyz = 3 base-36 chars derived from (N, original).
  // ---------------------------------------------------------------------------------------------
  const TOKEN_RE = /<[futnvc]\d+-[0-9a-z]{3}\/>/g;
  const LENIENT_TOKEN_RE = /<\s*([futnvc]\d+-[0-9a-z]{3})\s*\/\s*>/gi;

  const PROTECT_RE = new RegExp([
    "(\\$\\$[\\s\\S]+?\\$\\$)", // 1 display math
    "(\\\\\\([\\s\\S]+?\\\\\\)|\\\\\\[[\\s\\S]+?\\\\\\])", // 2 \( \) \[ \]
    "(\\$(?![\\s$])[^$\\n]*?(?<!\\s)\\$(?!\\d))", // 3 inline $...$
    "((?:https?:\\/\\/|www\\.)[^\\s<>()]+[^\\s<>().,;:!?'\"])", // 4 URL
    "([\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+)", // 5 email
    "(\\\\[A-Za-z]+\\*?(?:\\{[^{}]*\\})*(?:[_^](?:\\{[^{}]*\\}|\\w))*)", // 6 LaTeX command
    "(\\[\\d+(?:\\s*[,;–—-]\\s*\\d+)*\\])", // 7 citation
    "(`[^`\\n]+`)", // 8 backtick code
    "(\\b[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*\\(\\)" + // 9 foo.bar()
      "|\\b[\\w/-]+(?:\\.[\\w-]+)*\\.(?:py|js|ts|json|txt|md|csv|ya?ml|cpp|c|h|ipynb|sh|toml)\\b" + // file names
      "|(?:~|\\.{1,2})?\\/[\\w.-]+(?:\\/[\\w.-]+)+" + // paths
      "|\\bv?\\d+\\.\\d+(?:\\.\\d+)+\\b" + // versions
      "|\\b[A-Za-z]+_[A-Za-z0-9_]+\\b)", // snake_case identifiers
  ].join("|"), "gu");
  const KIND_BY_GROUP = ["f", "f", "f", "u", "u", "f", "c", "t", "t"];

  function tokenSuffix(n, original) {
    let h = 2166136261 ^ n;
    for (let i = 0; i < original.length; i++) h = Math.imul(h ^ original.charCodeAt(i), 16777619);
    return ((h >>> 0) % 46656).toString(36).padStart(3, "0");
  }

  function protect(text) {
    const tokens = [];
    const src = String(text || "");
    const out = src.replace(PROTECT_RE, (...args) => {
      const original = args[0];
      let g = 1;
      while (g <= KIND_BY_GROUP.length && args[g] === undefined) g++;
      const n = tokens.length + 1;
      const token = `<${KIND_BY_GROUP[g - 1] || "t"}${n}-${tokenSuffix(n, original)}/>`;
      tokens.push({ token, original });
      return token;
    });
    return { text: out, tokens };
  }

  function normalizeTokens(text) {
    return String(text || "").replace(LENIENT_TOKEN_RE, (_m, body) => `<${body.toLowerCase()}/>`);
  }

  function tokenSequence(text) {
    return normalizeTokens(text).match(TOKEN_RE) || [];
  }

  /** Reason string when `output` lost, added, duplicated or reordered the source's placeholders; else null. */
  function checkPlaceholders(sourceProtected, outputProtected) {
    const want = tokenSequence(sourceProtected);
    const got = tokenSequence(outputProtected);
    if (want.length === got.length && want.every((t, i) => t === got[i])) return null;
    const missing = want.filter((t) => !got.includes(t));
    if (missing.length) return `placeholder lost: ${missing.join(" ")}`;
    const extra = got.filter((t) => !want.includes(t));
    if (extra.length) return `unknown placeholder: ${extra.join(" ")}`;
    if (want.length !== got.length) return "placeholder duplicated";
    return "placeholder reordered";
  }

  function restore(text, tokens) {
    const normalized = normalizeTokens(text);
    const reason = checkPlaceholders((tokens || []).map((t) => t.token).join(""), normalized);
    if (reason) {
      const e = new Error(reason);
      e.code = "placeholder";
      throw e;
    }
    const map = new Map((tokens || []).map((t) => [t.token, t.original]));
    return normalized.replace(TOKEN_RE, (t) => map.get(t));
  }

  // ---------------------------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------------------------
  const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/g;
  const EN_WORD_RE = /[A-Za-z][A-Za-z'-]{2,}/g;

  function plain(text) {
    return String(text || "").replace(TOKEN_RE, " ").replace(/\s+/g, " ").trim();
  }

  function looksLikeEnglishProse(text) {
    const s = plain(text);
    if (/https?:\/\/|@/.test(s)) return false;
    const words = s.match(EN_WORD_RE) || [];
    return words.length >= 8 && (s.match(/[A-Za-z]/g) || []).length >= 30;
  }

  /** Longest run of consecutive English words (data-dense numeric runs ignored) in a translated text. */
  function longestEnglishRun(text) {
    let best = 0;
    let cur = 0;
    for (const w of plain(text).split(/[\s　-〿，。、；：（）()]+/)) {
      if (/^[A-Za-z][A-Za-z'-]{1,}[.,;:]?$/.test(w)) { cur++; best = Math.max(best, cur); }
      else cur = 0;
    }
    return best;
  }

  const JUNK_RE = /```|^\s*\{\s*"translations"|"item_id"|"translated_text"|^\s*(?:translation|译文)\s*[:：]/i;

  /** Returns a failure reason or null. Both texts are in protected form (tokens still present). */
  function validateItem({ sourceProtected, outputProtected, decision, targetLang }) {
    const out = String(outputProtected || "");
    if (!plain(out)) return "empty output";
    if (JUNK_RE.test(out) && !JUNK_RE.test(sourceProtected)) return "protocol junk in translation";
    const ph = checkPlaceholders(sourceProtected, out);
    if (ph) return ph;
    if (isCJKTarget(targetLang) && looksLikeEnglishProse(sourceProtected)) {
      const cjk = (plain(out).match(CJK_RE) || []).length;
      const words = (plain(out).match(EN_WORD_RE) || []).length;
      if (decision === "keep_origin" || plain(out) === plain(sourceProtected)) return "english residue: untranslated";
      if (cjk < 2) return "english residue: no target-language text";
      if (longestEnglishRun(out) >= 12 || (words > 12 && cjk < words)) return "english residue: long English span";
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Batching
  // ---------------------------------------------------------------------------------------------
  /** Group by page (never mixing pages); split a page when the char budget or item cap is exceeded. */
  function planBatches(units, { maxChars = MAX_BATCH_CHARS, maxItems = MAX_BATCH_ITEMS } = {}) {
    const batches = [];
    let cur = null;
    let chars = 0;
    for (const u of units) {
      const len = u.text.length;
      if (!cur || cur[0].page_idx !== u.page_idx || cur.length >= maxItems || (chars + len > maxChars && cur.length)) {
        cur = [];
        chars = 0;
        batches.push(cur);
      }
      cur.push(u);
      chars += len;
    }
    return batches;
  }

  // ---------------------------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------------------------
  function parseJSONLoose(raw) {
    let s = String(raw || "").trim();
    s = s.replace(/^<think>[\s\S]*?<\/think>/i, "").trim();
    try { return JSON.parse(s); } catch (_e) { /* fall through */ }
    const fence = s.match(/^\s*```(?:json)?\s*([\s\S]*?)```/i) || s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch (_e) { /* fall through */ }
    const start = s.search(/[{[]/);
    if (start < 0) return null;
    const open = s[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === "\"") inStr = false;
      }
      else if (c === "\"") inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_e) { return null; }
      }
    }
    return null;
  }

  /** → Map(item_id string → { text, decision }) */
  function parseResponse(raw) {
    const data = parseJSONLoose(raw);
    const map = new Map();
    if (!data) return map;
    let list = Array.isArray(data) ? data : (data.translations || data.items || data.results);
    if (!Array.isArray(list)) {
      if (list && typeof list === "object") {
        for (const [k, v] of Object.entries(list)) map.set(String(k), { text: typeof v === "string" ? v : v && v.translated_text, decision: "translate" });
      }
      return map;
    }
    for (const e of list) {
      if (!e || e.item_id == null) continue;
      const text = e.translated_text != null ? e.translated_text : e.translation;
      map.set(String(e.item_id), { text: typeof text === "string" ? text : "", decision: e.decision || "translate" });
    }
    return map;
  }

  // ---------------------------------------------------------------------------------------------
  // Translation
  // ---------------------------------------------------------------------------------------------
  function clip(text, n, fromEnd) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (s.length <= n) return s;
    return fromEnd ? "…" + s.slice(s.length - n) : s.slice(0, n) + "…";
  }

  function glossaryLines(glossary, text) {
    if (!glossary) return [];
    const entries = Array.isArray(glossary) ? glossary
      : Object.entries(glossary).map(([source, target]) => ({ source, target }));
    const lower = text.toLowerCase();
    return entries.filter((e) => e && e.source && e.target && lower.includes(String(e.source).toLowerCase()))
      .map((e) => `${e.source} => ${e.target}`);
  }

  async function requestBatch(entries, ctx, hints) {
    const { targetLang, signal, glossary } = ctx;
    if (signal && signal.aborted) throw abortError();
    const name = targetName(targetLang);
    const items = entries.map((e) => {
      const it = { item_id: String(e.unit.id), source_text: e.prot.text };
      if (e.before) it.context_before = e.before;
      if (e.after) it.context_after = e.after;
      if (hints && hints.get(e.unit.id)) it.retry_hint = hints.get(e.unit.id);
      return it;
    });
    const gl = glossaryLines(glossary, entries.map((e) => e.unit.text).join("\n"));
    const user = [
      fill(TASK_PROMPT, name),
      gl.length ? "术语表（必须遵守）：\n" + gl.join("\n") : "",
      ITEMS_MARKER + "\n" + JSON.stringify({ items }),
      OUTPUT_PROMPT,
    ].filter(Boolean).join("\n\n");
    const res = await DeepRead.LLM.complete({
      system: fill(SYSTEM_PROMPT, name) + "\n\n" + RULE_PROFILE,
      messages: [{ role: "user", content: user }],
      responseFormat: { type: "json_object" },
      temperature: 0.2,
      signal,
      config: ctx.config,
    });
    if (signal && signal.aborted) throw abortError();
    return parseResponse(res && res.content);
  }

  /** Runs one request for `entries`; returns { ok: Map(id → text), bad: Map(id → reason) }. */
  async function attempt(entries, ctx, hints) {
    const ok = new Map();
    const bad = new Map();
    let parsed;
    try {
      parsed = await requestBatch(entries, ctx, hints);
    }
    catch (e) {
      if (e && (e.name === "AbortError" || (ctx.signal && ctx.signal.aborted))) throw e.name === "AbortError" ? e : abortError();
      for (const en of entries) bad.set(en.unit.id, `request failed: ${(e && e.message) || e}`);
      return { ok, bad };
    }
    for (const en of entries) {
      const r = parsed.get(String(en.unit.id));
      if (!r) { bad.set(en.unit.id, "missing item in response"); continue; }
      const out = normalizeTokens(String(r.text || "").trim());
      const reason = validateItem({ sourceProtected: en.prot.text, outputProtected: out, decision: r.decision, targetLang: ctx.targetLang });
      if (reason) { bad.set(en.unit.id, reason); continue; }
      try { ok.set(en.unit.id, restore(out, en.prot.tokens)); }
      catch (e) { bad.set(en.unit.id, e.message); }
    }
    return { ok, bad };
  }

  async function translateUnits(units, opts = {}) {
    const { targetLang = "zh", onProgress, signal, glossary } = opts;
    let concurrency = opts.concurrency;
    let config = opts.config;
    if (!concurrency) {
      try { config = config || DeepRead.prefs.llmConfig(); concurrency = config.concurrency; } catch (_e) { /* ignore */ }
    }
    concurrency = Math.max(1, concurrency || 4);
    const ctx = { targetLang, signal, glossary, config };

    const translations = new Map();
    const failures = [];
    const total = units.length;
    let done = 0;
    const report = (message) => { if (onProgress) onProgress({ done, total, message }); };

    // Neighbour context: previous/next unit on the same page.
    const entryOf = new Map();
    units.forEach((u, i) => {
      const prev = units[i - 1];
      const next = units[i + 1];
      entryOf.set(u, {
        unit: u,
        prot: protect(u.text),
        before: prev && prev.page_idx === u.page_idx ? clip(prev.text, CONTEXT_CHARS, true) : "",
        after: next && next.page_idx === u.page_idx ? clip(next.text, CONTEXT_CHARS, false) : "",
      });
    });

    const finish = (id, text) => { translations.set(id, text); done++; };
    const fail = (unit, reason) => {
      translations.set(unit.id, unit.text);
      failures.push({ id: unit.id, reason });
      done++;
    };

    async function runBatch(batch) {
      const entries = batch.map((u) => entryOf.get(u));
      let { ok, bad } = await attempt(entries, ctx);
      for (const [id, text] of ok) finish(id, text);
      report(`${done}/${total}`);
      // Retry failed items individually (smaller batches), keeping the reason as a hint.
      for (const en of entries.filter((e) => bad.has(e.unit.id))) {
        let reason = bad.get(en.unit.id);
        let success = false;
        for (let n = 0; n < RETRY_ATTEMPTS && !success; n++) {
          const r = await attempt([en], ctx, new Map([[en.unit.id, `上一次译文未通过校验（${reason}），请严格按要求重译`]]));
          if (r.ok.has(en.unit.id)) { finish(en.unit.id, r.ok.get(en.unit.id)); success = true; }
          else reason = r.bad.get(en.unit.id) || reason;
        }
        if (!success) fail(en.unit, reason);
        report(`${done}/${total}`);
      }
    }

    const batches = planBatches(units);
    report("start");
    let next = 0;
    let firstError = null;
    const worker = async () => {
      while (!firstError && next < batches.length) {
        if (signal && signal.aborted) throw abortError();
        const b = batches[next++];
        try { await runBatch(b); }
        catch (e) { firstError = firstError || e; throw e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (firstError) throw firstError;

    // Order failures by unit order for determinism.
    const rank = new Map(units.map((u, i) => [u.id, i]));
    failures.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return { translations, failures };
  }

  DeepRead.Translator = {
    buildUnits, protect, restore, planBatches, translateUnits, validateItem, checkPlaceholders,
    parseResponse, isCJKTarget, targetName,
    SYSTEM_PROMPT, TASK_PROMPT, OUTPUT_PROMPT, RULE_PROFILE, ITEMS_MARKER,
  };
})();
