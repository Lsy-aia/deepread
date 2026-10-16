# DeepRead 带读 (guided reading) — shared contract

## Pipeline
1. Stage A — "agent" writes Markdown about the paper:
   - kind "codex" / "claude": a local CLI agent run in a work directory, using the user's nature skills
     (nature-paper-xray → `xray.md`, a long-read; nature-paper-card → `paper-card.md`, 16 numbered sections).
   - kind "api": a remote OpenAI-compatible model (prefs agent.api.baseURL / apiKey / model) writes the same two
     Markdown documents in one request (DeepRead.Guide.writeWithApi).
   - kind "import": the user picks an existing Markdown (or our JSON) file.
   The paper is given to the agent as `paper.md`: the paper text where every paragraph starts with its block label,
   e.g. `[p. 3 ¶2] In this work we ...`, headings as `## …`, figure/table captions as `> Fig. 3: …`. Agents are asked to
   cite paragraphs with these labels.
2. Stage B — DeepRead.Guide.structure(...) turns the Markdown into the guide JSON below with the main LLM
   (精读 API), mapping cited labels to block keys.

## Block keys and labels
key `p_<pageIndex>_<paragraphIndex>` (0-based) ↔ label `p. <pageIndex+1> ¶<paragraphIndex+1>`.

## Guide JSON (what the UI renders; every field optional except the five step objects)
```json
{
  "type": "algorithmic | methods | hypothesis | research | review | resource | clinical | other",
  "position": {
    "claim": "what the paper really claims, without the marketing (1-3 sentences)",
    "path": [ { "step": "什么失效了 / 作者押了什么 / 押注靠什么撑住", "text": "…", "basis": "source | inference | pending", "keys": ["p_0_3"] } ],
    "focus": ["what to watch for in this paper type, short phrases"],
    "order": [ { "text": "II–III 方法", "minutes": 12, "keys": ["p_1_0"] } ],
    "questions": ["three questions to read with"]
  },
  "skeleton": {
    "moves": [ { "role": "background | gap | prior | contribution | claim | evidence | limitation", "text": "…", "keys": [], "status": "proven | partial | unproven | pending" } ],
    "terms": [ { "term": "visuomotor policy", "translation": "视觉运动策略", "variants": ["visuo-motor policy"] } ]
  },
  "method": {
    "components": [ { "name": "闭环动作序列", "verdict": "load-bearing | contributing | decorative | unestablished | pending", "basis": "why (cite ablation / say none exists)", "keys": [] } ],
    "insight": { "surface": "…", "core": "…", "transferable": "…" },
    "formulas": [ { "latex": "x^{k-1} = \\alpha(x^k - \\gamma\\epsilon_\\theta(x^k,k) + \\mathcal{N}(0,\\sigma^2 I))", "purpose": "…",
                    "symbols": [ { "symbol": "x^k", "shape": "T_p × action dim", "meaning": "…" } ],
                    "example": "worked micro-example with concrete numbers (Markdown, $…$ math)", "keys": [] } ]
  },
  "evidence": {
    "chain": [ { "claim": "…", "evidence": "…", "supports": "what it can support", "notSupports": "what it cannot", "status": "proven | partial | unproven | pending", "keys": [] } ],
    "checks": [ { "text": "baselines tuned with the same budget?", "effect": "changes | weakens | scopes | wording", "state": "open | ok | problem" } ],
    "hedges": [ { "quote": "likely due to", "strength": "strong | hedged | speculative | outlook", "note": "…", "keys": [] } ]
  },
  "takeaway": {
    "summary": "one sentence",
    "learned": ["…"],
    "ideas": [ { "title": "…", "basis": "…", "hypothesis": "…", "test": "…", "risk": "…" } ]
  }
}
```
Session stores `{ ...guideJson, markdown: { xray, card }, meta: { kind, skills: [], model, startedAt, finishedAt, source } }`.

## UI labels (zh / en)
steps: ① 定位 Position · ② 骨架 Skeleton · ③ 方法 Method · ④ 证据 Evidence · ⑤ 带走 Takeaway
verdict: load-bearing 承重 / contributing 贡献 / decorative 装饰 / unestablished 未确立 / pending 待定
status: proven ● 已证 / partial ◐ 部分 / unproven ✕ 未证 / pending ○ 待读
strength: strong 强断言 / hedged 保留 / speculative 推测 / outlook 展望
basis: source 原文 / inference 推断 / pending 待读
effect: changes 改变结论 / weakens 削弱结论 / scopes 限定范围 / wording 仅表述问题
