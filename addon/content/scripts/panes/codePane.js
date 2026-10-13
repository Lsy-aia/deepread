/* "代码" section: the paper's GitHub repository (detect / search / paste), README, file browser and DeepWiki docs + Q&A.
 * Replaces Vibero's paid-proxy code pane with direct GitHub REST and DeepWiki public MCP calls.
 * License: AGPL-3.0-or-later */
/* global DeepRead, Zotero, AbortController, setInterval, clearInterval */

(function () {
  const MAX_LINES = 2000;
  const bi = (zh, en) => DeepRead.bilingual(zh, en);

  function cacheFor(session) {
    const repo = session.githubRepo;
    if (!session._codeCache || session._codeCache.repo !== repo) {
      session._codeCache = {
        repo, info: null, readme: undefined, dirs: new Map(), files: new Map(),
        wiki: { structure: null, pages: null, qa: [] },
      };
    }
    return session._codeCache;
  }

  function uiFor(session) {
    if (!session._codeUI) session._codeUI = { tab: "readme", changing: false, expanded: new Set(), file: null, readmeOpen: false, searchResults: null };
    return session._codeUI;
  }

  function openURL(url) {
    try {
      Zotero.launchURL(url);
    }
    catch (e) {
      DeepRead.log("launchURL failed", String(e));
    }
  }

  function extLink(h, url, label, cls = "dr-code-link") {
    return h("a", { href: url, class: cls, onclick: (e) => { e.preventDefault(); openURL(url); } }, label);
  }

  function fmtNum(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
  }

  function fmtSize(n) {
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
  }

  function showError(h, container, error, scope) {
    DeepRead.log(`code pane ${scope} failed`, DeepRead.util.formatError(error));
    container.append(h("div", { class: "dr-error" }, DeepRead.util.formatError(error)));
  }

  /**
   * Run `fn(signal)` while showing "<label>… Ns" (+ Cancel) in `statusEl`. Resolves to the result, or
   * `undefined` after showing an inline error (or silently when cancelled).
   */
  async function withStatus(h, statusEl, label, fn, scope) {
    const controller = new AbortController();
    const started = Date.now();
    const text = h("span", { class: "dr-muted" });
    const tick = () => { text.textContent = `${label} ${Math.round((Date.now() - started) / 1000)} s`; };
    tick();
    const timer = setInterval(tick, 1000);
    statusEl.replaceChildren(h("div", { class: "dr-code-busy" }, text,
      h("button", { class: "dr-link-button", onclick: () => controller.abort() }, bi("取消", "Cancel"))));
    try {
      const result = await fn(controller.signal);
      statusEl.replaceChildren();
      return result;
    }
    catch (e) {
      statusEl.replaceChildren();
      if (e?.name === "AbortError") return undefined;
      showError(h, statusEl, e, scope);
      return undefined;
    }
    finally {
      clearInterval(timer);
    }
  }

  /* ---------------- repository selection ---------------- */

  function repoListItem(h, item, onPick) {
    return h("button", { class: "dr-code-candidate", onclick: () => onPick(item.fullName), title: item.url },
      h("span", { class: "dr-code-cand-name" }, item.fullName),
      item.stars !== undefined ? h("span", { class: "dr-muted dr-small" }, ` ★ ${fmtNum(item.stars)}`) : null,
      item.count ? h("span", { class: "dr-muted dr-small" }, ` · ${bi(`提及 ${item.count} 次`, `mentioned ${item.count}×`)}`) : null,
      item.description ? h("div", { class: "dr-muted dr-small dr-code-cand-desc" }, item.description) : null);
  }

  function renderPicker(ctx, root) {
    const { session, h } = ctx;
    const ui = uiFor(session);
    const pick = (fullName) => {
      ui.changing = false;
      ui.searchResults = null;
      session.setGitHubRepo(fullName).catch((e) => DeepRead.Panes.reportError(session, e));
    };
    const box = h("div", { class: "dr-code-picker" });
    root.append(box);

    // 1. detected candidates
    const detected = h("div", { class: "dr-code-section" });
    box.append(detected);
    if (!session._codeDetect) {
      session._codeDetect = (async () => {
        try {
          return DeepRead.GitHub.findReposInText(await session.paperText());
        }
        catch (e) {
          DeepRead.log("github detection failed", String(e));
          return [];
        }
      })();
    }
    detected.append(h("div", { class: "dr-muted" }, bi("正在论文中查找 GitHub 仓库…", "Looking for a GitHub repository in the paper…")));
    session._codeDetect.then((list) => {
      if (!detected.isConnected) return;
      detected.replaceChildren();
      if (list.length) {
        detected.append(h("div", { class: "dr-code-label" }, bi("论文中提到的仓库", "Repositories mentioned in the paper")));
        for (const c of list.slice(0, 5)) detected.append(repoListItem(h, c, pick));
      }
      else {
        detected.append(h("div", { class: "dr-muted" }, bi("论文中没有找到 GitHub 链接。", "No GitHub link found in the paper.")));
      }
    });

    // 2. search by title
    const searchBox = h("div", { class: "dr-code-section" });
    const results = h("div", { class: "dr-code-results" });
    const status = h("div", {});
    const renderResults = () => {
      results.replaceChildren();
      if (!ui.searchResults) return;
      if (!ui.searchResults.length) results.append(h("div", { class: "dr-muted" }, bi("没有搜索结果。", "No results.")));
      for (const r of ui.searchResults) results.append(repoListItem(h, r, pick));
    };
    const title = String(session.parentItem?.getField?.("title") || "").trim();
    const searchButton = h("button", {
      class: "dr-primary-button",
      disabled: title ? null : true,
      onclick: async () => {
        const found = await withStatus(h, status, bi("正在搜索 GitHub…", "Searching GitHub…"),
          (signal) => DeepRead.GitHub.search(title, { signal }), "search");
        if (found) {
          ui.searchResults = found;
          renderResults();
        }
      },
    }, bi("按标题搜索 GitHub", "Search GitHub by title"));
    searchBox.append(searchButton, status, results);
    box.append(searchBox);
    renderResults();

    // 3. paste URL
    const input = h("input", { type: "text", class: "dr-code-input", placeholder: bi("粘贴仓库链接，如 https://github.com/owner/repo", "Paste a repo URL, e.g. https://github.com/owner/repo") });
    const manualError = h("div", {});
    const submit = () => {
      manualError.replaceChildren();
      const parsed = DeepRead.GitHub.parseRepo(input.value);
      if (!parsed) {
        manualError.append(h("div", { class: "dr-error" }, bi("无法识别的 GitHub 仓库地址。", "Not a valid GitHub repository URL.")));
        return;
      }
      pick(parsed.fullName);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    box.append(h("div", { class: "dr-code-section dr-code-row" }, input, h("button", { class: "dr-primary-button", onclick: submit }, bi("使用", "Use"))), manualError);

    if (session.githubRepo) {
      box.append(h("button", { class: "dr-link-button", onclick: () => { ui.changing = false; render(ctx.body, ctx); } }, bi("取消更换", "Cancel")));
    }
  }

  /* ---------------- repo card ---------------- */

  function renderRepoCard(ctx, root, cache) {
    const { session, h } = ctx;
    const ui = uiFor(session);
    const fullName = session.githubRepo;
    const card = h("div", { class: "dr-code-repo" });
    const fill = () => {
      const info = cache.info;
      card.replaceChildren(
        h("div", { class: "dr-code-repo-head" },
          extLink(h, `https://github.com/${fullName}`, fullName, "dr-code-repo-name"),
          info?.archived ? h("span", { class: "dr-chip dr-code-archived" }, bi("已归档", "Archived")) : null),
        info?.description ? h("div", { class: "dr-code-repo-desc" }, info.description) : null,
        info ? h("div", { class: "dr-muted dr-small dr-code-meta" },
          `★ ${fmtNum(info.stars)}`,
          info.language ? ` · ${info.language}` : "",
          info.license ? ` · ${info.license}` : "",
          info.updatedAt ? ` · ${bi("更新于", "updated")} ${fmtDate(info.updatedAt)}` : "") : null,
        h("div", { class: "dr-code-actions" },
          extLink(h, `https://github.com/${fullName}`, "GitHub"),
          extLink(h, `https://deepwiki.com/${fullName}`, "DeepWiki"),
          h("button", { class: "dr-link-button", onclick: () => { ui.changing = true; render(ctx.body, ctx); } }, bi("更换", "Change"))));
    };
    fill();
    root.append(card);
    if (!cache.info) {
      DeepRead.GitHub.getRepo(fullName).then((info) => {
        cache.info = info;
        if (card.isConnected) fill();
      }).catch((e) => {
        DeepRead.log("github getRepo failed", DeepRead.util.formatError(e));
        if (card.isConnected) card.append(h("div", { class: "dr-error" }, DeepRead.util.formatError(e)));
      });
    }
  }

  /* ---------------- README tab ---------------- */

  function renderReadme(ctx, panel, cache) {
    const { session, doc, h } = ctx;
    const ui = uiFor(session);
    const status = h("div", {});
    panel.append(status);
    const show = () => {
      if (!cache.readme) {
        panel.append(h("div", { class: "dr-muted" }, bi("该仓库没有 README。", "This repository has no README.")));
        return;
      }
      const md = h("div", { class: "dr-markdown dr-code-readme" });
      md.append(DeepRead.Markdown.render(doc, cache.readme.markdown, md));
      DeepRead.Markdown.wireLinks(md);
      const toggle = h("button", { class: "dr-link-button" });
      const apply = () => {
        md.classList.toggle("dr-collapsed", !ui.readmeOpen);
        toggle.textContent = ui.readmeOpen ? bi("收起", "Collapse") : bi("展开", "Expand");
      };
      toggle.addEventListener("click", () => { ui.readmeOpen = !ui.readmeOpen; apply(); });
      apply();
      panel.append(md, h("div", { class: "dr-code-actions" }, toggle, extLink(h, cache.readme.htmlURL, bi("在 GitHub 打开", "Open on GitHub"))));
    };
    if (cache.readme !== undefined) {
      show();
      return;
    }
    withStatus(h, status, bi("正在加载 README…", "Loading README…"), (signal) => DeepRead.GitHub.getReadme(session.githubRepo, { signal }), "readme")
      .then((readme) => {
        if (readme === undefined || !panel.isConnected) return; // error or cancelled; nothing cached
        cache.readme = readme;
        show();
      });
  }

  /* ---------------- Files tab ---------------- */

  function renderCode(h, text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const shown = lines.slice(0, MAX_LINES);
    const pre = h("pre", { class: "dr-code" });
    shown.forEach((line, i) => {
      pre.append(h("span", { class: "dr-code-line", "data-n": String(i + 1) }, line), "\n");
    });
    return { pre, total: lines.length, shown: shown.length };
  }

  function renderFiles(ctx, panel, cache) {
    const { session, h } = ctx;
    const ui = uiFor(session);
    const repo = session.githubRepo;
    const ref = cache.info?.defaultBranch || undefined;
    const tree = h("div", { class: "dr-code-tree" });
    const viewer = h("div", { class: "dr-code-viewer" });
    panel.append(tree, viewer);

    const showFile = async (entry) => {
      ui.file = entry;
      for (const row of tree.querySelectorAll(".dr-code-file.dr-selected")) row.classList.remove("dr-selected");
      for (const row of tree.querySelectorAll(".dr-code-file")) if (row.dataset.path === entry.path) row.classList.add("dr-selected");
      viewer.replaceChildren();
      const status = h("div", {});
      viewer.append(status);
      let file = cache.files.get(entry.path);
      if (!file) {
        file = await withStatus(h, status, bi("正在加载文件…", "Loading file…"), (signal) => DeepRead.GitHub.getFile(repo, entry.path, ref, { signal }), "file");
        if (!file) return;
        cache.files.set(entry.path, file);
      }
      if (!viewer.isConnected || ui.file !== entry) return;
      viewer.replaceChildren(h("div", { class: "dr-code-filehead" },
        h("strong", {}, entry.path),
        h("span", { class: "dr-muted dr-small" }, ` ${fmtSize(file.size)}`),
        " ", extLink(h, file.htmlURL, bi("在 GitHub 打开", "Open on GitHub"))));
      if (file.binary) {
        viewer.append(h("div", { class: "dr-muted" }, bi("二进制文件，无法预览。", "Binary file; no preview.")));
        return;
      }
      const { pre, total, shown } = renderCode(h, file.text);
      viewer.append(pre);
      if (file.truncated) viewer.append(h("div", { class: "dr-muted dr-small" }, bi(`文件过大，仅加载前 ${fmtSize(DeepRead.GitHub.MAX_FILE_BYTES)}。`, `File is large; only the first ${fmtSize(DeepRead.GitHub.MAX_FILE_BYTES)} were loaded.`)));
      if (shown < total) viewer.append(h("div", { class: "dr-muted dr-small" }, bi(`仅显示前 ${shown} 行（共 ${total} 行）。`, `Showing the first ${shown} of ${total} lines.`)));
    };

    const loadDir = async (path, container, depth) => {
      let entries = cache.dirs.get(path);
      if (!entries) {
        const status = h("div", { class: "dr-code-tree-status", style: { paddingLeft: `${depth * 14}px` } });
        container.append(status);
        entries = await withStatus(h, status, bi("正在加载目录…", "Loading directory…"), (signal) => DeepRead.GitHub.listDir(repo, path, ref, { signal }), "listDir");
        if (!entries) return;
        status.remove();
        cache.dirs.set(path, entries);
      }
      if (!container.isConnected) return;
      for (const entry of entries) {
        const isDir = entry.type === "dir";
        const row = h("div", {
          class: `dr-code-node ${isDir ? "dr-code-dir" : "dr-code-file"}`,
          style: { paddingLeft: `${depth * 14}px` },
          dataset: { path: entry.path },
        });
        const arrow = h("span", { class: "dr-code-arrow" }, isDir ? (ui.expanded.has(entry.path) ? "▾" : "▸") : "");
        row.append(arrow, h("span", { class: "dr-code-name" }, entry.name));
        const children = isDir ? h("div", { class: "dr-code-children" }) : null;
        container.append(row);
        if (children) container.append(children);
        if (isDir) {
          const expand = async () => {
            arrow.textContent = "▾";
            if (!children.childNodes.length) await loadDir(entry.path, children, depth + 1);
          };
          row.addEventListener("click", async () => {
            if (ui.expanded.has(entry.path)) {
              ui.expanded.delete(entry.path);
              arrow.textContent = "▸";
              children.replaceChildren();
            }
            else {
              ui.expanded.add(entry.path);
              await expand();
            }
          });
          if (ui.expanded.has(entry.path)) expand();
        }
        else {
          if (ui.file && ui.file.path === entry.path) row.classList.add("dr-selected");
          row.addEventListener("click", () => showFile(entry));
        }
      }
    };

    loadDir("", tree, 0).then(() => {
      if (ui.file && viewer.isConnected && cache.files.has(ui.file.path)) showFile(ui.file);
    });
  }

  /* ---------------- DeepWiki tab ---------------- */

  /** "- 2.1 Dataset Catalog" lines → [{ level, number, title }]. */
  function parseStructure(text) {
    const items = [];
    for (const line of String(text || "").split("\n")) {
      const m = /^(\s*)- (?:(\d+(?:\.\d+)*)\s+)?(.+?)\s*$/.exec(line);
      if (m) items.push({ level: Math.floor(m[1].length / 2), number: m[2] || "", title: m[3] });
    }
    return items;
  }

  function renderWiki(ctx, panel, cache) {
    const { session, doc, h } = ctx;
    const wiki = cache.wiki;
    const repo = session.githubRepo;
    const status = h("div", {});
    const listBox = h("div", { class: "dr-code-wikilist" });
    const pageBox = h("div", { class: "dr-code-wikipage" });

    const md = (text, cls = "dr-markdown") => {
      const el = h("div", { class: cls });
      el.append(DeepRead.Markdown.render(doc, text, el));
      DeepRead.Markdown.wireLinks(el);
      return el;
    };

    const showPage = async (item) => {
      pageBox.replaceChildren();
      const pstatus = h("div", {});
      pageBox.append(pstatus);
      if (!wiki.pages) {
        const text = await withStatus(h, pstatus,
          bi("正在加载全部文档（一次性返回，可能较大）…", "Loading the whole wiki (returned in one piece, may be large)…"),
          (signal) => DeepRead.DeepWiki.readWikiContents(repo, { signal }), "wiki contents");
        if (text === undefined) return;
        wiki.pages = DeepRead.DeepWiki.splitPages(text);
      }
      if (!pageBox.isConnected) return;
      const key = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
      const page = wiki.pages.find((p) => key(p.title) === key(item.title));
      pageBox.replaceChildren(page ? md(`# ${page.title}\n\n${page.markdown}`)
        : h("div", { class: "dr-muted" }, bi("未找到该章节内容。", "Section content not found.")));
      pageBox.scrollIntoView?.({ block: "nearest" });
    };

    const showList = () => {
      listBox.replaceChildren();
      const items = parseStructure(wiki.structure);
      if (!items.length) {
        listBox.append(md(wiki.structure));
        return;
      }
      for (const item of items) {
        listBox.append(h("div", {
          class: "dr-code-wikiitem dr-clickable",
          style: { paddingLeft: `${item.level * 14}px` },
          onclick: () => showPage(item),
        }, item.number ? h("span", { class: "dr-muted" }, `${item.number} `) : null, item.title));
      }
    };

    const loadButton = h("button", {
      class: "dr-primary-button",
      onclick: async () => {
        const text = await withStatus(h, status, bi("正在加载文档结构…", "Loading docs structure…"),
          (signal) => DeepRead.DeepWiki.readWikiStructure(repo, { signal }), "wiki structure");
        if (text === undefined || !panel.isConnected) return;
        wiki.structure = text;
        loadButton.remove();
        showList();
      },
    }, bi("加载文档", "Load docs"));

    panel.append(h("div", { class: "dr-code-hint dr-muted dr-small" },
      bi("文档由 deepwiki.com 生成并通过其公开 MCP 服务读取。", "Docs are generated by deepwiki.com and read through its public MCP server.")));
    if (wiki.structure === null) panel.append(loadButton);
    panel.append(status, listBox, pageBox);
    if (wiki.structure !== null) showList();

    // Ask DeepWiki
    const qaBox = h("div", { class: "dr-code-qa" });
    const qaList = h("div", {});
    const qaStatus = h("div", {});
    const input = h("input", { type: "text", class: "dr-code-input", placeholder: bi("就这个仓库提问…", "Ask about this repository…") });
    const renderQA = () => {
      qaList.replaceChildren();
      for (const qa of wiki.qa) {
        qaList.append(h("div", { class: "dr-code-q" }, qa.question), md(qa.answer, "dr-markdown dr-code-a"));
      }
    };
    const ask = async () => {
      const question = input.value.trim();
      if (!question) return;
      const answer = await withStatus(h, qaStatus, bi("DeepWiki 正在回答…", "DeepWiki is answering…"),
        (signal) => DeepRead.DeepWiki.askQuestion(repo, question, { signal }), "ask");
      if (answer === undefined) return;
      wiki.qa.push({ question, answer });
      input.value = "";
      if (qaList.isConnected) renderQA();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ask(); } });
    qaBox.append(
      h("div", { class: "dr-code-label" }, bi("问 DeepWiki", "Ask DeepWiki")),
      h("div", { class: "dr-code-row" }, input, h("button", { class: "dr-primary-button", onclick: ask }, bi("提问", "Ask"))),
      h("div", { class: "dr-muted dr-small" }, bi(`你的问题和仓库名（${repo}）会发送到 deepwiki.com。`, `Your question and the repository name (${repo}) are sent to deepwiki.com.`)),
      qaStatus, qaList);
    panel.append(qaBox);
    renderQA();
  }

  /* ---------------- main ---------------- */

  function render(body, ctx) {
    const { session, h } = ctx;
    const ui = uiFor(session);
    const root = h("div", { class: "dr-pane dr-code-pane" });
    body._drCode = { root, repo: session.githubRepo, changing: ui.changing };

    if (!session.githubRepo || ui.changing) {
      if (!session.githubRepo) root.append(h("div", { class: "dr-muted" }, bi("选择这篇论文对应的 GitHub 仓库。", "Choose the GitHub repository for this paper.")));
      renderPicker({ ...ctx, body }, root);
      body.replaceChildren(root);
      return;
    }

    const cache = cacheFor(session);
    renderRepoCard({ ...ctx, body }, root, cache);

    const tabs = h("div", { class: "dr-code-tabs" });
    const panel = h("div", { class: "dr-code-panel" });
    const defs = [
      ["readme", "README", renderReadme],
      ["files", bi("文件", "Files"), renderFiles],
      ["wiki", "DeepWiki", renderWiki],
    ];
    const select = (key) => {
      ui.tab = key;
      for (const btn of tabs.children) btn.classList.toggle("dr-active", btn.dataset.tab === key);
      panel.replaceChildren();
      const def = defs.find((d) => d[0] === key) || defs[0];
      def[2]({ ...ctx, body }, panel, cache);
    };
    for (const [key, label] of defs) {
      tabs.append(h("button", { class: "dr-code-tab", dataset: { tab: key }, onclick: () => select(key) }, label));
    }
    root.append(tabs, panel);
    body.replaceChildren(root);
    select(defs.some((d) => d[0] === ui.tab) ? ui.tab : "readme");
  }

  DeepRead.Panes.renderers.code = (ctx) => {
    const { body, session, h, event } = ctx;
    if (event !== "change" && event !== "github") return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    // Session "change" events fire during pipeline runs; keep the existing view (and input focus) unless the repo changed.
    const prev = body._drCode;
    if (event === "change" && prev && prev.root.isConnected && prev.repo === session.githubRepo && prev.changing === uiFor(session).changing) return;
    render(body, ctx);
  };
})();
