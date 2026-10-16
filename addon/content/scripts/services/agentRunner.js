/*
 * AgentRunner: runs a local CLI agent (codex / claude) on a prepared work directory
 * and collects the Markdown it writes.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, IOUtils, PathUtils, ChromeUtils, Services */

DeepRead.AgentRunner = (function () {
  const KEEP_OUTPUT = 200 * 1024;

  // Default command templates: program words plus flag groups. A group is skipped when
  // the user's command already contains its leading flag.
  const TEMPLATES = {
    codex: {
      program: ["codex", "exec"],
      groups: [
        ["--skip-git-repo-check"],
        ["--sandbox", "workspace-write"],
        ["--cd", "{workdir}"],
        ["{prompt}"],
      ],
    },
    claude: {
      program: ["claude"],
      groups: [
        ["-p", "{prompt}"],
        ["--permission-mode", "acceptEdits"],
        ["--allowedTools", "Read,Write,Edit,Glob,Grep,Bash(python3:*),Bash(python:*)"],
        ["--add-dir", "{skills}"],
      ],
    },
  };

  // Shell-like splitting: single quotes (literal), double quotes (backslash escapes
  // \" and \\ only), backslash escapes outside single quotes. No globbing/variables.
  function splitArgs(command) {
    const out = [];
    let cur = "";
    let has = false;
    let quote = null;
    const s = String(command || "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote === "'") {
        if (c === "'") quote = null; else cur += c;
      } else if (quote === '"') {
        if (c === '"') quote = null;
        else if (c === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
        else cur += c;
      } else if (c === "'" || c === '"') {
        quote = c;
        has = true;
      } else if (c === "\\" && i + 1 < s.length) {
        cur += s[++i];
        has = true;
      } else if (/\s/.test(c)) {
        if (cur || has) out.push(cur);
        cur = "";
        has = false;
      } else {
        cur += c;
      }
    }
    if (cur || has) out.push(cur);
    return out;
  }

  function fill(token, vars) {
    return token.replace(/\{(prompt|workdir|skills)\}/g, (_, k) => vars[k]);
  }

  // Rule for a command without {prompt}: keep the user's words, then append the kind's
  // template flag groups in template order, skipping groups whose leading flag is already
  // in the command (and "--add-dir {skills}" when skillsDir is empty). The prompt is
  // emitted at its template position: as "-p <prompt>" for claude, or alone as the
  // final positional for codex; if the command already has "-p", only <prompt> is emitted
  // there. e.g. "codex exec" -> default codex args; "/opt/bin/claude -p" -> claude -p <prompt> ...
  function buildArgv({ kind, command, prompt, workdir, skillsDir }) {
    const vars = { prompt: prompt || "", workdir: workdir || "", skills: skillsDir || "" };
    const tpl = TEMPLATES[kind];
    let words;
    if (command && command.trim()) {
      words = splitArgs(command);
      if (!words.some((w) => w.includes("{prompt}"))) {
        if (!tpl) throw new Error("command needs a {prompt} placeholder");
        const next = words.slice();
        for (const g of tpl.groups) {
          const hasPrompt = g.includes("{prompt}");
          if (g[0].startsWith("-") && words.includes(g[0])) {
            if (hasPrompt) next.push("{prompt}");
            continue;
          }
          if (g.includes("{skills}") && !vars.skills) continue;
          next.push(...g);
        }
        words = next;
      }
    } else {
      if (!tpl) throw new Error("no default command for kind: " + kind);
      words = tpl.program.slice();
      for (const g of tpl.groups) {
        if (g.includes("{skills}") && !vars.skills) continue;
        words.push(...g);
      }
    }
    const argv = words.map((w) => fill(w, vars));
    return { file: argv[0], args: argv.slice(1) };
  }

  function skillRoots(home) {
    return [
      home + "/agents/codex/skills",
      home + "/.codex/skills",
      home + "/.claude/skills",
      home + "/.agents/skills",
    ];
  }

  function extraDirs(home) {
    return [
      home + "/.local/bin",
      home + "/.npm-global/bin",
      home + "/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      home + "/.volta/bin",
      home + "/.bun/bin",
    ];
  }

  function splitPath(p, isWin) {
    if (Array.isArray(p)) return p.filter(Boolean);
    return String(p || "").split(isWin ? ";" : ":").filter(Boolean);
  }

  function isAbs(name, isWin) {
    return name.startsWith("/") || (isWin && /^[A-Za-z]:[\\/]/.test(name));
  }

  function executableCandidates(name, { path, home, isWin } = {}) {
    if (isAbs(name, isWin)) return [name];
    const sep = isWin ? "\\" : "/";
    const variants = isWin ? [name + ".cmd", name + ".exe", name + ".bat", name] : [name];
    const dirs = splitPath(path, isWin).concat(extraDirs(home || ""));
    const out = [];
    for (const d of dirs) {
      const base = d.replace(/[\\/]+$/, "");
      for (const v of variants) {
        const p = base + sep + v;
        if (!out.includes(p)) out.push(p);
      }
    }
    return out;
  }

  function envPath({ path, exeDir, home } = {}) {
    const sep = /^[A-Za-z]:\\/.test(exeDir || "") || String(path || "").includes(";") ? ";" : ":";
    const parts = [exeDir].concat(splitPath(path, sep === ";"), extraDirs(home || ""));
    const out = [];
    for (const p of parts) if (p && !out.includes(p)) out.push(p);
    return out.join(sep);
  }

  // ---- Zotero side ----

  function homeDir() {
    try { return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path; } catch (e) { return ""; }
  }
  function isWindows() {
    try { return Services.appinfo.OS === "WINNT"; } catch (e) { return false; }
  }
  function envGet(k) {
    try { return Services.env.get(k) || ""; } catch (e) { return ""; }
  }

  async function findExecutable(name) {
    const home = homeDir();
    const isWin = isWindows();
    const cands = executableCandidates(name, { path: envGet("PATH"), home, isWin });
    if (cands.length === 1 && isAbs(name, isWin)) return (await IOUtils.exists(name)) ? name : null;
    try {
      const nvm = home + "/.nvm/versions/node";
      if (await IOUtils.exists(nvm)) {
        const vers = (await IOUtils.getChildren(nvm)).sort().reverse();
        for (const v of vers) cands.push(v + "/bin/" + name);
      }
    } catch (e) { /* ignore */ }
    for (const p of cands) {
      try {
        if (await IOUtils.exists(p)) return p;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  async function findSkills(names) {
    const roots = skillRoots(homeDir());
    const found = [];
    for (const name of names || []) {
      for (const r of roots) {
        const p = r + "/" + name + "/SKILL.md";
        try {
          if (await IOUtils.exists(p)) { found.push({ name, path: p }); break; }
        } catch (e) { /* ignore */ }
      }
    }
    return found;
  }

  function stamp(d) {
    const z = (n) => String(n).padStart(2, "0");
    return "" + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" +
      z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
  }

  async function prepareWorkdir({ baseDir, files }) {
    const dir = baseDir + "/" + stamp(new Date());
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    for (const [name, text] of Object.entries(files || {})) {
      await IOUtils.writeUTF8(dir + "/" + name, text);
    }
    return dir;
  }

  async function run({ argv, workdir, timeoutMs, onOutput, signal }) {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const home = homeDir();
    const exeDir = argv.file.includes("/") ? argv.file.replace(/\/[^/]*$/, "") : "";
    const proc = await Subprocess.call({
      command: argv.file,
      arguments: argv.args,
      workdir,
      environment: { PATH: envPath({ path: envGet("PATH"), exeDir, home }), HOME: home },
      environmentAppend: true,
      stderr: "stdout",
    });
    // CLI agents read piped stdin until EOF (claude -p appends it to the prompt): give them none.
    try {
      await proc.stdin.close();
    }
    catch (e) { /* already closed */ }
    let timedOut = false;
    let aborted = false;
    const kill = () => { try { proc.kill(); } catch (e) { /* already gone */ } };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort);
    }
    let output = "";
    try {
      for (;;) {
        const chunk = await proc.stdout.readString();
        if (!chunk) break;
        output += chunk;
        if (output.length > KEEP_OUTPUT) output = output.slice(-KEEP_OUTPUT);
        if (onOutput) { try { onOutput(chunk); } catch (e) { /* ignore */ } }
      }
    } catch (e) {
      // pipe closed by kill
    }
    const { exitCode } = await proc.wait();
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    return { exitCode, output, timedOut, aborted };
  }

  async function readIf(p) {
    try {
      if (await IOUtils.exists(p)) return await IOUtils.readUTF8(p);
    } catch (e) { /* ignore */ }
    return "";
  }

  async function collect(workdir) {
    const xray = await readIf(workdir + "/xray.md");
    const card = await readIf(workdir + "/paper-card.md");
    let files = [];
    try {
      const kids = await IOUtils.getChildren(workdir);
      files = kids.map((k) => k.split(/[\\/]/).pop())
        .filter((n) => /\.md$/i.test(n) && !["xray.md", "paper-card.md", "paper.md"].includes(n))
        .sort();
    } catch (e) { /* ignore */ }
    return { xray, card, files };
  }

  return {
    splitArgs, buildArgv, skillRoots, executableCandidates, envPath,
    findExecutable, findSkills, prepareWorkdir, run, collect,
  };
})();
