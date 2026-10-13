/* GitHub helpers: find the paper's repository in its text, REST API client (repo info, README, tree, files).
 * Replaces Vibero's code-pane repository detection; talks to api.github.com directly with an optional user token.
 * License: AGPL-3.0-or-later */
/* global DeepRead, fetch, AbortController, setTimeout, clearTimeout, TextDecoder, atob */

DeepRead.GitHub = (function () {
  const MAX_FILE_BYTES = 300 * 1024;
  const DEFAULT_TIMEOUT_MS = 30000;
  const NOT_REPOS = new Set([
    "orgs", "topics", "features", "about", "pricing", "sponsors", "marketplace", "settings", "login", "search",
    "collections", "trending", "apps", "site", "enterprise", "security", "customer-stories", "readme",
    "explore", "notifications", "pulls", "issues", "new", "join", "contact", "team", "users", "organizations",
  ]);

  const api = {
    // Overridable for tests.
    API_BASE: "https://api.github.com",
    MAX_FILE_BYTES,
  };

  /* ---------------- repo detection ---------------- */

  function cleanPart(s) {
    return String(s || "").replace(/\.git$/i, "").replace(/[.,;:!?)\]}>'"”’]+$/g, "").replace(/\.git$/i, "");
  }

  /** "owner/repo", "github.com/owner/repo(.git)", "https://github.com/owner/repo/tree/main" → parts or null. */
  api.parseRepo = function (input) {
    let s = String(input || "").trim();
    if (!s) return null;
    s = s.replace(/^git@github\.com:/i, "github.com/");
    s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
    s = s.split(/[?#]/)[0];
    const parts = s.split("/").filter((p, i) => p !== "" || i > 1);
    if (parts.length < 2) return null;
    const owner = parts[0].replace(/[.,;:!?)\]}>'"]+$/g, "");
    const repo = cleanPart(parts[1]);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) || owner.length > 39) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") return null;
    if (NOT_REPOS.has(owner.toLowerCase())) return null;
    return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
  };

  api.findReposInText = function (text) {
    const src = String(text || "");
    // Repair line breaks / hyphenation PDF extraction puts inside URLs: "github.com/foo/bar-\nbaz" and
    // "https://github.com/foo/\nbar". Offsets are kept approximate (only used for ranking).
    const repaired = src
      .replace(/(github\.com\/[\w.\/-]*[A-Za-z0-9])-\r?\n\s*(?=[A-Za-z0-9])/gi, "$1-")
      .replace(/(github\.com\/(?:[\w.-]+\/)?)(?:[ \t]+|[ \t]*\r?\n\s*)(?=[A-Za-z0-9_])/gi, "$1");
    const re = /github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/gi;
    const found = new Map();
    for (const m of repaired.matchAll(re)) {
      const parsed = api.parseRepo(`${m[1]}/${m[2]}`);
      if (!parsed) continue;
      const key = parsed.fullName.toLowerCase();
      const entry = found.get(key);
      if (entry) entry.count += 1;
      else found.set(key, { fullName: parsed.fullName, url: parsed.url, count: 1, firstIndex: m.index });
    }
    return [...found.values()].sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex);
  };

  /* ---------------- HTTP ---------------- */

  function abortError() {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return e;
  }

  function headersFor(accept) {
    const headers = { Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    let token = "";
    try {
      token = String(DeepRead.prefs.get("github.token") || "").trim();
    }
    catch (e) { /* pref missing */ }
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function httpError(step, response) {
    let body = "";
    try {
      body = await response.text();
    }
    catch (e) { /* ignore */ }
    let message = "";
    try {
      message = JSON.parse(body).message || "";
    }
    catch (e) { message = body.slice(0, 300); }
    let text = `GitHub ${step} failed: HTTP ${response.status} ${response.statusText || ""} ${message}`.replace(/\s+/g, " ").trim();
    const remaining = response.headers.get("x-ratelimit-remaining");
    if ((response.status === 403 || response.status === 429) && (remaining === "0" || /rate limit/i.test(message))) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : "";
      text = `GitHub ${step} failed: HTTP ${response.status} rate limit exceeded${when ? `, resets at ${when}` : ""}. ` +
        "Set a GitHub token in the DeepRead preferences to raise the limit.";
    }
    const err = new Error(text);
    err.status = response.status;
    return err;
  }

  async function request(step, url, { accept, signal, timeoutMs = DEFAULT_TIMEOUT_MS, allow404 = false } = {}, consume) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response;
      try {
        response = await fetch(url, { headers: headersFor(accept), signal: controller.signal });
      }
      catch (e) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new Error(`GitHub ${step} timed out`);
        throw new Error(`GitHub ${step} failed: ${e?.message || e}`);
      }
      if (allow404 && response.status === 404) return null;
      if (!response.ok) throw await httpError(step, response);
      return await consume(response);
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  const getJSON = (step, url, opts) => request(step, url, opts, (r) => r.json());

  function fullNameOf(input) {
    const p = api.parseRepo(input);
    if (!p) throw new Error(`Invalid GitHub repository: ${input}`);
    return p.fullName;
  }

  const encPath = (p) => String(p || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");

  /* ---------------- API ---------------- */

  function mapRepo(r) {
    return {
      fullName: r.full_name,
      url: r.html_url,
      description: r.description || "",
      stars: r.stargazers_count || 0,
      forks: r.forks_count || 0,
      language: r.language || "",
      license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : (r.license?.name || ""),
      updatedAt: r.pushed_at || r.updated_at || "",
      defaultBranch: r.default_branch || "",
      topics: r.topics || [],
      homepage: r.homepage || "",
      archived: !!r.archived,
    };
  }

  api.search = async function (title, { signal } = {}) {
    const q = encodeURIComponent(`"${String(title || "").replace(/"/g, " ").trim()}" in:name,description,readme`);
    const data = await getJSON("search", `${api.API_BASE}/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`, { signal });
    return (data.items || []).map(mapRepo);
  };

  api.getRepo = async function (fullName, { signal } = {}) {
    const name = fullNameOf(fullName);
    return mapRepo(await getJSON("repository lookup", `${api.API_BASE}/repos/${name}`, { signal }));
  };

  api.getReadme = async function (fullName, { signal } = {}) {
    const name = fullNameOf(fullName);
    const meta = await getJSON("README lookup", `${api.API_BASE}/repos/${name}/readme`, { signal, allow404: true });
    if (!meta) return null;
    let markdown;
    if (meta.encoding === "base64" && typeof meta.content === "string") {
      const bin = atob(meta.content.replace(/\s+/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      markdown = new TextDecoder("utf-8").decode(bytes);
    }
    else {
      markdown = await request("README download", `${api.API_BASE}/repos/${name}/readme`, { accept: "application/vnd.github.raw", signal }, (r) => r.text());
    }
    return { markdown, htmlURL: meta.html_url || `https://github.com/${name}#readme` };
  };

  api.listDir = async function (fullName, path = "", ref, { signal } = {}) {
    const name = fullNameOf(fullName);
    const url = `${api.API_BASE}/repos/${name}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const data = await getJSON("directory listing", url, { signal });
    if (!Array.isArray(data)) throw new Error("GitHub directory listing failed: not a directory");
    return data
      .map((e) => ({ name: e.name, path: e.path, type: e.type === "dir" ? "dir" : "file", size: e.size || 0 }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  };

  api.getFile = async function (fullName, path, ref, { signal } = {}) {
    const name = fullNameOf(fullName);
    const url = `${api.API_BASE}/repos/${name}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const htmlURL = `https://github.com/${name}/blob/${ref || "HEAD"}/${encPath(path)}`;
    return request("file download", url, { accept: "application/vnd.github.raw", signal, timeoutMs: 60000 }, async (response) => {
      const buf = new Uint8Array(await response.arrayBuffer());
      const size = buf.length;
      const head = buf.subarray(0, 8192);
      let binary = false;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) { binary = true; break; }
      }
      if (binary) return { text: "", size, truncated: false, binary: true, htmlURL };
      const truncated = size > MAX_FILE_BYTES;
      const text = new TextDecoder("utf-8").decode(truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf);
      return { text, size, truncated, binary: false, htmlURL };
    });
  };

  return api;
})();
