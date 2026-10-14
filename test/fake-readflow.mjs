#!/usr/bin/env node
// Fake ReadFlow Rust API (the subset DeepRead.ReadFlow uses), shapes taken from ReadFlow's
// backend/api/docs/api-spec/*.md and Rust sources.
//   node test/fake-readflow.mjs [--port 41999] [--key retain-pdf-desktop] [--polls-per-stage 2]
// Behaviour:
//   GET  /health                          (no auth)  {code,message,data:{status,provider_backends,...}}
//   everything else needs X-API-Key       else 401 {code:40100,message:"missing or invalid X-API-Key",error:{...}}
//   POST /api/v1/uploads (multipart file) → {upload_id, filename, bytes, page_count}
//   GET|POST /api/v1/credentials, GET|PUT /api/v1/credentials/:ref   (vault; secrets never returned)
//   GET  /api/v1/providers/ocr            → [{key:"mineru"},{key:"paddle"},{key:"local"}]
//   POST /api/v1/jobs                     → validates (deny_unknown_fields, enums, credential_ref), queued job
//   GET  /api/v1/jobs/:id                 → status/stages/stage_snapshot/artifacts/failure; advances one step per poll
//   GET  /api/v1/jobs/:id/pdf             → the uploaded PDF bytes (stand-in for the rendered PDF)
//   POST /api/v1/jobs/:id/cancel
// Special translation.model values: "fake-fail" → job fails at translation with a failure object;
// "fake-slow" → job stays in translation until canceled.
// Logs one line per request (render_mode / model for job creation; never keys).
import http from "node:http";
import { pathToFileURL } from "node:url";

const RENDER_MODES = ["auto", "overlay", "typst", "typst_visual", "dual"];
const OCR_PROVIDERS = ["mineru", "paddle", "local"];
const TOP = ["workflow", "source", "ocr", "translation", "render", "runtime"];

export function createFakeReadFlow({ apiKey = "retain-pdf-desktop", pollsPerStage = 2, log = () => {} } = {}) {
  const state = { uploads: new Map(), credentials: new Map(), jobs: new Map(), requests: [], nextId: 1, vaultRevision: 0 };
  const stamp = () => new Date().toISOString();
  const ok = (data) => ({ code: 0, message: "ok", data });
  const err = (status, code, message, extra = {}) => ({
    status,
    body: { code: status * 100, message, error: { code, http_status: status, details: {} }, ...extra },
  });

  function multipartFile(req, buf) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers["content-type"] || "");
    if (!m) return null;
    const boundary = Buffer.from("--" + (m[1] || m[2]));
    const start = buf.indexOf(boundary);
    if (start < 0) return null;
    const headEnd = buf.indexOf("\r\n\r\n", start);
    const head = buf.subarray(start, headEnd).toString("latin1");
    const nameMatch = /name="([^"]+)"/.exec(head);
    const fileMatch = /filename="([^"]*)"/.exec(head);
    const next = buf.indexOf(boundary, headEnd);
    const data = buf.subarray(headEnd + 4, next - 2);
    return { field: nameMatch?.[1], filename: fileMatch?.[1], data };
  }

  function stagesFor(job) {
    const step = job.step; // 0 queued, 1..P ocr, P+1..2P translate, 2P+1..3P render, done
    const P = pollsPerStage;
    const pct = (s, lo) => Math.min(100, Math.round(((s - lo) / P) * 100));
    const st = (name) => {
      const idx = { ocr: 0, translation: 1, render: 2 }[name];
      const lo = idx * P + 1;
      if (job.status === "succeeded" || step > lo + P - 1) return { state: "completed", progress: { current: null, total: null, percent: null } };
      if (job.status === "queued" || step < lo) return { state: "pending", progress: { current: null, total: null, percent: null } };
      return { state: "in_progress", progress: { unit: "batch", current: step - lo, total: P, percent: pct(step, lo) } };
    };
    return { ocr: st("ocr"), translation: st("translation"), render: st("render") };
  }

  function advance(job) {
    if (["succeeded", "failed", "canceled"].includes(job.status)) return;
    const P = pollsPerStage;
    job.step += 1;
    if (job.step >= 1) job.status = "running";
    if (job.model === "fake-slow" && job.step > P) job.step = P + 1;
    else if (job.model === "fake-fail" && job.step > P + 1) {
      job.status = "failed";
      job.failure = {
        stage: "translating", category: "upstream", code: "translation_provider_error", failed_stage: "translating",
        failure_code: "translation_provider_error", summary: "translation model rejected the request (HTTP 401)",
        root_cause: "upstream returned 401 Unauthorized", retryable: false, upstream_host: "llm.example.invalid",
        suggestion: "Check the LLM API key and base URL", last_log_line: "translate: batch 1 failed",
      };
    }
    else if (job.step > 3 * P) job.status = "succeeded";
  }

  function jobView(job) {
    const stages = stagesFor(job);
    const active = ["ocr", "translation", "render"].find((k) => stages[k].state === "in_progress");
    const detail = { ocr: "正在识别页面", translation: "正在翻译", render: "正在渲染" };
    const snapshot = active && job.status === "running"
      ? { display_stage: active, stage: { ocr: "ocr_processing", translation: "translating", render: "rendering" }[active],
        substage: null, lane: "main", stage_detail: detail[active], progress: stages[active].progress }
      : null;
    const done = job.status === "succeeded";
    const base = `/api/v1/jobs/${job.id}`;
    const view = {
      job_id: job.id, workflow: "book", status: job.status, ocr_reused: false, source_artifact_job_id: null,
      stage_snapshot: snapshot, background_snapshots: [], stages,
      timestamps: { created_at: job.created, updated_at: stamp(), started_at: null, finished_at: null, duration_seconds: null },
      links: { self_path: base, cancel_path: `${base}/cancel` },
      artifacts: {
        pdf_ready: done, markdown_ready: false, bundle_ready: false, pdf_url: `${base}/pdf`,
        pdf: { ready: done, path: `${base}/pdf`, content_type: "application/pdf", file_name: "paper-translated.pdf", size_bytes: done ? job.pdf.length : null },
      },
      failure: job.failure || null,
      failure_diagnostic: job.failure
        ? { failed_stage: job.failure.failed_stage, error_kind: job.failure.category, summary: job.failure.summary,
          root_cause: job.failure.root_cause, retryable: false, upstream_host: job.failure.upstream_host,
          suggestion: job.failure.suggestion, last_log_line: job.failure.last_log_line }
        : null,
      error: job.failure ? job.failure.summary : null,
    };
    return view;
  }

  function validateJob(body) {
    if (!body || typeof body !== "object") return err(400, "BAD_REQUEST", "invalid request body");
    for (const k of Object.keys(body)) if (!TOP.includes(k)) return err(400, "BAD_REQUEST", `unknown field ${k}`);
    if ((body.workflow || "book") !== "book") return err(400, "BAD_REQUEST", "this fake only supports workflow=book");
    const up = body.source?.upload_id;
    if (!up || !state.uploads.has(up)) return err(404, "NOT_FOUND", "upload not found");
    const ocr = body.ocr || {};
    if (ocr.provider && !OCR_PROVIDERS.includes(ocr.provider)) return err(400, "BAD_REQUEST", `unsupported ocr.provider: ${ocr.provider}`);
    const tr = body.translation || {};
    if (!tr.base_url || !/^https?:\/\//.test(tr.base_url)) return err(400, "BAD_REQUEST", "translation.base_url must start with http:// or https://");
    if (!tr.model) return err(400, "BAD_REQUEST", "translation.model is required");
    if (tr.api_key && tr.credential_ref) return err(400, "BAD_REQUEST", "translation.api_key and translation.credential_ref are mutually exclusive");
    if (!tr.api_key && !tr.credential_ref) return err(400, "BAD_REQUEST", "translation.api_key or translation.credential_ref is required");
    if (tr.credential_ref) {
      const c = state.credentials.get(tr.credential_ref);
      if (!c) return err(404, "CREDENTIAL_REF_NOT_FOUND", "credential reference was not found");
      if (c.kind !== "translation_api_key") return err(400, "CREDENTIAL_KIND_MISMATCH", "credential kind mismatch");
    }
    const mode = body.render?.render_mode ?? "auto";
    if (!RENDER_MODES.includes(mode)) return err(400, "BAD_REQUEST", `unknown render_mode ${mode}`);
    return null;
  }

  const meta = (ref, c) => ({
    credential_ref: ref, kind: c.kind, provider: c.provider, label: c.label, configured: !!c.secret,
    revision: c.revision, created_at: c.created, updated_at: c.updated,
  });

  async function route(req, url, buf) {
    const p = url.pathname;
    const json = () => (buf.length ? JSON.parse(buf.toString("utf8")) : {});
    if (req.method === "GET" && p === "/health") {
      return { status: 200, body: ok({ status: "ok", db: "ok", queue_depth: 0, running_jobs: 0, provider_backends: OCR_PROVIDERS, ai_service: "healthy", jobsd: "healthy", time: stamp() }) };
    }
    if (req.headers["x-api-key"] !== apiKey) return err(401, "UNAUTHORIZED", "missing or invalid X-API-Key");
    let m;
    if (req.method === "GET" && p === "/api/v1/providers/ocr") {
      return { status: 200, body: ok(OCR_PROVIDERS.map((key) => ({ key, display_name: key, provider_kind: key === "local" ? "local_command" : "remote", credential: key === "local" ? null : { credential_kind: "ocr_provider_token", reference_field: "credential_ref" } }))) };
    }
    if (req.method === "POST" && p === "/api/v1/uploads") {
      const f = multipartFile(req, buf);
      if (!f || f.field !== "file" || !f.data.subarray(0, 4).toString("latin1").startsWith("%PDF")) return err(400, "BAD_REQUEST", "multipart field `file` must be a PDF");
      const id = `2026${String(state.nextId++).padStart(10, "0")}-up`;
      state.uploads.set(id, { filename: f.filename, data: f.data });
      return { status: 200, body: ok({ upload_id: id, filename: f.filename, bytes: f.data.length, page_count: 1, uploaded_at: stamp() }) };
    }
    if (p === "/api/v1/credentials" && req.method === "GET") {
      return { status: 200, body: ok({ credentials: [...state.credentials].map(([r, c]) => meta(r, c)), revision: state.vaultRevision }) };
    }
    if (p === "/api/v1/credentials" && req.method === "POST") {
      const b = json();
      const bad = Object.keys(b).find((k) => !["kind", "provider", "label", "secret", "expected_revision"].includes(k));
      if (bad || !b.kind || !b.secret) return err(400, "BAD_REQUEST", "invalid credential body");
      const ref = `cred_${String(state.nextId++).padStart(16, "0")}`;
      state.credentials.set(ref, { kind: b.kind, provider: b.provider || "", label: b.label || "", secret: b.secret, revision: 1, created: stamp(), updated: stamp() });
      state.vaultRevision++;
      return { status: 200, body: ok({ credential: meta(ref, state.credentials.get(ref)), revision: state.vaultRevision }) };
    }
    if ((m = /^\/api\/v1\/credentials\/([^/]+)$/.exec(p))) {
      const c = state.credentials.get(m[1]);
      if (!c) return err(404, "CREDENTIAL_REF_NOT_FOUND", "credential reference not found");
      if (req.method === "GET") return { status: 200, body: ok({ credential: meta(m[1], c), revision: state.vaultRevision }) };
      if (req.method === "PUT") {
        const b = json();
        const bad = Object.keys(b).find((k) => !["kind", "provider", "label", "secret", "expected_revision", "expected_credential_revision"].includes(k));
        if (bad) return err(400, "BAD_REQUEST", "invalid credential body");
        if (b.expected_credential_revision !== undefined && b.expected_credential_revision !== c.revision) return err(409, "CREDENTIAL_REVISION_CONFLICT", "credential changed");
        if (b.secret !== undefined) c.secret = b.secret;
        if (b.label !== undefined) c.label = b.label;
        c.revision++; c.updated = stamp(); state.vaultRevision++;
        return { status: 200, body: ok({ credential: meta(m[1], c), revision: state.vaultRevision }) };
      }
    }
    if (req.method === "POST" && p === "/api/v1/jobs") {
      let body;
      try { body = json(); } catch { return err(400, "BAD_REQUEST", "invalid JSON"); }
      const bad = validateJob(body);
      if (bad) return bad;
      const id = `2026${String(state.nextId++).padStart(10, "0")}-job`;
      const job = {
        id, status: "queued", step: 0, created: stamp(), model: body.translation.model, renderMode: body.render?.render_mode ?? "auto",
        pdf: state.uploads.get(body.source.upload_id).data, request: body, failure: null,
      };
      state.jobs.set(id, job);
      const view = jobView(job);
      return { status: 200, body: ok({ job_id: id, status: "queued", workflow: "book", ocr_reused: false, source_artifact_job_id: null, stages: view.stages, links: { self_path: `/api/v1/jobs/${id}` } }), note: `render_mode=${job.renderMode} model=${job.model} ocr=${body.ocr?.provider || "-"} cred=${body.translation.credential_ref ? "ref" : "inline"}` };
    }
    if ((m = /^\/api\/v1\/jobs\/([^/]+)(?:\/(pdf|cancel))?$/.exec(p))) {
      const job = state.jobs.get(m[1]);
      if (!job) return err(404, "NOT_FOUND", "job not found");
      if (!m[2] && req.method === "GET") {
        advance(job);
        return { status: 200, body: ok(jobView(job)), note: `status=${job.status} step=${job.step}` };
      }
      if (m[2] === "pdf" && req.method === "GET") {
        if (job.status !== "succeeded") return err(404, "NOT_FOUND", "output pdf not ready");
        return { status: 200, raw: job.pdf, contentType: "application/pdf", note: `render_mode=${job.renderMode}` };
      }
      if (m[2] === "cancel" && req.method === "POST") {
        if (["queued", "running"].includes(job.status)) job.status = "canceled";
        return { status: 200, body: ok({ job_id: job.id, status: job.status, workflow: "book" }) };
      }
    }
    return err(404, "NOT_FOUND", `no route ${req.method} ${p}`);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://localhost");
      let out;
      try {
        out = await route(req, url, Buffer.concat(chunks));
      } catch (e) {
        out = err(500, "INTERNAL", String(e.message || e));
      }
      state.requests.push({ method: req.method, path: url.pathname, status: out.status, note: out.note });
      log(`${req.method} ${url.pathname} -> ${out.status}${out.note ? " " + out.note : ""}`);
      if (out.raw) {
        res.writeHead(out.status, { "Content-Type": out.contentType, "Content-Length": out.raw.length });
        return res.end(out.raw);
      }
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return { server, state };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
  const port = Number(opt("port", 41999));
  const { server } = createFakeReadFlow({
    apiKey: opt("key", "retain-pdf-desktop"),
    pollsPerStage: Number(opt("polls-per-stage", 2)),
    log: (l) => console.log(`[fake-readflow] ${new Date().toISOString()} ${l}`),
  });
  server.listen(port, "127.0.0.1", () => console.log(`[fake-readflow] listening on http://127.0.0.1:${port}`));
}
