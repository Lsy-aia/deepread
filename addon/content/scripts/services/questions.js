/*
 * Questions: "question-led reading". Answers five standard questions about the paper from the reader's
 * paragraph blocks, and answers free questions, each with the block keys that hold the evidence.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const GENERATE_MARKER = "Paper blocks (JSON):";
  const ASK_MARKER = "Question to answer:";
  const DEFAULT_MAX_CHARS = 60000;
  const MAX_TEXT = 600;
  const MAX_CONTEXT_CHARS = 3000;
  const MAX_QUESTION_CHARS = 600;
  const MAX_KEYS = 4;

  const STANDARD = [
    { id: "q1", zh: "要解决什么问题？", en: "What problem does it solve?" },
    { id: "q2", zh: "方法的核心是什么？", en: "What is the core of the method?" },
    { id: "q3", zh: "关键设计有哪些？", en: "What are the key design choices?" },
    { id: "q4", zh: "证据是否充分？", en: "Is the evidence convincing?" },
    { id: "q5", zh: "局限是什么？", en: "What are the limitations?" },
  ];

  const SYSTEM_PROMPT = [
    "You help a reader read an academic paper by answering questions about it.",
    "You are given the paper as a list of blocks (one per paragraph): key, label (page and paragraph), role, summary and explanation; text is given only for blocks that have no summary or explanation.",
    "Answer only from the blocks. Do not add facts the paper does not support, and say so when the paper does not answer.",
    "Every answer cites the keys of the blocks that contain it, copied exactly as given and listed in reading order.",
    "Return only a JSON object.",
  ].join("\n");

  const GENERATE_PROMPT = [
    "Answer the five standard questions below for THIS paper.",
    "- q1: What problem does it solve?",
    "- q2: What is the core of the method?",
    "- q3: What are the key design choices?",
    "- q4: Is the evidence convincing?",
    "- q5: What are the limitations?",
    "Respond with JSON only, in exactly this shape:",
    "{\"questions\":[{\"id\":\"q1\",\"question\":\"<the question>\",\"answer\":\"<answer>\",\"keys\":[\"<block key>\"]}]}",
    "Rules:",
    "- One entry for each of q1 to q5, in this order.",
    "- question: the standard question, optionally sharpened for this paper; at most 12 words (or 30 characters for Chinese, Japanese or Korean).",
    "- answer: 2 to 4 sentences grounded only in the blocks. Markdown is allowed; write math as $...$.",
    "- keys: 1 to 4 keys of the blocks that contain the answer, in reading order.",
  ].join("\n");

  const ASK_PROMPT = [
    "Answer the reader's question using only the paper blocks below.",
    "Respond with JSON only, in exactly this shape:",
    "{\"answer\":\"<answer>\",\"keys\":[\"<block key>\"]}",
    "Rules:",
    "- answer: 2 to 5 sentences. Markdown is allowed; write math as $...$.",
    "- keys: 1 to 4 keys of the blocks that contain the answer, in reading order.",
    "- If the paper does not answer the question, say so briefly in the answer and return an empty keys array.",
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
    return `${SYSTEM_PROMPT}\nWrite all questions and answers in ${languageInstruction(targetLang)}.`;
  }

  function standardText(std, targetLang) {
    return /^zh/i.test(String(targetLang || "zh")) ? std.zh : std.en;
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

  function keyList(blocks) {
    return (blocks || []).map((b) => str(b && b.key)).filter(Boolean);
  }

  function parseJson(content) {
    let s = String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      return JSON.parse(s);
    }
    catch (e) {
      for (const [open, close] of [["{", "}"], ["[", "]"]]) {
        const a = s.indexOf(open);
        const b = s.lastIndexOf(close);
        if (a < 0 || b <= a) continue;
        try {
          return JSON.parse(s.slice(a, b + 1));
        }
        catch (e2) { /* try next shape */ }
      }
    }
    return null;
  }

  /** Valid keys only, deduped, in reading order (the order of `blocks`), at most MAX_KEYS. */
  function cleanKeys(raw, blocks) {
    const order = new Map(keyList(blocks).map((k, i) => [k, i]));
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const keys = [...new Set(list.map(str).filter((k) => order.has(k)))];
    keys.sort((a, b) => order.get(a) - order.get(b));
    return keys.slice(0, MAX_KEYS);
  }

  function fallback(std, targetLang) {
    return { id: std.id, question: standardText(std, targetLang), answer: "", keys: [] };
  }

  /** Reply of generate() → [{ id, question, answer, keys }] in q1..q5 order; invalid entries are filled from STANDARD. */
  function parse(content, blocks, targetLang) {
    const value = parseJson(content);
    let list = [];
    if (Array.isArray(value)) list = value;
    else if (value && typeof value === "object") {
      if (Array.isArray(value.questions)) list = value.questions;
      else if (Array.isArray(value.answers)) list = value.answers;
    }
    const byId = new Map();
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      const id = str(it.id).toLowerCase();
      if (!byId.has(id)) byId.set(id, it);
    }
    return STANDARD.map((std) => {
      const it = byId.get(std.id);
      const answer = it ? str(it.answer) : "";
      if (!it || !answer) return fallback(std, targetLang);
      return {
        id: std.id,
        question: str(it.question) || standardText(std, targetLang),
        answer,
        keys: cleanKeys(it.keys, blocks),
      };
    });
  }

  /** Reply of ask() → { answer, keys }. */
  function parseAnswer(content, blocks) {
    const value = parseJson(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { answer: "", keys: [] };
    return { answer: str(value.answer), keys: cleanKeys(value.keys, blocks) };
  }

  function contextPart(paperContext) {
    return str(paperContext) ? [`Paper context:\n${str(paperContext).slice(0, MAX_CONTEXT_CHARS)}`] : [];
  }

  async function complete(userContent, opts) {
    const res = await DeepRead.LLM.complete({
      system: systemPrompt(opts.targetLang),
      messages: [{ role: "user", content: userContent }],
      responseFormat: { type: "json_object" },
      temperature: 0.3,
      signal: opts.signal,
      config: opts.config,
    });
    return res && res.content;
  }

  /** `run()` → parsed value; retried once on a (non-abort) failure. */
  async function withRetry(run, opts) {
    throwIfAborted(opts.signal);
    try {
      return await run();
    }
    catch (e) {
      if (isAbort(e, opts.signal)) throw abortError();
      DeepRead.log?.("questions request failed, retrying:", e?.message || e);
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

  /** → [{ id, question, answer, keys }] for q1..q5. */
  async function generate(opts = {}) {
    const blocks = opts.blocks || [];
    const items = budgetBlocks(blocks, opts.maxChars);
    const user = [...contextPart(opts.paperContext), GENERATE_PROMPT, `${GENERATE_MARKER}\n${JSON.stringify({ blocks: items })}`].join("\n\n");
    const result = await withRetry(async () => parse(await complete(user, opts), blocks, opts.targetLang), opts);
    if (!result.some((r) => r.answer)) throw new Error("The model returned no answers");
    return result;
  }

  /** → { answer, keys }. */
  async function ask(question, opts = {}) {
    const q = str(question).slice(0, MAX_QUESTION_CHARS);
    if (!q) throw new Error("Empty question");
    const blocks = opts.blocks || [];
    const items = budgetBlocks(blocks, opts.maxChars);
    const user = [
      ...contextPart(opts.paperContext),
      ASK_PROMPT,
      `${ASK_MARKER}\n${q}`,
      `${GENERATE_MARKER}\n${JSON.stringify({ blocks: items })}`,
    ].join("\n\n");
    const result = await withRetry(async () => parseAnswer(await complete(user, opts), blocks), opts);
    if (!result.answer) throw new Error("The model returned no answer");
    return result;
  }

  DeepRead.Questions = {
    STANDARD,
    SYSTEM_PROMPT,
    generate,
    ask,
    _parse: parse,
    _parseAnswer: parseAnswer,
    _budgetBlocks: budgetBlocks,
  };
})();
