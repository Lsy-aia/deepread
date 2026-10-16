// Tests for DeepRead.AgentRunner pure helpers. Run: node test/agentRunner.test.mjs
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { console, setTimeout, clearTimeout };
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.DeepRead = {};
vm.runInContext(fs.readFileSync(path.join(root, "addon/content/scripts/services/agentRunner.js"), "utf8"), ctx, { filename: "agentRunner.js" });
const A = ctx.DeepRead.AgentRunner;
const plain = (x) => JSON.parse(JSON.stringify(x));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n  ${e.stack || e}`); }
}

test("splitArgs", () => {
  assert.deepEqual(plain(A.splitArgs("")), []);
  assert.deepEqual(plain(A.splitArgs("  a   b ")), ["a", "b"]);
  assert.deepEqual(plain(A.splitArgs(`a 'b c' "d e" f\\ g`)), ["a", "b c", "d e", "f g"]);
  assert.deepEqual(plain(A.splitArgs(`"a \\"q\\" b" 'x\\y' ""`)), ['a "q" b', "x\\y", ""]);
  assert.deepEqual(plain(A.splitArgs("a$HOME *.md")), ["a$HOME", "*.md"]);
});

test("buildArgv codex default", () => {
  const r = A.buildArgv({ kind: "codex", command: "", prompt: "do it 'now'\nplease", workdir: "/w", skillsDir: "" });
  assert.equal(r.file, "codex");
  assert.deepEqual(plain(r.args), ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", "/w", "do it 'now'\nplease"]);
});

test("buildArgv claude default and empty skillsDir", () => {
  const r = A.buildArgv({ kind: "claude", command: "", prompt: "p q", workdir: "/w", skillsDir: "/s" });
  assert.equal(r.file, "claude");
  assert.deepEqual(plain(r.args), ["-p", "p q", "--permission-mode", "acceptEdits", "--allowedTools",
    "Read,Write,Edit,Glob,Grep,Bash(python3:*),Bash(python:*)", "--add-dir", "/s"]);
  const r2 = A.buildArgv({ kind: "claude", command: "", prompt: "p", workdir: "/w", skillsDir: "" });
  assert.ok(!r2.args.includes("--add-dir"));
  assert.equal(r2.args.length, 6);
});

test("custom template with placeholders", () => {
  const r = A.buildArgv({ kind: "codex", command: "node fake.mjs --cd {workdir} --skills={skills} {prompt}", prompt: "a b", workdir: "/w x", skillsDir: "/s" });
  assert.equal(r.file, "node");
  assert.deepEqual(plain(r.args), ["fake.mjs", "--cd", "/w x", "--skills=/s", "a b"]);
});

test("command without {prompt}: codex", () => {
  const r = A.buildArgv({ kind: "codex", command: "/opt/bin/codex exec", prompt: "P", workdir: "/w", skillsDir: "" });
  assert.equal(r.file, "/opt/bin/codex");
  assert.deepEqual(plain(r.args), ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", "/w", "P"]);
  const r2 = A.buildArgv({ kind: "codex", command: "codex exec --sandbox read-only", prompt: "P", workdir: "/w", skillsDir: "" });
  assert.deepEqual(plain(r2.args), ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/w", "P"]);
});

test("command without {prompt}: claude", () => {
  const r = A.buildArgv({ kind: "claude", command: "/opt/bin/claude -p", prompt: "P Q", workdir: "/w", skillsDir: "/s" });
  assert.equal(r.file, "/opt/bin/claude");
  assert.deepEqual(plain(r.args), ["-p", "P Q", "--permission-mode", "acceptEdits", "--allowedTools",
    "Read,Write,Edit,Glob,Grep,Bash(python3:*),Bash(python:*)", "--add-dir", "/s"]);
  const r2 = A.buildArgv({ kind: "claude", command: "claude --model x", prompt: "P", workdir: "/w", skillsDir: "" });
  assert.deepEqual(plain(r2.args).slice(0, 4), ["--model", "x", "-p", "P"]);
});

test("skillRoots", () => {
  assert.deepEqual(plain(A.skillRoots("/h")), ["/h/agents/codex/skills", "/h/.codex/skills", "/h/.claude/skills", "/h/.agents/skills"]);
});

test("executableCandidates", () => {
  const c = plain(A.executableCandidates("codex", { path: "/a/bin:/usr/local/bin", home: "/h", isWin: false }));
  assert.deepEqual(c, ["/a/bin/codex", "/usr/local/bin/codex", "/h/.local/bin/codex", "/h/.npm-global/bin/codex", "/h/bin/codex",
    "/opt/homebrew/bin/codex", "/h/.volta/bin/codex", "/h/.bun/bin/codex"]);
  assert.deepEqual(plain(A.executableCandidates("/x/codex", { path: "/a", home: "/h" })), ["/x/codex"]);
  const w = plain(A.executableCandidates("codex", { path: "C:\\bin;D:\\t", home: "C:\\u", isWin: true }));
  assert.deepEqual(w.slice(0, 4), ["C:\\bin\\codex.cmd", "C:\\bin\\codex.exe", "C:\\bin\\codex.bat", "C:\\bin\\codex"]);
  assert.ok(w.includes("D:\\t\\codex.cmd"));
});

test("envPath order and dedupe", () => {
  const p = A.envPath({ path: "/usr/bin:/usr/local/bin:/usr/bin", exeDir: "/n/bin", home: "/h" });
  const parts = p.split(":");
  assert.equal(parts[0], "/n/bin");
  assert.equal(parts[1], "/usr/bin");
  assert.equal(parts[2], "/usr/local/bin");
  assert.equal(new Set(parts).size, parts.length);
  assert.ok(parts.includes("/h/.local/bin"));
  assert.equal(A.envPath({ path: "/a", exeDir: "", home: "/h" }).split(":")[0], "/a");
});

test("fake-agent end to end", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepread-fake-"));
  try {
    fs.writeFileSync(path.join(dir, "paper.md"), "[p. 1 ¶1] A.\n[p. 2 ¶3] B.\n[p. 4 ¶1] C.\n[p. 5 ¶2] D.\n");
    const r = spawnSync(process.execPath, [path.join(root, "test/fake-agent.mjs"), "--cd", dir, "--slow", "40", "hello"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /DEEPREAD_DONE/);
    const x = fs.readFileSync(path.join(dir, "xray.md"), "utf8");
    assert.match(x, /\[p\. 2 ¶3\]/);
    assert.match(x, /\$\$[\s\S]+\$\$/);
    for (const h of ["这篇真正主张什么", "研究路径", "承重部件", "公式手算", "证据边界"]) assert.ok(x.includes(h));
    const c = fs.readFileSync(path.join(dir, "paper-card.md"), "utf8");
    assert.equal((c.match(/^## \d\d /gm) || []).length, 16);
    const f = spawnSync(process.execPath, [path.join(root, "test/fake-agent.mjs"), "--cd", dir, "--fail"], { encoding: "utf8" });
    assert.equal(f.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
