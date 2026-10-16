/*
 * Guided-reading panel view (module "guide"): renders the 带读 guide JSON (see DeepRead.Guide) as a header,
 * five step tabs and the body of the active step. Pure view: everything that touches the outside world goes
 * through the `actions` callbacks.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const B = (zh, en) => DeepRead.bilingual(zh, en);

  const CSS = `
.deepread-guide { box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; color: #1d1d1b; background: #fff;
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
.deepread-guide * { box-sizing: border-box; }
.deepread-guide button { font: inherit; cursor: pointer; }
.deepread-guide .dg-head { flex-shrink: 0; padding: 10px 12px 6px; border-bottom: 1px solid rgba(0,0,0,0.1); }
.deepread-guide .dg-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.deepread-guide .dg-title { font-size: 15px; font-weight: 700; }
.deepread-guide .dg-status { flex: 1; min-width: 0; color: #59647a; font-size: 12px; }
.deepread-guide .dg-btn { border: 1px solid rgba(0,0,0,0.18); background: #fff; color: inherit; border-radius: 5px; padding: 2px 8px; font-size: 12px; }
.deepread-guide .dg-btn:hover { background: #f1f2f5; }
.deepread-guide .dg-btn.dg-primary { background: #2b59c3; border-color: #2b59c3; color: #fff; }
.deepread-guide .dg-btn.dg-primary:hover { background: #244ba5; }
.deepread-guide .dg-x { border: none; background: transparent; color: #59647a; font-size: 16px; line-height: 1; padding: 0 4px; }
.deepread-guide .dg-meta { margin-top: 3px; color: #7c8597; font-size: 11px; }
.deepread-guide .dg-tabs { display: flex; gap: 2px; margin-top: 8px; }
.deepread-guide .dg-tab { position: relative; flex: 1; border: none; border-radius: 5px; padding: 4px 2px; background: #eef0f4; color: #3a3f4c; font-size: 12px; }
.deepread-guide .dg-tab[aria-selected="true"] { background: #2b59c3; color: #fff; font-weight: 600; }
.deepread-guide .dg-dot { display: inline-block; width: 5px; height: 5px; margin-inline-start: 3px; border-radius: 50%; background: #0f766e; vertical-align: middle; }
.deepread-guide .dg-tab[aria-selected="true"] .dg-dot { background: #fff; }
.deepread-guide .dg-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 18px; }
.deepread-guide h4 { margin: 14px 0 6px; font-size: 12.5px; font-weight: 700; color: #3a3f4c; }
.deepread-guide h4:first-child { margin-top: 0; }
.deepread-guide p { margin: 4px 0; }
.deepread-guide .dg-sub { color: #59647a; font-size: 12px; }
.deepread-guide .dg-tag { display: inline-block; border-radius: 4px; padding: 0 6px; font-size: 11px; line-height: 17px; background: #eef0f4; color: #3a3f4c; white-space: nowrap; }
.deepread-guide .dg-tag.dg-type { background: #e3eafa; color: #1e428f; font-weight: 600; }
.deepread-guide .dg-role-background { background: #eef0f4; color: #3a3f4c; }
.deepread-guide .dg-role-gap { background: #fce9dd; color: #9a3412; }
.deepread-guide .dg-role-prior { background: #f3eee6; color: #6b4e1e; }
.deepread-guide .dg-role-contribution, .deepread-guide .dg-role-claim { background: #2b59c3; color: #fff; }
.deepread-guide .dg-role-method { background: #e3eafa; color: #1e428f; }
.deepread-guide .dg-role-evidence { background: #e0f1ee; color: #0b5550; }
.deepread-guide .dg-role-limitation { background: #f8e6e6; color: #8a1c1c; }
.deepread-guide .dg-v-load-bearing { background: #2b59c3; color: #fff; }
.deepread-guide .dg-v-contributing { background: #e3eafa; color: #1e428f; }
.deepread-guide .dg-v-decorative { background: #eef0f4; color: #59647a; }
.deepread-guide .dg-v-unestablished { background: #fce9dd; color: #9a3412; }
.deepread-guide .dg-v-pending { background: #f3eee6; color: #6b4e1e; }
.deepread-guide .dg-s-strong { background: #f8e6e6; color: #8a1c1c; }
.deepread-guide .dg-s-hedged { background: #eef0f4; color: #3a3f4c; }
.deepread-guide .dg-s-speculative { background: #f3eee6; color: #6b4e1e; }
.deepread-guide .dg-s-outlook { background: #e3eafa; color: #1e428f; }
.deepread-guide .dg-e-changes { background: #f8e6e6; color: #8a1c1c; }
.deepread-guide .dg-e-weakens { background: #fce9dd; color: #9a3412; }
.deepread-guide .dg-e-scopes { background: #f3eee6; color: #6b4e1e; }
.deepread-guide .dg-e-wording { background: #eef0f4; color: #3a3f4c; }
.deepread-guide .dg-b-source { background: #e0f1ee; color: #0b5550; }
.deepread-guide .dg-b-inference { background: #f3eee6; color: #6b4e1e; }
.deepread-guide .dg-b-pending { background: #eef0f4; color: #59647a; }
.deepread-guide .dg-st-proven { color: #0b5550; }
.deepread-guide .dg-st-partial { color: #b45309; }
.deepread-guide .dg-st-unproven { color: #8a1c1c; }
.deepread-guide .dg-st-pending { color: #7c8597; }
.deepread-guide .dg-chips { display: inline-flex; flex-wrap: wrap; gap: 3px; margin-inline-start: 4px; vertical-align: baseline; }
.deepread-guide .dg-chip { border: 1px solid rgba(43,89,195,0.35); border-radius: 9px; padding: 0 6px; background: #f4f7fd; color: #1e428f; font-size: 10.5px; line-height: 15px; }
.deepread-guide .dg-chip:hover { background: #e3eafa; }
.deepread-guide ul, .deepread-guide ol { margin: 4px 0; padding-inline-start: 20px; }
.deepread-guide li { margin: 3px 0; }
.deepread-guide .dg-q { color: #5b21b6; }
.deepread-guide .dg-q::marker { color: #7c3aed; font-weight: 700; }
.deepread-guide .dg-row { display: flex; gap: 6px; align-items: baseline; margin: 5px 0; }
.deepread-guide .dg-row .dg-tag { flex-shrink: 0; min-width: 44px; text-align: center; }
.deepread-guide .dg-row .dg-text { flex: 1; min-width: 0; }
.deepread-guide .dg-mark { flex-shrink: 0; font-size: 11px; font-weight: 600; }
.deepread-guide table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 4px 0; }
.deepread-guide th { text-align: start; color: #59647a; font-weight: 600; padding: 3px 5px; border-bottom: 1px solid rgba(0,0,0,0.15); }
.deepread-guide td { padding: 4px 5px; vertical-align: top; border-bottom: 1px solid rgba(0,0,0,0.07); }
.deepread-guide .dg-legend { color: #7c8597; font-size: 11px; margin: 3px 0 0; }
.deepread-guide .dg-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 7px; padding: 8px 10px; margin: 6px 0; background: #fafafa; }
.deepread-guide .dg-card.dg-idea { border-inline-start: 3px solid #d97706; }
.deepread-guide .dg-card .dg-ct { font-weight: 700; margin-bottom: 3px; }
.deepread-guide .dg-card dl { margin: 4px 0 0; }
.deepread-guide .dg-card dt { font-size: 11px; color: #7c8597; margin-top: 4px; }
.deepread-guide .dg-card dd { margin: 0; }
.deepread-guide .dg-formula { overflow-x: auto; padding: 4px 0; text-align: center; }
.deepread-guide .dg-layer { border-inline-start: 3px solid #cdd3de; padding: 2px 8px; margin: 6px 0; }
.deepread-guide .dg-layer b { display: block; font-size: 11px; color: #59647a; }
.deepread-guide .dg-check { display: flex; gap: 6px; align-items: baseline; margin: 4px 0; }
.deepread-guide .dg-cs-open { color: #7c8597; }
.deepread-guide .dg-cs-ok { color: #0b5550; }
.deepread-guide .dg-cs-problem { color: #9a3412; font-weight: 700; }
.deepread-guide .dg-quote { margin: 5px 0; }
.deepread-guide .dg-quote q { font-style: italic; }
.deepread-guide .dg-note { color: #7c8597; font-size: 11px; }
.deepread-guide .dg-progress { border: 1px solid rgba(0,0,0,0.12); border-radius: 7px; padding: 10px; background: #f6f7fa; }
.deepread-guide .dg-log { margin: 8px 0; padding: 6px 8px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  border-radius: 5px; background: #1d1d1b; color: #d6d6d0; font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace; }
.deepread-guide .dg-err { color: #8a1c1c; background: #f8e6e6; border-radius: 6px; padding: 8px 10px; margin: 6px 0; white-space: pre-wrap; }
.deepread-guide .dg-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
.deepread-guide .dg-index { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px; }
.deepread-guide .dg-md { margin: 4px 0; }
:root[data-color-scheme="dark"] .deepread-guide { color: #e6e6e1; background: #232326; }
:root[data-color-scheme="dark"] .deepread-guide .dg-head { border-bottom-color: rgba(255,255,255,0.14); }
:root[data-color-scheme="dark"] .deepread-guide .dg-btn { background: #2d2d31; border-color: rgba(255,255,255,0.2); }
:root[data-color-scheme="dark"] .deepread-guide .dg-btn:hover { background: #38383d; }
:root[data-color-scheme="dark"] .deepread-guide .dg-tab, :root[data-color-scheme="dark"] .deepread-guide .dg-tag { background: #34363d; color: #d6d8df; }
:root[data-color-scheme="dark"] .deepread-guide .dg-tab[aria-selected="true"] { background: #2b59c3; color: #fff; }
:root[data-color-scheme="dark"] .deepread-guide h4 { color: #c9ccd4; }
:root[data-color-scheme="dark"] .deepread-guide .dg-tag.dg-type, :root[data-color-scheme="dark"] .deepread-guide .dg-role-method, :root[data-color-scheme="dark"] .deepread-guide .dg-v-contributing, :root[data-color-scheme="dark"] .deepread-guide .dg-s-outlook { background: #243459; color: #bcd0f7; }
:root[data-color-scheme="dark"] .deepread-guide .dg-role-gap, :root[data-color-scheme="dark"] .deepread-guide .dg-v-unestablished, :root[data-color-scheme="dark"] .deepread-guide .dg-e-weakens { background: #4a2a18; color: #fdba8c; }
:root[data-color-scheme="dark"] .deepread-guide .dg-role-prior, :root[data-color-scheme="dark"] .deepread-guide .dg-v-pending, :root[data-color-scheme="dark"] .deepread-guide .dg-s-speculative, :root[data-color-scheme="dark"] .deepread-guide .dg-e-scopes, :root[data-color-scheme="dark"] .deepread-guide .dg-b-inference { background: #3f3524; color: #e6cd9a; }
:root[data-color-scheme="dark"] .deepread-guide .dg-role-evidence, :root[data-color-scheme="dark"] .deepread-guide .dg-b-source { background: #17403c; color: #8fd8cf; }
:root[data-color-scheme="dark"] .deepread-guide .dg-role-limitation, :root[data-color-scheme="dark"] .deepread-guide .dg-s-strong, :root[data-color-scheme="dark"] .deepread-guide .dg-e-changes, :root[data-color-scheme="dark"] .deepread-guide .dg-err { background: #4a2326; color: #f1a9a9; }
:root[data-color-scheme="dark"] .deepread-guide .dg-chip { background: #243459; border-color: rgba(138,170,240,0.4); color: #bcd0f7; }
:root[data-color-scheme="dark"] .deepread-guide .dg-card, :root[data-color-scheme="dark"] .deepread-guide .dg-progress { background: #2a2a2e; border-color: rgba(255,255,255,0.14); }
:root[data-color-scheme="dark"] .deepread-guide .dg-q { color: #c4a5fb; }
:root[data-color-scheme="dark"] .deepread-guide th { border-bottom-color: rgba(255,255,255,0.2); }
:root[data-color-scheme="dark"] .deepread-guide td { border-bottom-color: rgba(255,255,255,0.1); }
:root[data-color-scheme="dark"] .deepread-guide .dg-st-proven, :root[data-color-scheme="dark"] .deepread-guide .dg-cs-ok { color: #6fd0c4; }
:root[data-color-scheme="dark"] .deepread-guide .dg-st-partial { color: #fbbf24; }
:root[data-color-scheme="dark"] .deepread-guide .dg-cs-problem, :root[data-color-scheme="dark"] .deepread-guide .dg-st-unproven { color: #fdba8c; }
`;

  function el(doc, tag, cls, text) {
    const node = doc.createElementNS(HTML_NS, tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const arr = (x) => (Array.isArray(x) ? x : []);

  // ---- label helpers ----
  function pick(map, v, fallback) {
    const hit = Object.prototype.hasOwnProperty.call(map, v) ? map[v] : null;
    if (hit) return B(hit[0], hit[1]);
    return v === undefined || v === null || v === "" ? (fallback || "") : String(v);
  }
  const verdictLabel = (v) => pick({
    "load-bearing": ["承重", "Load-bearing"], contributing: ["贡献", "Contributing"], decorative: ["装饰", "Decorative"],
    unestablished: ["未确立", "Unestablished"], pending: ["待定", "Pending"],
  }, v);
  const statusLabel = (s) => pick({
    proven: ["● 已证", "● Proven"], partial: ["◐ 部分", "◐ Partial"], unproven: ["✕ 未证", "✕ Unproven"], pending: ["○ 待读", "○ To read"],
  }, s);
  const strengthLabel = (s) => pick({
    strong: ["强断言", "Strong claim"], hedged: ["保留", "Hedged"], speculative: ["推测", "Speculative"], outlook: ["展望", "Outlook"],
  }, s);
  const basisLabel = (b) => pick({
    source: ["原文", "Source"], inference: ["推断", "Inference"], pending: ["待读", "To read"],
  }, b);
  const effectLabel = (e) => pick({
    changes: ["改变结论", "Changes the conclusion"], weakens: ["削弱结论", "Weakens the conclusion"],
    scopes: ["限定范围", "Limits the scope"], wording: ["仅表述问题", "Wording only"],
  }, e);
  const roleLabel = (r) => pick({
    background: ["背景", "Background"], gap: ["空白", "Gap"], prior: ["已有方案", "Prior work"], contribution: ["贡献", "Contribution"],
    claim: ["主张", "Claim"], evidence: ["证据", "Evidence"], limitation: ["局限", "Limitation"],
  }, r);
  const typeLabel = (t) => pick({
    algorithmic: ["算法类", "Algorithmic"], methods: ["方法类", "Methods"], hypothesis: ["假说类", "Hypothesis"], research: ["研究类", "Research"],
    review: ["综述类", "Review"], resource: ["资源类", "Resource"], clinical: ["临床类", "Clinical"], other: ["其他", "Other"],
  }, t);

  function keyLabel(key) {
    const m = /^p_(\d+)_(\d+)$/.exec(String(key || ""));
    return m ? `p. ${Number(m[1]) + 1} ¶${Number(m[2]) + 1}` : String(key || "");
  }

  function stepCounts(guide) {
    const g = guide || {};
    const n = (x) => arr(x).length;
    const p = g.position || {}, s = g.skeleton || {}, m = g.method || {}, e = g.evidence || {}, t = g.takeaway || {};
    return [
      n(p.path) + n(p.focus) + n(p.order) + n(p.questions) + (p.claim ? 1 : 0),
      n(s.moves) + n(s.terms),
      n(m.components) + n(m.formulas) + (m.insight && (m.insight.surface || m.insight.core || m.insight.transferable) ? 1 : 0),
      n(e.chain) + n(e.checks) + n(e.hedges),
      n(t.learned) + n(t.ideas) + (t.summary ? 1 : 0) + (g.markdown && g.markdown.card ? 1 : 0),
    ];
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? B(`${m} 分 ${s} 秒`, `${m} min ${s} s`) : B(`${s} 秒`, `${s} s`);
  }
  function fmtTime(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function lastLines(text, n) {
    return String(text || "").split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
  }

  // ---- building blocks ----
  function btn(doc, label, onClick, cls) {
    const b = el(doc, "button", "dg-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("click", (ev) => { ev.preventDefault(); onClick && onClick(); });
    return b;
  }
  function chips(doc, keys, actions) {
    const list = arr(keys);
    if (!list.length) return null;
    const wrap = el(doc, "span", "dg-chips");
    for (const key of list) {
      const c = el(doc, "button", "dg-chip", keyLabel(key));
      c.type = "button";
      c.addEventListener("click", (ev) => { ev.preventDefault(); actions.openBlock && actions.openBlock(key); });
      wrap.appendChild(c);
    }
    return wrap;
  }
  function inline(doc, parent, text) {
    try {
      const node = DeepRead.Overlay.inlineMarkdown(doc, String(text || ""));
      if (node) { parent.appendChild(node); return parent; }
    }
    catch (e) {}
    parent.appendChild(doc.createTextNode(String(text || "")));
    return parent;
  }
  function md(doc, text, cls) {
    const box = el(doc, "div", cls || "dg-md");
    try {
      const node = DeepRead.Markdown.render(doc, String(text || ""));
      if (node) { box.appendChild(node); return box; }
    }
    catch (e) {}
    box.textContent = String(text || "");
    return box;
  }
  function h4(doc, parent, zh, en) {
    parent.appendChild(el(doc, "h4", "", B(zh, en)));
  }
  function tag(doc, cls, text) {
    return el(doc, "span", "dg-tag " + cls, text);
  }
  function table(doc, heads) {
    const t = el(doc, "table");
    const tr = el(doc, "tr");
    for (const h of heads) tr.appendChild(el(doc, "th", "", h));
    const thead = el(doc, "thead");
    thead.appendChild(tr);
    t.appendChild(thead);
    const tbody = el(doc, "tbody");
    t.appendChild(tbody);
    t._body = tbody;
    return t;
  }
  function tr(doc, t, cells) {
    const row = el(doc, "tr");
    for (const c of cells) {
      const td = el(doc, "td");
      if (typeof c === "string") inline(doc, td, c);
      else if (Array.isArray(c)) c.filter(Boolean).forEach((n) => td.appendChild(n));
      else if (c) td.appendChild(c);
      row.appendChild(td);
    }
    t._body.appendChild(row);
  }
  function lineWithChips(doc, parent, text, keys, actions) {
    inline(doc, parent, text);
    const c = chips(doc, keys, actions);
    if (c) parent.appendChild(c);
  }

  // ---- step bodies ----
  function stepPosition(doc, body, g, actions) {
    const p = g.position || {};
    if (g.type || arr(p.focus).length) {
      const box = el(doc, "div");
      if (g.type) {
        box.appendChild(tag(doc, "dg-type", typeLabel(g.type)));
        box.appendChild(doc.createTextNode(" "));
      }
      if (arr(p.focus).length) {
        box.appendChild(el(doc, "span", "dg-sub", B("读这类论文，重点看：", "For this kind of paper, watch for: ")));
        const ul = el(doc, "ul");
        for (const f of p.focus) inline(doc, ul.appendChild(el(doc, "li")), f);
        box.appendChild(ul);
      }
      body.appendChild(box);
    }
    if (p.claim) {
      h4(doc, body, "这篇真正主张什么", "What the paper really claims");
      inline(doc, body.appendChild(el(doc, "p")), p.claim);
    }
    if (arr(p.path).length) {
      h4(doc, body, "研究路径还原", "Research path, reconstructed");
      const ol = el(doc, "ol");
      for (const it of p.path) {
        const li = el(doc, "li");
        if (it.step) li.appendChild(el(doc, "b", "", it.step + " "));
        if (it.basis) { li.appendChild(tag(doc, "dg-b-" + it.basis, basisLabel(it.basis))); li.appendChild(doc.createTextNode(" ")); }
        lineWithChips(doc, li, it.text, it.keys, actions);
        ol.appendChild(li);
      }
      body.appendChild(ol);
    }
    if (arr(p.order).length) {
      h4(doc, body, "建议阅读顺序", "Suggested reading order");
      const ol = el(doc, "ol");
      for (const it of p.order) {
        const li = el(doc, "li");
        lineWithChips(doc, li, it.text, it.keys, actions);
        if (it.minutes) li.appendChild(el(doc, "span", "dg-sub", `  ${it.minutes} ${B("分钟", "min")}`));
        ol.appendChild(li);
      }
      body.appendChild(ol);
    }
    if (arr(p.questions).length) {
      h4(doc, body, `带着 ${p.questions.length} 个问题读`, `Read with ${p.questions.length} question${p.questions.length === 1 ? "" : "s"} in mind`);
      const ol = el(doc, "ol");
      for (const q of p.questions) inline(doc, ol.appendChild(el(doc, "li", "dg-q")), q);
      body.appendChild(ol);
    }
  }

  function stepSkeleton(doc, body, g, actions) {
    const s = g.skeleton || {};
    if (arr(s.moves).length) {
      h4(doc, body, "论证骨架", "Argument skeleton");
      for (const m of s.moves) {
        const row = el(doc, "div", "dg-row");
        row.appendChild(tag(doc, "dg-role-" + m.role, roleLabel(m.role)));
        const text = el(doc, "span", "dg-text");
        lineWithChips(doc, text, m.text, m.keys, actions);
        row.appendChild(text);
        if (m.status) row.appendChild(el(doc, "span", "dg-mark dg-st-" + m.status, statusLabel(m.status)));
        body.appendChild(row);
      }
    }
    if (arr(s.terms).length) {
      h4(doc, body, "术语账本", "Term ledger");
      const t = table(doc, [B("原文", "Original"), B("统一译名", "Unified translation"), B("变体", "Variants")]);
      for (const x of s.terms) tr(doc, t, [x.term || "", x.translation || "", arr(x.variants).join("、")]);
      body.appendChild(t);
    }
  }

  function stepMethod(doc, body, g, actions) {
    const m = g.method || {};
    if (arr(m.components).length) {
      h4(doc, body, "部件承重判断", "Which parts bear the load");
      const t = table(doc, [B("部件", "Part"), B("判断", "Verdict"), B("依据", "Basis")]);
      for (const c of m.components) {
        const basis = el(doc, "span");
        lineWithChips(doc, basis, c.basis, c.keys, actions);
        tr(doc, t, [c.name || "", tag(doc, "dg-v-" + c.verdict, verdictLabel(c.verdict)), basis]);
      }
      body.appendChild(t);
      body.appendChild(el(doc, "p", "dg-legend", B(
        "承重 去掉就塌 · 贡献 去掉变弱 · 装饰 去掉无妨 · 未确立 论文没做隔离对照",
        "Load-bearing: remove it and it collapses · Contributing: weaker without it · Decorative: harmless to drop · Unestablished: the paper ran no isolating control")));
    }
    const ins = m.insight;
    if (ins && (ins.surface || ins.core || ins.transferable)) {
      h4(doc, body, "核心思想三层", "The core idea in three layers");
      for (const [k, zh, en] of [["surface", "表层方法", "Surface method"], ["core", "核心洞见", "Core insight"], ["transferable", "可迁移经验", "Transferable lesson"]]) {
        if (!ins[k]) continue;
        const layer = el(doc, "div", "dg-layer");
        layer.appendChild(el(doc, "b", "", B(zh, en)));
        inline(doc, layer, ins[k]);
        body.appendChild(layer);
      }
    }
    if (arr(m.formulas).length) {
      h4(doc, body, "公式手算", "Formulas by hand");
      for (const f of m.formulas) {
        const card = el(doc, "div", "dg-card");
        if (f.purpose) {
          card.appendChild(el(doc, "div", "dg-sub", B("先说用途", "What it is for")));
          inline(doc, card.appendChild(el(doc, "p")), f.purpose);
        }
        if (f.latex) {
          const latex = String(f.latex).trim();
          card.appendChild(md(doc, /^\$\$/.test(latex) ? latex : `$$${latex}$$`, "dg-formula"));
        }
        if (arr(f.symbols).length) {
          const t = table(doc, [B("符号", "Symbol"), B("形状", "Shape"), B("含义", "Meaning")]);
          for (const sy of f.symbols) tr(doc, t, [sy.symbol ? `$${sy.symbol}$` : "", sy.shape || "", sy.meaning || ""]);
          card.appendChild(t);
        }
        if (f.example) {
          card.appendChild(el(doc, "div", "dg-sub", B("带数字的例子", "Worked example")));
          card.appendChild(md(doc, f.example));
        }
        const c = chips(doc, f.keys, actions);
        if (c) card.appendChild(c);
        body.appendChild(card);
      }
    }
  }

  function stepEvidence(doc, body, g, actions) {
    const e = g.evidence || {};
    if (arr(e.chain).length) {
      h4(doc, body, "证据链 · 结论能说到哪一步", "Evidence chain · how far the conclusion goes");
      const t = table(doc, [B("主张", "Claim"), B("证据与条件", "Evidence and conditions"), B("能支持", "Supports"), B("不能支持", "Does not support"), B("状态", "Status")]);
      for (const c of e.chain) {
        const ev = el(doc, "span");
        lineWithChips(doc, ev, c.evidence, c.keys, actions);
        tr(doc, t, [c.claim || "", ev, c.supports || "", c.notSupports || "",
          c.status ? el(doc, "span", "dg-mark dg-st-" + c.status, statusLabel(c.status)) : ""]);
      }
      body.appendChild(t);
    }
    if (arr(e.checks).length) {
      h4(doc, body, "边界检查", "Boundary checks");
      for (const c of e.checks) {
        const row = el(doc, "div", "dg-check");
        const st = c.state === "ok" ? "✓" : c.state === "problem" ? "!" : "○";
        row.appendChild(el(doc, "span", "dg-cs-" + (c.state === "ok" || c.state === "problem" ? c.state : "open"), st));
        const text = el(doc, "span", "dg-text");
        inline(doc, text, c.text);
        text.appendChild(doc.createTextNode(" "));
        if (c.effect) text.appendChild(tag(doc, "dg-e-" + c.effect, effectLabel(c.effect)));
        row.appendChild(text);
        body.appendChild(row);
      }
    }
    if (arr(e.hedges).length) {
      h4(doc, body, "措辞强度", "Strength of wording");
      body.appendChild(el(doc, "p", "dg-note", B("不把「可能」读成「确实」", "Don't read \"may\" as \"does\"")));
      for (const h of e.hedges) {
        const row = el(doc, "div", "dg-quote");
        if (h.strength) { row.appendChild(tag(doc, "dg-s-" + h.strength, strengthLabel(h.strength))); row.appendChild(doc.createTextNode(" ")); }
        row.appendChild(el(doc, "q", "", h.quote || ""));
        if (h.note) { row.appendChild(doc.createTextNode(" ")); inline(doc, row.appendChild(el(doc, "span", "dg-sub")), h.note); }
        const c = chips(doc, h.keys, actions);
        if (c) row.appendChild(c);
        body.appendChild(row);
      }
    }
  }

  function stepTakeaway(doc, body, g, actions) {
    const t = g.takeaway || {};
    if (t.summary) {
      h4(doc, body, "一句话总结", "In one sentence");
      inline(doc, body.appendChild(el(doc, "p")), t.summary);
    }
    if (arr(t.learned).length) {
      h4(doc, body, "学到的知识", "What you learned");
      const ul = el(doc, "ul");
      for (const x of t.learned) inline(doc, ul.appendChild(el(doc, "li")), x);
      body.appendChild(ul);
    }
    if (arr(t.ideas).length) {
      h4(doc, body, "研究想法 · AI 生成的候选，不是你的结论", "Research ideas · AI-generated candidates, not your conclusions");
      for (const idea of t.ideas) {
        const card = el(doc, "div", "dg-card dg-idea");
        inline(doc, card.appendChild(el(doc, "div", "dg-ct")), idea.title);
        const dl = el(doc, "dl");
        for (const [k, zh, en] of [["basis", "来源", "Basis"], ["hypothesis", "核心假设", "Core hypothesis"], ["test", "怎么验证", "How to test"], ["risk", "可能失败", "How it may fail"]]) {
          if (!idea[k]) continue;
          dl.appendChild(el(doc, "dt", "", B(zh, en)));
          inline(doc, dl.appendChild(el(doc, "dd")), idea[k]);
        }
        card.appendChild(dl);
        body.appendChild(card);
      }
    }
    const card = g.markdown && g.markdown.card;
    if (card) {
      h4(doc, body, "精读卡", "Paper card");
      let sections = [];
      try { if (DeepRead.Guide && DeepRead.Guide.cardSections) sections = arr(DeepRead.Guide.cardSections(card)); }
      catch (e) {}
      if (sections.length) {
        const idx = el(doc, "div", "dg-index");
        sections.forEach((s, i) => {
          const label = typeof s === "string" ? s : (s.title || s.name || s.heading || "");
          const num = typeof s === "object" && s && (s.n || s.number || s.index) ? (s.n || s.number || s.index) : i + 1;
          idx.appendChild(el(doc, "span", "dg-tag", `${num}. ${label}`));
        });
        body.appendChild(idx);
      }
      body.appendChild(md(doc, card));
    }
    const acts = el(doc, "div", "dg-actions");
    acts.appendChild(btn(doc, B("保存为 Zotero 笔记", "Save as Zotero note"), () => actions.saveNote && actions.saveNote(), "dg-primary"));
    acts.appendChild(btn(doc, B("复制 Markdown", "Copy Markdown"), () => actions.copyMarkdown && actions.copyMarkdown()));
    body.appendChild(acts);
  }

  const STEPS = [
    ["① 定位", "① Position", stepPosition],
    ["② 骨架", "② Skeleton", stepSkeleton],
    ["③ 方法", "③ Method", stepMethod],
    ["④ 证据", "④ Evidence", stepEvidence],
    ["⑤ 带走", "⑤ Takeaway", stepTakeaway],
  ];

  function renderEmpty(doc, body, state, actions) {
    h4(doc, body, "带读是什么", "What guided reading does");
    body.appendChild(el(doc, "p", "", B(
      "让本地 Agent 先通读这篇论文，再把结果整理成五步：定位 → 骨架 → 方法 → 证据 → 带走。每一条结论都带原文段落标记，点一下就能跳到对应位置。",
      "A local agent reads the whole paper first; the result is organised into five steps: Position, Skeleton, Method, Evidence, Takeaway. Every point carries paragraph markers you can click to jump to the source.")));
    if (state.agentConfigured === false) {
      body.appendChild(el(doc, "p", "dg-err", B("还没有选择 Agent：请在 设置 → ③ Agent 中选择一个。", "No agent chosen yet: pick one in Settings → ③ Agent.")));
      const acts = el(doc, "div", "dg-actions");
      acts.appendChild(btn(doc, B("打开设置", "Open settings"), () => actions.openSettings && actions.openSettings(), "dg-primary"));
      acts.appendChild(btn(doc, B("导入现成结果…", "Import a result…"), () => actions.importFile && actions.importFile()));
      body.appendChild(acts);
      return;
    }
    const acts = el(doc, "div", "dg-actions");
    acts.appendChild(btn(doc, B("运行带读", "Run guided reading"), () => actions.run && actions.run(), "dg-primary"));
    acts.appendChild(btn(doc, B("导入现成结果…", "Import a result…"), () => actions.importFile && actions.importFile()));
    body.appendChild(acts);
  }

  function renderRunning(doc, body, state, actions) {
    const box = el(doc, "div", "dg-progress");
    const structuring = state.status === "structuring";
    box.appendChild(el(doc, "div", "", structuring
      ? B(`正在整理成五步结构… 已用时 ${fmtDuration(state.elapsedSec)}`, `Structuring into five steps… ${fmtDuration(state.elapsedSec)} elapsed`)
      : B(`Agent 正在通读全文… 已用时 ${fmtDuration(state.elapsedSec)}`, `The agent is reading the paper… ${fmtDuration(state.elapsedSec)} elapsed`)));
    const log = lastLines(state.log, 12);
    if (log) box.appendChild(el(doc, "div", "dg-log", log));
    const acts = el(doc, "div", "dg-actions");
    acts.appendChild(btn(doc, B("取消", "Cancel"), () => actions.cancel && actions.cancel()));
    box.appendChild(acts);
    body.appendChild(box);
  }

  function renderError(doc, body, state, actions) {
    body.appendChild(el(doc, "div", "dg-err", String(state.error || B("出错了", "Something went wrong"))));
    const acts = el(doc, "div", "dg-actions");
    acts.appendChild(btn(doc, B("重新运行", "Run again"), () => actions.run && actions.run(), "dg-primary"));
    acts.appendChild(btn(doc, B("导入现成结果…", "Import a result…"), () => actions.importFile && actions.importFile()));
    body.appendChild(acts);
  }

  function render(doc, host, state, actions) {
    state = state || {};
    actions = actions || {};
    const status = state.status || "empty";
    const counts = stepCounts(state.guide);
    const busy = status === "running" || status === "structuring";
    const children = [];

    const head = el(doc, "div", "dg-head");
    const top = el(doc, "div", "dg-top");
    top.appendChild(el(doc, "span", "dg-title", B("带读", "Guided reading")));
    let line = "";
    if (busy) line = B(`Agent 运行中 · ${fmtDuration(state.elapsedSec)}`, `Agent running · ${fmtDuration(state.elapsedSec)}`);
    else if (status === "ready") {
      const ready = counts.filter((n) => n > 0).length;
      line = B(`${ready} / 5 步已就绪`, `${ready} / 5 steps ready`);
    }
    else if (status === "error") line = B("运行失败", "Run failed");
    top.appendChild(el(doc, "span", "dg-status", line));
    if (busy) top.appendChild(btn(doc, B("取消", "Cancel"), () => actions.cancel && actions.cancel()));
    else if (status !== "empty") {
      top.appendChild(btn(doc, B("重新运行", "Run again"), () => actions.run && actions.run()));
      top.appendChild(btn(doc, B("导入结果…", "Import…"), () => actions.importFile && actions.importFile()));
    }
    const x = el(doc, "button", "dg-x", "×");
    x.type = "button";
    x.title = B("关闭", "Close");
    x.addEventListener("click", (ev) => { ev.preventDefault(); actions.close && actions.close(); });
    top.appendChild(x);
    head.appendChild(top);

    const meta = state.meta || {};
    const parts = [];
    if (state.kindLabel) parts.push(state.kindLabel);
    if (arr(state.skills).length) parts.push(state.skills.join(" + "));
    if (status === "ready" && meta.finishedAt) {
      parts.push(fmtTime(meta.finishedAt));
      if (meta.startedAt && meta.finishedAt >= meta.startedAt) parts.push(fmtDuration((meta.finishedAt - meta.startedAt) / 1000));
    }
    if (parts.length) head.appendChild(el(doc, "div", "dg-meta", parts.join(" · ")));

    const step = Math.min(5, Math.max(1, Number(state.step) || 1));
    const tabs = el(doc, "div", "dg-tabs");
    tabs.setAttribute("role", "tablist");
    STEPS.forEach(([zh, en], i) => {
      const tab = el(doc, "button", "dg-tab", B(zh, en));
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(step === i + 1));
      if (counts[i] > 0) tab.appendChild(el(doc, "span", "dg-dot"));
      tab.addEventListener("click", (ev) => { ev.preventDefault(); actions.setStep && actions.setStep(i + 1); });
      tabs.appendChild(tab);
    });
    head.appendChild(tabs);
    children.push(head);

    const body = el(doc, "div", "dg-body");
    if (status === "empty") renderEmpty(doc, body, state, actions);
    else if (busy) renderRunning(doc, body, state, actions);
    else if (status === "error") renderError(doc, body, state, actions);
    else {
      STEPS[step - 1][2](doc, body, state.guide || {}, actions);
      if (!body.firstChild) body.appendChild(el(doc, "p", "dg-sub", B("这一步没有内容。", "Nothing in this step.")));
    }
    children.push(body);

    if (host.replaceChildren) host.replaceChildren(...children);
    else {
      while (host.firstChild) host.removeChild(host.firstChild);
      children.forEach((c) => host.appendChild(c));
    }
  }

  DeepRead.GuideView = { CSS, render, stepCounts, verdictLabel, statusLabel, strengthLabel, basisLabel, effectLabel, roleLabel };
})();
