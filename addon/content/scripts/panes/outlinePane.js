/* "AI 大纲" section: LLM outline tree (title + one-line summary per section), click to jump.
 * License: AGPL-3.0-or-later */
/* global DeepRead */

(function () {
  function renderNode(ctx, node, depth) {
    const { h, session } = ctx;
    const row = h("div", { class: "dr-outline-row", style: { paddingInlineStart: `${Math.max(0, depth) * 12}px` } });
    const title = h("div", {
      class: "dr-outline-title dr-clickable",
      onclick: () => session.navigateToTitleBlock(node.title_block_id),
    }, node.title || "");
    row.append(title);
    if (node.summary) row.append(h("div", { class: "dr-outline-summary" }, node.summary));
    const points = Array.isArray(node.points) ? node.points.filter((p) => typeof p === "string" && p.trim()) : [];
    if (points.length) {
      row.append(h("ul", { class: "dr-outline-points" }, points.map((p) => h("li", {}, p))));
    }
    const frag = [row];
    for (const child of node.children || []) {
      frag.push(...renderNode(ctx, child, depth + 1));
    }
    return frag;
  }

  DeepRead.Panes.renderers.outline = (ctx) => {
    const { body, session, h, event } = ctx;
    if (event === "ask" || String(event).startsWith("chat")) return;
    if (!session) {
      body.replaceChildren(DeepRead.Panes.noReader(h));
      return;
    }
    const root = h("div", { class: "dr-pane dr-outline-pane" });
    const sections = session.data?.sections;

    if (session.outlineStatus === "running") {
      root.append(h("div", { class: "dr-muted" }, DeepRead.t("outline.generating")));
    }
    else if (session.outlineStatus === "error" && session.outlineError) {
      root.append(h("div", { class: "dr-error" }, session.outlineError));
    }

    if (sections && typeof sections === "object") {
      // The root node is the paper title; show its children as the first level.
      const top = Array.isArray(sections) ? sections : [sections];
      const tree = h("div", { class: "dr-outline-tree" });
      for (const node of top) {
        if (node.level === 0 && Array.isArray(node.children) && node.children.length) {
          tree.append(h("div", { class: "dr-outline-paper" }, node.title || ""));
          if (node.summary) tree.append(h("div", { class: "dr-outline-summary" }, node.summary));
          for (const child of node.children) tree.append(...renderNode(ctx, child, 0));
        }
        else {
          tree.append(...renderNode(ctx, node, 0));
        }
      }
      root.append(tree);
    }
    else if (session.outlineStatus !== "running") {
      const hasData = session.hasResults;
      root.append(h("div", { class: "dr-empty" },
        h("div", { class: "dr-muted" }, hasData ? DeepRead.t("outline.empty") : DeepRead.t("error.noParseData")),
        hasData
          ? h("button", {
            class: "dr-primary-button",
            onclick: () => session.generateOutline().catch((e) => DeepRead.Panes.reportError(session, e)),
          }, DeepRead.t("outline.generate"))
          : null));
    }
    body.replaceChildren(root);
  };
})();
