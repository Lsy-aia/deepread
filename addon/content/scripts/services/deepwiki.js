/* DeepWiki public MCP client (Streamable HTTP, JSON-RPC 2.0). No DeepWiki proxy/keys: https://mcp.deepwiki.com/mcp
 * License: AGPL-3.0-or-later */
/* global DeepRead, fetch, AbortController, TextDecoder, setTimeout, clearTimeout */

DeepRead.DeepWiki = (function () {
  const DEFAULT_ENDPOINT = "https://mcp.deepwiki.com/mcp";
  const PROTOCOLS = ["2025-06-18", "2025-03-26"];
  const SESSION_TTL_MS = 10 * 60 * 1000;
  const sessions = new Map(); // endpoint → { id, protocolVersion, expires }
  let nextId = 1;

  const api = { DEFAULT_ENDPOINT, TIMEOUT_STRUCTURE: 60000, TIMEOUT_LONG: 180000 };

  function endpoint() {
    let v = "";
    try {
      v = String(DeepRead.prefs.get("deepwiki.endpoint") || "").trim();
    }
    catch (e) { /* pref missing */ }
    return v || DEFAULT_ENDPOINT;
  }

  function abortError() {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return e;
  }

  /** Parse an SSE body, returning the JSON-RPC message whose id matches (or the last one with result/error). */
  function parseSSE(text, id) {
    let fallback = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      let msg;
      try {
        msg = JSON.parse(data);
      }
      catch (e) { continue; }
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) {
        if (m && m.id === id && (m.result !== undefined || m.error)) return m;
        if (m && (m.result !== undefined || m.error)) fallback = m;
      }
    }
    return fallback;
  }

  function parseBody(text, contentType, id) {
    if (/text\/event-stream/i.test(contentType) || /^\s*(event|data):/.test(text)) return parseSSE(text, id);
    const msg = JSON.parse(text);
    if (Array.isArray(msg)) return msg.find((m) => m.id === id) || msg[0];
    return msg;
  }

  /** POST one JSON-RPC message. Returns { status, message, sessionId }. Throws on network error / timeout / abort. */
  async function post(url, payload, { sessionId, protocolVersion, signal, timeoutMs, expectResponse = true }) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
      let response;
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
      }
      catch (e) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new Error(`DeepWiki request timed out after ${Math.round(timeoutMs / 1000)} s`);
        throw new Error(`DeepWiki request failed: ${e?.message || e}`);
      }
      let text;
      try {
        text = await response.text();
      }
      catch (e) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new Error(`DeepWiki request timed out after ${Math.round(timeoutMs / 1000)} s`);
        throw new Error(`DeepWiki response failed: ${e?.message || e}`);
      }
      const out = { status: response.status, ok: response.ok, text, message: null, sessionId: response.headers.get("mcp-session-id") || null };
      if (response.ok && expectResponse && text.trim()) {
        try {
          out.message = parseBody(text, response.headers.get("content-type") || "", payload.id);
        }
        catch (e) {
          throw new Error(`DeepWiki returned an unreadable response: ${String(text).slice(0, 200)}`);
        }
      }
      return out;
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function httpError(res) {
    const err = new Error(`DeepWiki HTTP ${res.status}: ${String(res.text || "").slice(0, 500)}`);
    err.status = res.status;
    return err;
  }

  async function initialize(url, signal) {
    let lastError = null;
    for (const version of PROTOCOLS) {
      const id = nextId++;
      const res = await post(url, {
        jsonrpc: "2.0", id, method: "initialize",
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "DeepRead", version: String(DeepRead.version || "0.2.0") } },
      }, { signal, timeoutMs: api.TIMEOUT_STRUCTURE });
      if (!res.ok) {
        lastError = httpError(res);
        if (res.status === 400) continue; // maybe unsupported protocol version
        throw lastError;
      }
      if (res.message?.error) {
        lastError = new Error(`DeepWiki initialize error: ${res.message.error.message || JSON.stringify(res.message.error)}`);
        continue;
      }
      const negotiated = res.message?.result?.protocolVersion || version;
      const state = { id: res.sessionId, protocolVersion: negotiated, expires: Date.now() + SESSION_TTL_MS };
      // notifications/initialized — failures here are not fatal.
      try {
        await post(url, { jsonrpc: "2.0", method: "notifications/initialized" },
          { sessionId: state.id, protocolVersion: negotiated, signal, timeoutMs: api.TIMEOUT_STRUCTURE, expectResponse: false });
      }
      catch (e) {
        if (e.name === "AbortError") throw e;
        DeepRead.log("deepwiki initialized notification failed", String(e));
      }
      sessions.set(url, state);
      return state;
    }
    throw lastError || new Error("DeepWiki initialize failed");
  }

  async function ensureSession(url, signal) {
    const s = sessions.get(url);
    if (s && s.expires > Date.now()) return s;
    return initialize(url, signal);
  }

  function textOf(result) {
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
    if (text) return text;
    if (typeof result?.structuredContent?.result === "string") return result.structuredContent.result;
    return "";
  }

  api.callTool = async function (name, args, { signal, timeoutMs } = {}) {
    const url = endpoint();
    const timeout = timeoutMs || (name === "read_wiki_structure" ? api.TIMEOUT_STRUCTURE : api.TIMEOUT_LONG);
    let reinit = false;
    for (;;) {
      const session = await ensureSession(url, signal);
      const res = await post(url, {
        jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args || {} },
      }, { sessionId: session.id, protocolVersion: session.protocolVersion, signal, timeoutMs: timeout });
      if (!res.ok) {
        const sessionProblem = res.status === 404 || (res.status === 400 && /session/i.test(res.text));
        if (sessionProblem && !reinit) {
          reinit = true;
          sessions.delete(url);
          continue;
        }
        throw httpError(res);
      }
      const msg = res.message;
      if (!msg) throw new Error("DeepWiki returned an empty response");
      if (msg.error) {
        if (/session/i.test(msg.error.message || "") && !reinit) {
          reinit = true;
          sessions.delete(url);
          continue;
        }
        const err = new Error(`DeepWiki ${name} error: ${msg.error.message || JSON.stringify(msg.error)}`);
        err.code = msg.error.code;
        throw err;
      }
      const text = textOf(msg.result);
      if (msg.result?.isError) throw new Error(`DeepWiki ${name} failed: ${text.slice(0, 500) || "unknown error"}`);
      return text;
    }
  };

  api.resetSessions = function () {
    sessions.clear();
  };

  api.readWikiStructure = (fullName, { signal } = {}) =>
    api.callTool("read_wiki_structure", { repoName: fullName }, { signal, timeoutMs: api.TIMEOUT_STRUCTURE });

  api.readWikiContents = (fullName, { signal } = {}) =>
    api.callTool("read_wiki_contents", { repoName: fullName }, { signal, timeoutMs: api.TIMEOUT_LONG });

  /** The server currently exposes `ask_wiki_question` (older name: `ask_question`); fall back on unknown-tool errors. */
  api.askQuestion = async function (fullName, question, { signal } = {}) {
    const args = { repoName: fullName, question };
    try {
      return await api.callTool("ask_wiki_question", args, { signal, timeoutMs: api.TIMEOUT_LONG });
    }
    catch (e) {
      if (e.name === "AbortError" || !/unknown tool|not found|no such tool|invalid tool|-32602/i.test(String(e.message) + (e.code || ""))) throw e;
      return api.callTool("ask_question", args, { signal, timeoutMs: api.TIMEOUT_LONG });
    }
  };

  /** Split read_wiki_contents output ("# Page: Title" sections) → [{ title, markdown }]. */
  api.splitPages = function (text) {
    const src = String(text || "");
    const re = /^# Page: (.*)$/gm;
    const marks = [...src.matchAll(re)];
    if (!marks.length) return src.trim() ? [{ title: "", markdown: src }] : [];
    return marks.map((m, i) => ({
      title: m[1].trim(),
      markdown: src.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).trim(),
    }));
  };

  return api;
})();
