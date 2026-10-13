// Tests for DeepRead.DeepWiki against a local fake MCP (Streamable HTTP) server. Run: node test/deepwiki.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

const prefs = {};
const ctx = vm.createContext({
  Zotero: { debug() {}, locale: "en-US" },
  fetch, URL, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, DeepRead: {},
});
ctx.DeepRead.prefs = { get: (k) => prefs[k] };
for (const f of ["util.js", "l10n.js", "services/deepwiki.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const DW = ctx.DeepRead.DeepWiki;

let mode = "json"; // json | sse | session | expire | slow | rpcerror | oldask | unsupported
let log = [];
let validSession = "S1";
let sessionCounter = 0;
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    const msg = JSON.parse(data);
    log.push({ method: msg.method, headers: req.headers, params: msg.params });
    const sse = mode === "sse";
    const reply = (obj, headers = {}) => {
      if (sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
        res.write(`: ping\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n`);
        const s = JSON.stringify(obj);
        const half = Math.floor(s.length / 2);
        res.write(`event: message\ndata: ${s.slice(0, half)}`);
        setTimeout(() => res.end(s.slice(half) + "\n\n"), 5);
      }
      else {
        res.writeHead(200, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      }
    };
    if (msg.method === "initialize") {
      if (mode === "unsupported" && msg.params.protocolVersion !== "2025-03-26") {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Unsupported protocol version");
      }
      const headers = {};
      if (mode === "session" || mode === "expire") { validSession = `S${++sessionCounter}`; headers["Mcp-Session-Id"] = validSession; }
      return reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }, headers);
    }
    if (msg.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    if ((mode === "session" || mode === "expire") && req.headers["mcp-session-id"] !== validSession) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Session not found");
    }
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      if (mode === "expire" && !globalThis.__expired) { globalThis.__expired = true; validSession = "dead"; }
      if ((mode === "session" || mode === "expire") && req.headers["mcp-session-id"] !== validSession) { res.writeHead(404); return res.end("Session not found"); }
      if (mode === "slow") { await new Promise((r) => setTimeout(r, 400)); }
      if (mode === "rpcerror") return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool: " + name } });
      if (mode === "oldask" && name === "ask_wiki_question") return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool: ask_wiki_question" } });
      if (mode === "toolerror") return reply({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "Repository not found" }] } });
      return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `${name}:${args.repoName}` }, { type: "text", text: args.question || "end" }] } });
    }
    res.writeHead(400); res.end("bad");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
prefs["deepwiki.endpoint"] = `http://127.0.0.1:${server.address().port}/mcp`;
const reset = (m) => { sessionCounter = 0; mode = m; log = []; DW.resetSessions(); globalThis.__expired = false; };

try {
  // JSON responses, no session id
  reset("json");
  assert.equal(await DW.readWikiStructure("o/r"), "read_wiki_structure:o/r\nend");
  assert.deepEqual(log.map((l) => l.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.equal(log[0].params.protocolVersion, "2025-06-18");
  assert.equal(log[0].params.clientInfo.name, "DeepRead");
  assert.match(log[0].headers.accept, /application\/json/);
  assert.match(log[0].headers.accept, /text\/event-stream/);
  assert.equal(log[2].headers["mcp-session-id"], undefined);
  assert.deepEqual({ ...log[2].params.arguments }, { repoName: "o/r" });
  // session cached: second call does not re-initialize
  log = [];
  assert.equal(await DW.readWikiContents("o/r"), "read_wiki_contents:o/r\nend");
  assert.deepEqual(log.map((l) => l.method), ["tools/call"]);

  // SSE responses (split mid-JSON, with interleaved notification)
  reset("sse");
  assert.equal(await DW.askQuestion("o/r", "why?"), "ask_wiki_question:o/r\nwhy?");
  assert.equal(log.at(-1).params.name, "ask_wiki_question");

  // Session id header is sent on follow-ups
  reset("session");
  await DW.readWikiStructure("o/r");
  assert.equal(log[1].headers["mcp-session-id"], "S1");
  assert.equal(log[2].headers["mcp-session-id"], "S1");

  // 404 session error → re-init once
  reset("expire");
  assert.equal(await DW.readWikiStructure("o/r"), "read_wiki_structure:o/r\nend");
  assert.deepEqual(log.map((l) => l.method), ["initialize", "notifications/initialized", "tools/call", "initialize", "notifications/initialized", "tools/call"]);
  assert.equal(log[5].headers["mcp-session-id"], "S2");

  // protocol fallback
  reset("unsupported");
  await DW.readWikiStructure("o/r");
  assert.deepEqual(log.filter((l) => l.method === "initialize").map((l) => l.params.protocolVersion), ["2025-06-18", "2025-03-26"]);

  // old server: ask_wiki_question unknown → ask_question
  reset("oldask");
  assert.equal(await DW.askQuestion("o/r", "q"), "ask_question:o/r\nq");

  // JSON-RPC error and tool isError
  reset("rpcerror");
  await assert.rejects(() => DW.readWikiStructure("o/r"), /Unknown tool/);
  reset("toolerror");
  await assert.rejects(() => DW.readWikiStructure("o/r"), /Repository not found/);

  // abort + timeout
  reset("slow");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => DW.readWikiStructure("o/r", { signal: ac.signal }), (e) => e.name === "AbortError");
  reset("slow");
  DW.TIMEOUT_STRUCTURE = 150;
  await assert.rejects(() => DW.readWikiStructure("o/r"), /timed out/);
  DW.TIMEOUT_STRUCTURE = 60000;

  // splitPages
  const pages = DW.splitPages("# Page: Overview\n\nHello\n\n# Page: Two\n\nBody\n# not a page");
  assert.deepEqual(Array.from(pages.map((p) => p.title)), ["Overview", "Two"]);
  assert.equal(pages[0].markdown, "Hello");
  assert.match(pages[1].markdown, /Body/);

  console.log("deepwiki.test: all passed");
} finally {
  server.close();
}
