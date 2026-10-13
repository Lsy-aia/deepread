// Tests for DeepRead.GitHub (text detection + REST client against a local fake API). Run: node test/github.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "addon/content/scripts");

const prefs = { "github.token": "" };
const ctx = vm.createContext({
  Zotero: { debug() {}, locale: "en-US" },
  fetch, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController, atob, btoa, setTimeout, clearTimeout,
  DeepRead: {},
});
ctx.DeepRead.prefs = { get: (k) => prefs[k] };
for (const f of ["util.js", "l10n.js", "services/github.js"]) {
  vm.runInContext(fs.readFileSync(path.join(scripts, f), "utf8"), ctx, { filename: f });
}
const GH = ctx.DeepRead.GitHub;
const arr = (a) => Array.from(a);

// ---- text detection ----
{
  const text = [
    "Code: https://github.com/foo/bar.",
    "See github.com/foo/bar/tree/main/src and (https://github.com/foo/bar.git),",
    "Also https://github.com/orgs/acme/people and github.com/topics/vision, github.com/features/copilot.",
    "Other: https://github.com/Baz/qux?tab=readme#top; github.com/baz/qux",
    "Split: https://github.com/lonely/long-\nname and https://github.com/\nsplit/repo2 and github.com/aaa/\nbbb",
    "Only once: github.com/solo/one",
  ].join("\n");
  const r = GH.findReposInText(text);
  const names = r.map((x) => x.fullName);
  assert.deepEqual(arr(names.slice(0, 2)), ["foo/bar", "Baz/qux"]);
  assert.equal(r[0].count, 3);
  assert.equal(r[1].count, 2);
  assert.ok(!names.some((n) => /^(orgs|topics|features)\//i.test(n)), names.join());
  assert.ok(names.includes("lonely/long-name"), names.join());
  assert.ok(names.includes("split/repo2"), names.join());
  assert.ok(names.includes("aaa/bbb"), names.join());
  assert.equal(r.find((x) => x.fullName === "solo/one").url, "https://github.com/solo/one");
  // tie → earlier first
  const t = GH.findReposInText("github.com/a/one github.com/b/two");
  assert.deepEqual(arr(t.map((x) => x.fullName)), ["a/one", "b/two"]);
  assert.equal(GH.findReposInText("").length, 0);
  assert.equal(GH.findReposInText("nothing here").length, 0);
}
// ---- parseRepo ----
{
  assert.deepEqual({ ...GH.parseRepo("owner/repo") }, { owner: "owner", repo: "repo", fullName: "owner/repo", url: "https://github.com/owner/repo" });
  assert.equal(GH.parseRepo("https://github.com/o/r.git").fullName, "o/r");
  assert.equal(GH.parseRepo("https://www.github.com/o/r/tree/main/x?y=1#z").fullName, "o/r");
  assert.equal(GH.parseRepo("git@github.com:o/r.git").fullName, "o/r");
  assert.equal(GH.parseRepo("github.com/o/r),").fullName, "o/r");
  assert.equal(GH.parseRepo("https://github.com/topics/foo"), null);
  assert.equal(GH.parseRepo("onlyone"), null);
  assert.equal(GH.parseRepo(""), null);
  assert.equal(GH.parseRepo(null), null);
}

// ---- API against fake server ----
const requests = [];
const big = "x".repeat(400 * 1024);
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, headers: req.headers });
  const json = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  const u = new URL(req.url, "http://x");
  const repo = { full_name: "o/r", html_url: "https://github.com/o/r", description: "d", stargazers_count: 7, forks_count: 2, language: "Python", license: { spdx_id: "MIT" }, pushed_at: "2024-01-01T00:00:00Z", default_branch: "main", topics: ["a"], homepage: "", archived: true };
  if (u.pathname === "/search/repositories") return json(200, { items: [repo] });
  if (u.pathname === "/repos/o/r") return json(200, repo);
  if (u.pathname === "/repos/o/r/readme") {
    if (req.headers.accept === "application/vnd.github.raw") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("# raw"); }
    return json(200, { encoding: "base64", content: Buffer.from("# Héllo\n").toString("base64"), html_url: "https://github.com/o/r#readme" });
  }
  if (u.pathname === "/repos/nore/readme/readme") return json(404, { message: "Not Found" });
  if (u.pathname === "/repos/o/r/contents/") return json(200, [
    { name: "b.py", path: "b.py", type: "file", size: 3 }, { name: "src", path: "src", type: "dir", size: 0 }, { name: "a.md", path: "a.md", type: "file", size: 1 },
  ]);
  if (u.pathname === "/repos/o/r/contents/src/a%20b.txt" || u.pathname === "/repos/o/r/contents/src/a b.txt") { res.writeHead(200); return res.end("hello"); }
  if (u.pathname === "/repos/o/r/contents/bin.dat") { res.writeHead(200); return res.end(Buffer.from([1, 2, 0, 3])); }
  if (u.pathname === "/repos/o/r/contents/big.txt") { res.writeHead(200); return res.end(big); }
  if (u.pathname === "/repos/rl/x") return json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" });
  return json(404, { message: "Not Found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
GH.API_BASE = `http://127.0.0.1:${server.address().port}`;

try {
  const s = await GH.search('Attention "Is" All');
  assert.equal(s[0].fullName, "o/r");
  assert.equal(s[0].stars, 7);
  const sq = new URL(requests.at(-1).url, "http://x").searchParams;
  assert.equal(sq.get("q"), '"Attention  Is  All" in:name,description,readme');
  assert.equal(sq.get("sort"), "stars");
  assert.equal(requests.at(-1).headers.accept, "application/vnd.github+json");
  assert.equal(requests.at(-1).headers["x-github-api-version"], "2022-11-28");
  assert.equal(requests.at(-1).headers.authorization, undefined);

  prefs["github.token"] = "tok";
  const info = await GH.getRepo("https://github.com/o/r");
  assert.equal(requests.at(-1).headers.authorization, "Bearer tok");
  prefs["github.token"] = "";
  assert.deepEqual({ ...info, topics: [...info.topics] }, {
    fullName: "o/r", url: "https://github.com/o/r", description: "d", stars: 7, forks: 2, language: "Python", license: "MIT",
    updatedAt: "2024-01-01T00:00:00Z", defaultBranch: "main", topics: ["a"], homepage: "", archived: true,
  });

  const readme = await GH.getReadme("o/r");
  assert.equal(readme.markdown, "# Héllo\n");
  assert.equal(readme.htmlURL, "https://github.com/o/r#readme");
  // missing README → null
  assert.equal(await GH.getReadme("nore/readme"), null);

  const dir = await GH.listDir("o/r");
  assert.deepEqual(arr(dir.map((e) => e.name)), ["src", "a.md", "b.py"]); // dirs first, then alpha
  assert.equal(dir[0].type, "dir");

  const f = await GH.getFile("o/r", "src/a b.txt");
  assert.deepEqual({ ...f }, { text: "hello", size: 5, truncated: false, binary: false, htmlURL: "https://github.com/o/r/blob/HEAD/src/a%20b.txt" });
  assert.equal(requests.at(-1).headers.accept, "application/vnd.github.raw");
  const bin = await GH.getFile("o/r", "bin.dat");
  assert.equal(bin.binary, true);
  assert.equal(bin.text, "");
  const bg = await GH.getFile("o/r", "big.txt", "main");
  assert.equal(bg.truncated, true);
  assert.equal(bg.text.length, 300 * 1024);
  assert.equal(bg.size, 400 * 1024);
  assert.match(bg.htmlURL, /blob\/main\/big\.txt$/);

  // errors
  await assert.rejects(() => GH.getRepo("o/missing"), (e) => e.status === 404 && /repository lookup/.test(e.message) && /404/.test(e.message));
  await assert.rejects(() => GH.getRepo("rl/x"), (e) => e.status === 403 && /rate limit/i.test(e.message) && /resets at/.test(e.message));
  await assert.rejects(() => GH.getRepo("not a repo"), /Invalid GitHub repository/);
  // abort
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => GH.getRepo("o/r", { signal: ac.signal }), (e) => e.name === "AbortError");
  console.log("github.test: all passed");
} finally {
  server.close();
}
