#!/usr/bin/env node
// Fake OpenAI-compatible server that answers DeepRead/Vibero pipeline prompts with valid structured output.
// Usage: node test/fake-openai.mjs [--port 18766] [--no-json-schema] [--delay-ms N]
import http from 'node:http';

const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argv('port', 18766));
const NO_SCHEMA = args.includes('--no-json-schema');
const DELAY = Number(argv('delay-ms', 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = '[\\u201c\\u201d"]'; // curly or straight quotes

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join('\n');
  }
  return '';
}

function detect(t) {
  if (/Paragraphs to explain \(JSON\):/.test(t)) return 'explain';
  if (/article_summary field|包含 article_summary 字段/.test(t)) return 'article_summary';
  if (/outline field|包含 outline 字段/.test(t)) return 'outline';
  if (/point_split/.test(t) && /(Paragraph list|段落列表):/.test(t)) return 'page';
  if (/(filter out|过滤)/.test(t) && /(Paragraph list|段落列表)/.test(t)) return 'filter';
  return 'chat';
}

// ---- page summaries ----
function parsePageParagraphs(t) {
  const re = new RegExp('\\{\\s*id:\\s*' + Q + '([^\\u201c\\u201d"]+)' + Q + ',\\s*sentences:\\s*\\[\\n([\\s\\S]*?)\\n\\]\\s*\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const idxs = [];
    const texts = [];
    for (const line of m[2].split('\n')) {
      const lm = line.match(/^\s*\[(\d+)\]\s+(".*")\s*$/);
      if (!lm) continue;
      idxs.push(Number(lm[1]));
      try { texts.push(JSON.parse(lm[2])); } catch { texts.push(lm[2]); }
    }
    out.push({ id: m[1], n: idxs.length ? Math.max(...idxs) + 1 : 0, texts });
  }
  return out;
}
// Chinese-looking stand-in translation, about as long as a real one (~1 CJK char per 3 source chars).
const ZH = '本文提出的方法通过注意力机制直接建模序列中任意两个位置之间的依赖关系，不再依赖循环结构，因此可以在训练时充分并行，并在机器翻译任务上取得更好的效果';
function zhLike(source, k) {
  const n = Math.max(8, Math.round(String(source).length / 3.2));
  let out = '';
  while (out.length < n) out += ZH;
  out = out.slice(0, n).replace(/[，。]$/, '');
  return (k === 1 ? out.slice(0, Math.floor(n / 2)) + '，其复杂度为 $O(n^2 \\cdot d)$，' + out.slice(Math.floor(n / 2)) : out) + '。';
}

function buildPage(t) {
  const paras = parsePageParagraphs(t);
  const paragraphs = paras.map((p) => {
    const split = [];
    for (let i = 0; i < p.n; i += 2) split.push(i + 1 < p.n ? [i, i + 1] : [i]);
    return {
      id: p.id,
      paragraph_summary: `Fake summary of ${p.id}`,
      importance_level: 2,
      point_split: split,
      point_summaries: split.map((g, i) => `Fake point ${i + 1} of ${p.id}`),
      point_translations: split.map((g, i) => (i === 0 ? '【译】' : '') + g.map((k) => zhLike(p.texts[k] || '', k)).join('')),
    };
  });
  return { obj: { paragraphs }, info: `paragraphs=${paras.length}` };
}

// ---- sections JSON (article summary / outline) ----
function parseSections(t) {
  const marker = /(Paper sections JSON data:|论文 sections JSON 数据：)/;
  const mm = marker.exec(t);
  if (!mm) return [];
  const rest = t.slice(mm.index + mm[0].length);
  const start = rest.indexOf('[');
  const end = rest.lastIndexOf(']');
  try { return JSON.parse(rest.slice(start, end + 1)); } catch { return []; }
}
function summaryTitles(t) {
  // The "Output Format" example lists the 5 exact titles in order as “title”: “X”
  const cut = Math.max(t.lastIndexOf('Return strictly in JSON format'), t.lastIndexOf('严格返回 JSON 格式'));
  const seg = t.slice(cut >= 0 ? cut : 0);
  const re = new RegExp(Q + 'title' + Q + ':\\s*' + Q + '([^\\u201c\\u201d"]+)' + Q, 'g');
  const out = [];
  let m;
  while ((m = re.exec(seg)) && out.length < 5) out.push(m[1]);
  if (out.length < 5) return ['Paper Title', 'Research Background', 'Core Innovations', 'Experimental Results', 'Conclusions'];
  return out;
}
function buildArticle(t) {
  const sections = parseSections(t);
  const [tPaper, tBg, tInn, tExp, tConc] = summaryTitles(t);
  const ids = [];
  for (const s of sections) for (const b of s.blocks || []) if (typeof b.block_id === 'number') ids.push(b.block_id);
  const pick = (from, n) => ids.slice(from, from + n);
  const title = (sections[0] && sections[0].title) || 'Fake Paper';
  const obj = { article_summary: [
    { title: tPaper, content: title, points: [] },
    { title: tBg, content: 'Fake background: the paper addresses a sequence modelling problem.', points: [] },
    { title: tInn, content: '', points: [
      { point_title: 'Fake innovation A', content: 'Fake description of the first contribution.', block_ids: pick(0, 6) },
      { point_title: 'Fake innovation B', content: 'Fake description of the second contribution.', block_ids: pick(6, 6) } ] },
    { title: tExp, content: '', points: [
      { point_title: 'Fake experiment A', content: 'Fake key setup and result.', block_ids: pick(12, 6) },
      { point_title: 'Fake experiment B', content: 'Fake ablation result.', block_ids: pick(18, 6) } ] },
    { title: tConc, content: 'Fake conclusion: the approach is effective.', points: [] },
  ] };
  return { obj, info: `sections=${sections.length} blocks=${ids.length}` };
}
function levelOf(title, idx) {
  const m = /^\s*(\d+(?:\.\d+)*)\.?\s/.exec(title);
  if (m) return m[1].split('.').length;
  return idx === 0 ? 0 : 1;
}
function buildOutline(t) {
  const sections = parseSections(t);
  const root = { title: (sections[0] && sections[0].title) || 'Fake Paper', title_block_id: sections[0] ? sections[0].title_block_id : 0, level: 0, summary: 'Fake root summary', children: [] };
  const stack = [root];
  sections.forEach((s, i) => {
    if (i === 0) return;
    const lvl = Math.max(1, levelOf(String(s.title), i));
    const node = { title: s.title, title_block_id: s.title_block_id, level: lvl, summary: `Fake summary of ${s.title}`, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= lvl) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  return { obj: { outline: root }, info: `sections=${sections.length}` };
}

// ---- paragraph explanations ("AI 讲解") ----
function buildExplain(t) {
  const m = /Paragraphs to explain \(JSON\):\s*(\{.*\})/.exec(t);
  let items = [];
  try { items = JSON.parse(m[1]).items || []; } catch { /* keep empty */ }
  const explanations = items.map((it) => {
    const key = String(it.key);
    let text = `这一段（${key}）讲的是作者如何用更直接的方式解决前文提到的问题。可以把它理解为整篇论文论证链条中的一环，后面的实验正是为了验证这里的说法。`;
    if (/_2$/.test(key)) text += ` 其中的 **自注意力** 需要对每一对位置计算一次，因此复杂度为 $O(n^2)$。`;
    return { key, explanation: text };
  });
  return { obj: { explanations }, info: `items=${items.length}` };
}

// ---- author filter: keep everything ----
function buildFilter() { return { obj: { indices: [] }, info: 'keep all' }; }

function chatAnswer() {
  return 'This is a fake answer. The attention weights are computed as $E=mc^2$ style scaled dot products (p. 2).\n\n- point one\n- point two';
}

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url, 'http://x');
  const log = (code, extra) => console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} -> ${code} ${extra || ''}`);
  if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
    log(200);
    return send(res, 200, { object: 'list', data: [{ id: 'fake', object: 'model', owned_by: 'fake' }] });
  }
  if (req.method === 'POST' && /\/chat\/completions$/.test(url.pathname)) {
    let body;
    try { body = JSON.parse(raw); } catch { log(400, 'bad json'); return send(res, 400, { error: { message: 'invalid JSON body' } }); }
    if (DELAY) await sleep(DELAY);
    const rfType = body.response_format && body.response_format.type;
    if (NO_SCHEMA && rfType === 'json_schema') {
      log(400, 'rejected response_format json_schema');
      return send(res, 400, { error: { message: 'response_format json_schema is not supported by this server', type: 'invalid_request_error', param: 'response_format' } });
    }
    const text = lastUserText(body.messages || []);
    const systemText = (body.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
    let kind = detect(text);
    if (kind === 'chat' && /"question"/.test(systemText) && /"answer"/.test(systemText)) kind = 'flashcard';
    let content, info = '';
    if (kind === 'chat') content = chatAnswer();
    else if (kind === 'flashcard') {
      content = JSON.stringify({ question: '这段话为什么重要？(fake)', answer: '因为它提出了 **注意力** 机制，复杂度为 $O(n^2)$。(fake)' });
    }
    else {
      const r = { page: buildPage, article_summary: buildArticle, outline: buildOutline, filter: buildFilter, explain: buildExplain }[kind](text);
      content = JSON.stringify(r.obj);
      info = r.info;
    }
    log(200, `type=${kind} stream=${!!body.stream} ${info}`);
    const id = 'chatcmpl-fake';
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const parts = content.match(/.{1,24}/gs) || [''];
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      for (const p of parts) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake', choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
        if (DELAY) await sleep(Math.min(DELAY, 50));
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return send(res, 200, { id, object: 'chat.completion', created, model: body.model || 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 } });
  }
  log(404);
  send(res, 404, { error: { message: 'not found' } });
}).listen(PORT, '127.0.0.1', () => console.log(`fake-openai listening on http://127.0.0.1:${PORT}/v1${NO_SCHEMA ? ' (no json_schema)' : ''}`));
