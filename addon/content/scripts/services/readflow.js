/*
 * Full-document translation through ReadFlow (RetainPDF-based local app / Docker deployment).
 *
 * Flow (ReadFlow Rust API, see backend/api/docs/api-spec/*.md):
 *   POST /api/v1/uploads (multipart `file`)         → data.upload_id
 *   PUT|POST /api/v1/credentials[/:ref]             → translation API key as a vault credential (credential_ref)
 *   POST /api/v1/jobs  (workflow "book")            → data.job_id
 *   GET  /api/v1/jobs/{id}  (poll)                  → data.status / stages / stage_snapshot / failure
 *   GET  /api/v1/jobs/{id}/pdf                      → rendered PDF (render_mode "dual" → side-by-side book PDF)
 *   POST /api/v1/jobs/{id}/cancel
 * Every JSON response is wrapped as {code, message, data}; auth is header `X-API-Key`.
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, IOUtils, PathUtils, fetch, Blob, FormData, AbortController, setTimeout, clearTimeout */

DeepRead.ReadFlow = {
  POLL_INTERVAL_MS: 2000,
  TIMEOUT_MS: 60 * 60 * 1000,
  CREDENTIAL_LABEL: "deepread-llm",
  CREDENTIAL_KIND: "translation_api_key",
  // Placeholder for OpenAI-compatible servers that need no key (ReadFlow rejects an empty translation key).
  NO_KEY_PLACEHOLDER: "no-key-required",

  // ---- public API --------------------------------------------------------

  config() {
    const get = (k) => DeepRead.prefs.get(`readflow.${k}`);
    return {
      baseURL: String(get("baseURL") || "http://127.0.0.1:41000").trim().replace(/\/+$/, ""),
      apiKey: String(get("apiKey") || "retain-pdf-desktop").trim(),
      ocrProvider: String(get("ocrProvider") || "local").trim(),
      defaultMode: get("defaultMode") === "inplace" ? "inplace" : "dual",
    };
  },

  async testConnection(cfg) {
    cfg = cfg || this.config();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    try {
      let health;
      try {
        const resp = await fetch(`${cfg.baseURL}/health`, { signal: ac.signal });
        const body = await this._parse(resp);
        if (!resp.ok) {
          return { ok: false, message: `ReadFlow health check failed: HTTP ${resp.status} ${body.text.slice(0, 200)}` };
        }
        health = body.json;
      }
      catch (e) {
        return { ok: false, message: this._notRunningMessage(cfg, e) };
      }
      // Authenticated request: OCR provider discovery (also tells us whether the chosen provider exists).
      let resp;
      try {
        resp = await fetch(`${cfg.baseURL}/api/v1/providers/ocr`, { headers: this._headers(cfg), signal: ac.signal });
      }
      catch (e) {
        return { ok: false, message: this._notRunningMessage(cfg, e) };
      }
      const body = await this._parse(resp);
      if (resp.status === 401 || resp.status === 403 || String(body.json?.code) === "40100") {
        return {
          ok: false,
          message: DeepRead.bilingual(
            "ReadFlow API Key 被拒绝（请检查 API Key；桌面版默认为 retain-pdf-desktop）",
            "ReadFlow API key rejected (check the API key; the desktop app uses retain-pdf-desktop)"
          ) + ` (HTTP ${resp.status})`,
        };
      }
      if (!resp.ok) {
        return { ok: false, message: `ReadFlow authenticated request failed: HTTP ${resp.status} ${body.text.slice(0, 200)}` };
      }
      const providers = Array.isArray(body.json?.data) ? body.json.data.map((p) => p.key).filter(Boolean) : [];
      if (providers.length && cfg.ocrProvider && !providers.includes(cfg.ocrProvider)) {
        return {
          ok: false,
          message: DeepRead.bilingual(
            `ReadFlow 不支持 OCR 提供方 “${cfg.ocrProvider}”，可选：${providers.join(", ")}`,
            `ReadFlow does not offer OCR provider "${cfg.ocrProvider}"; available: ${providers.join(", ")}`
          ),
        };
      }
      const version = health?.data?.version || health?.data?.app_version || health?.version;
      const extra = [];
      if (version) extra.push(`version ${version}`);
      else extra.push(`status ${health?.data?.status || "ok"}`);
      if (providers.length) extra.push(`OCR: ${providers.join("/")}`);
      return { ok: true, message: `OK (${extra.join(", ")})` };
    }
    finally {
      clearTimeout(t);
    }
  },

  /**
   * @param {{filePath:string, mode?:"dual"|"inplace", sourceLang?:string, targetLang?:string,
   *          onStatus?:Function, signal?:AbortSignal}} opts
   * @returns {Promise<{pdfBytes:Uint8Array, jobId:string, fileName:string}>}
   */
  async translatePDF({ filePath, mode, sourceLang, targetLang, onStatus, signal } = {}) {
    const cfg = this.config();
    mode = mode === "inplace" ? "inplace" : (mode === "dual" ? "dual" : cfg.defaultMode);
    targetLang = targetLang || DeepRead.prefs.language();
    const status = (phase, percent, message) => {
      try {
        onStatus?.({ phase, percent, message });
      }
      catch (e) {
        DeepRead.log("onStatus failed", String(e));
      }
    };
    this._throwIfAborted(signal);
    const llm = DeepRead.prefs.llmConfig();
    if (!llm.baseURL || !llm.model) {
      throw new Error(DeepRead.bilingual("请先在设置中配置 LLM（Base URL 与模型）", "Configure the LLM (base URL and model) in settings first"));
    }
    const deadline = this._deadline(signal);
    const sig = deadline.signal;
    let jobId = null;
    try {
      status("upload", 0, DeepRead.bilingual("上传 PDF 至 ReadFlow…", "Uploading PDF to ReadFlow…"));
      const bytes = await IOUtils.read(filePath);
      let name = PathUtils.filename(filePath) || "document.pdf";
      if (!/\.pdf$/i.test(name)) name += ".pdf";
      const uploadId = await this._upload(cfg, bytes, name, sig);
      status("upload", 3, DeepRead.bilingual("准备翻译凭据…", "Preparing translation credential…"));
      const credentialRef = await this._ensureCredential(cfg, llm, sig);
      const payload = this._jobPayload({ cfg, llm, uploadId, credentialRef, mode, sourceLang, targetLang });
      const created = await this._json(cfg, "create job", "POST", "/api/v1/jobs", { body: payload, signal: sig });
      jobId = created?.job_id;
      if (!jobId) throw new Error("ReadFlow create job failed: unexpected response (missing job_id)");
      DeepRead.log(`ReadFlow job ${jobId} created (mode=${mode}, render_mode=${payload.render.render_mode}, model=${llm.model})`);
      status("queued", 5, DeepRead.bilingual("ReadFlow 排队中…", "Queued at ReadFlow…"));

      const detail = await this._poll(cfg, jobId, status, sig);

      status("download", 97, DeepRead.bilingual("下载译文 PDF…", "Downloading translated PDF…"));
      const pdfBytes = await this._download(cfg, `/api/v1/jobs/${encodeURIComponent(jobId)}/pdf`, "download PDF", sig);
      if (!(pdfBytes.length > 4) || String.fromCharCode(pdfBytes[0], pdfBytes[1], pdfBytes[2], pdfBytes[3]) !== "%PDF") {
        throw new Error("ReadFlow download PDF failed: the response is not a PDF");
      }
      status("download", 100, DeepRead.bilingual("完成", "Done"));
      return { pdfBytes, jobId, fileName: this._fileName(name, mode, detail) };
    }
    catch (e) {
      const err = this._normalizeAbort(e, signal, deadline);
      if (jobId && (err?.name === "AbortError" || deadline.timedOut)) {
        // Best effort: don't leave an abandoned job running in ReadFlow.
        this.cancel(jobId).catch((ce) => DeepRead.log("ReadFlow cancel failed", String(ce?.message || ce)));
      }
      throw err;
    }
    finally {
      deadline.clear();
    }
  },

  async cancel(jobId) {
    const cfg = this.config();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    try {
      await this._json(cfg, "cancel job", "POST", `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { signal: ac.signal });
    }
    finally {
      clearTimeout(t);
    }
  },

  // ---- request building --------------------------------------------------

  /** Source language → MinerU OCR language hint. "auto"/unknown → omit (ReadFlow default "ch" handles zh+en). */
  _ocrLanguage(sourceLang) {
    const s = String(sourceLang || "").toLowerCase();
    if (!s || s === "auto") return null;
    if (s.startsWith("zh")) return "ch";
    if (s.startsWith("en")) return "en";
    return s.slice(0, 2);
  },

  /**
   * ReadFlow has no target-language field: translation prompts hard-code 简体中文 (target_language_name default).
   * For other targets we add a custom rule telling the model to translate into that language instead.
   */
  _targetRules(targetLang) {
    const key = String(targetLang || "zh");
    if (/^zh(?!.*(tw|hant|hk))/i.test(key) || key === "zh") return "";
    const names = DeepRead.PARSE_LANGUAGES?.[key];
    const name = names?.instruction || names?.displayName || key;
    return `Target language override: translate all text into ${name} instead of Simplified Chinese. Do not output Chinese.`;
  },

  _jobPayload({ cfg, llm, uploadId, credentialRef, mode, sourceLang, targetLang }) {
    const ocr = { provider: cfg.ocrProvider || "local" };
    const lang = this._ocrLanguage(sourceLang);
    if (lang) ocr.language = lang;
    const translation = {
      model: llm.model,
      base_url: llm.baseURL,
      credential_ref: credentialRef,
    };
    const rules = this._targetRules(targetLang);
    if (rules) translation.custom_rules_text = rules;
    return {
      workflow: "book",
      source: { upload_id: uploadId },
      ocr,
      translation,
      render: { render_mode: mode === "dual" ? "dual" : "auto" },
      runtime: { timeout_seconds: Math.floor(this.TIMEOUT_MS / 1000) },
    };
  },

  // ---- steps -------------------------------------------------------------

  async _upload(cfg, bytes, name, signal) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
    const data = await this._json(cfg, "upload PDF", "POST", "/api/v1/uploads", { form, signal });
    if (!data?.upload_id) throw new Error("ReadFlow upload PDF failed: unexpected response (missing upload_id)");
    return data.upload_id;
  },

  /**
   * Keep the LLM key in ReadFlow's credential vault (documented `translation.credential_ref` flow) under the label
   * "deepread-llm": reuse + update its secret if it exists, create it otherwise. The secret is only ever sent in the
   * request body of the create/update call and never logged.
   */
  async _ensureCredential(cfg, llm, signal) {
    const secret = llm.apiKey || this.NO_KEY_PLACEHOLDER;
    const list = await this._json(cfg, "list credentials", "GET", "/api/v1/credentials", { signal });
    const existing = (list?.credentials || []).find((c) => c.label === this.CREDENTIAL_LABEL && c.kind === this.CREDENTIAL_KIND);
    if (existing?.credential_ref) {
      const body = { secret, label: this.CREDENTIAL_LABEL };
      if (Number.isInteger(existing.revision)) body.expected_credential_revision = existing.revision;
      await this._json(cfg, "update credential", "PUT", `/api/v1/credentials/${encodeURIComponent(existing.credential_ref)}`, { body, signal });
      return existing.credential_ref;
    }
    const created = await this._json(cfg, "create credential", "POST", "/api/v1/credentials", {
      body: { kind: this.CREDENTIAL_KIND, provider: "deepread", label: this.CREDENTIAL_LABEL, secret },
      signal,
    });
    const ref = created?.credential?.credential_ref;
    if (!ref) throw new Error("ReadFlow create credential failed: unexpected response (missing credential_ref)");
    return ref;
  },

  async _poll(cfg, jobId, status, signal) {
    const path = `/api/v1/jobs/${encodeURIComponent(jobId)}`;
    let maxPercent = 5; // ReadFlow may restart a stage's counter (e.g. translation retry pass); never go backwards
    for (;;) {
      this._throwIfAborted(signal);
      const job = await this._json(cfg, "poll job", "GET", path, { signal });
      const st = String(job?.status || "");
      if (st === "succeeded") {
        if (job?.artifacts?.pdf_ready === false && job?.artifacts?.pdf?.ready === false) {
          throw new Error("ReadFlow job succeeded but no PDF was published");
        }
        return job;
      }
      if (st === "failed") throw new Error(this._failureMessage(job));
      if (st === "canceled") throw new Error(DeepRead.bilingual("ReadFlow 任务已被取消", "The ReadFlow job was canceled"));
      const p = this._progress(job);
      maxPercent = Math.max(maxPercent, p.percent);
      status(p.phase, maxPercent, p.message);
      await this._sleep(this.POLL_INTERVAL_MS, signal);
    }
  },

  /** Map job detail → { phase, percent, message }. Weights: ocr 5–25, translate 25–85, render 85–97. */
  _progress(job) {
    const st = String(job?.status || "");
    const stages = job?.stages || {};
    const snap = job?.stage_snapshot || null;
    const isActive = (s) => s && (s.state === "in_progress" || s.state === "running");
    const done = (s) => s && (s.state === "completed" || s.state === "reused" || s.state === "succeeded");
    let key = null;
    if (isActive(stages.render)) key = "render";
    else if (isActive(stages.translation)) key = "translation";
    else if (isActive(stages.ocr)) key = "ocr";
    else if (snap?.display_stage) {
      const d = String(snap.display_stage);
      key = /ocr/.test(d) ? "ocr" : /transl/.test(d) ? "translation" : /render/.test(d) ? "render" : null;
    }
    if (!key) {
      if (done(stages.translation)) key = "render";
      else if (done(stages.ocr)) key = "translation";
    }
    if (st === "queued" || !key) {
      return { phase: "queued", percent: 5, message: DeepRead.bilingual("ReadFlow 排队中…", "Queued at ReadFlow…") };
    }
    const range = { ocr: [5, 25], translation: [25, 85], render: [85, 97] }[key];
    const frac = Number(stages[key]?.progress?.percent ?? snap?.progress?.percent);
    const inner = Number.isFinite(frac) ? Math.max(0, Math.min(100, frac)) / 100 : 0;
    const percent = Math.round(range[0] + (range[1] - range[0]) * inner);
    const phase = key === "translation" ? "translate" : key;
    const label = {
      ocr: DeepRead.bilingual("OCR / 版面解析", "OCR / layout analysis"),
      translate: DeepRead.bilingual("翻译", "Translating"),
      render: DeepRead.bilingual("渲染译文 PDF", "Rendering PDF"),
    }[phase];
    const detail = snap?.stage_detail ? ` — ${snap.stage_detail}` : "";
    return { phase, percent, message: `${label}${detail}` };
  },

  _failureMessage(job) {
    const f = job?.failure || {};
    const d = job?.failure_diagnostic || {};
    const stage = f.failed_stage || f.stage || d.failed_stage || "";
    const summary = f.summary || d.summary || job?.error || "unknown error";
    const parts = [`ReadFlow job failed${stage ? ` at stage "${stage}"` : ""}: ${summary}`];
    const root = f.root_cause || d.root_cause;
    if (root && root !== summary) parts.push(`cause: ${root}`);
    const suggestion = f.suggestion || d.suggestion;
    if (suggestion) parts.push(`suggestion: ${suggestion}`);
    const last = f.last_log_line || d.last_log_line;
    if (last) parts.push(`last log: ${last}`);
    return parts.join(" | ").slice(0, 1200);
  },

  _fileName(sourceName, mode, detail) {
    const base = String(sourceName || "document.pdf").replace(/\.pdf$/i, "");
    return `${base}-${mode === "dual" ? "dual" : "translated"}.pdf`;
  },

  // ---- http helpers ------------------------------------------------------

  _headers(cfg, json) {
    const h = { "X-API-Key": cfg.apiKey };
    if (json) h["Content-Type"] = "application/json";
    return h;
  },

  async _parse(resp) {
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    }
    catch (e) { /* not JSON */ }
    return { text, json };
  },

  /** JSON request against the ReadFlow API; unwraps {code, message, data}. */
  async _json(cfg, step, method, path, { body, form, signal } = {}) {
    const init = { method, headers: this._headers(cfg, !!body), signal };
    if (body) init.body = JSON.stringify(body);
    if (form) init.body = form;
    let resp;
    try {
      resp = await fetch(`${cfg.baseURL}${path}`, init);
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(this._notRunningMessage(cfg, e, step));
    }
    const { text, json } = await this._parse(resp);
    const code = json?.code;
    if (!resp.ok || (json && code !== undefined && String(code) !== "0")) {
      const err = new Error(this._httpError(step, resp.status, json, text));
      err.status = resp.status;
      throw err;
    }
    if (!json) throw new Error(`ReadFlow ${step} failed: response is not JSON: ${text.slice(0, 200)}`);
    return json.data;
  },

  _httpError(step, status, json, text) {
    if (status === 401 || String(json?.code) === "40100") {
      return `ReadFlow ${step} failed: HTTP ${status} API key rejected (check the ReadFlow API key)`;
    }
    const code = json?.error?.code || json?.code;
    const msg = json?.message || json?.error?.message || text.slice(0, 300);
    return `ReadFlow ${step} failed: HTTP ${status}${code ? ` [${code}]` : ""} ${String(msg).slice(0, 300)}`;
  },

  async _download(cfg, path, step, signal) {
    let resp;
    try {
      resp = await fetch(`${cfg.baseURL}${path}`, { headers: this._headers(cfg), signal });
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(this._notRunningMessage(cfg, e, step));
    }
    if (!resp.ok) {
      let text = "";
      try {
        text = (await resp.text()).slice(0, 300);
      }
      catch (e) { /* ignore */ }
      const err = new Error(`ReadFlow ${step} failed: HTTP ${resp.status} ${text}`);
      err.status = resp.status;
      throw err;
    }
    try {
      return new Uint8Array(await resp.arrayBuffer());
    }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(`ReadFlow ${step} failed: ${e?.message || e}`);
    }
  },

  _notRunningMessage(cfg, e, step) {
    const base = DeepRead.bilingual(
      `无法连接 ReadFlow（${cfg.baseURL}），请确认 ReadFlow 已启动`,
      `ReadFlow is not running or unreachable at ${cfg.baseURL}`
    );
    return `${step ? `ReadFlow ${step} failed: ` : ""}${base} (${e?.message || e})`;
  },

  // ---- abort / timing ------------------------------------------------------

  _abortError() {
    const e = new Error(DeepRead.bilingual("已取消", "Cancelled"));
    e.name = "AbortError";
    return e;
  },

  _throwIfAborted(signal) {
    if (signal?.aborted) throw this._abortError();
  },

  /** Combined signal: user's signal + overall timeout. */
  _deadline(signal) {
    const ac = new AbortController();
    const state = { timedOut: false };
    const t = setTimeout(() => {
      state.timedOut = true;
      ac.abort();
    }, this.TIMEOUT_MS);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ac.signal,
      get timedOut() {
        return state.timedOut;
      },
      clear() {
        clearTimeout(t);
        signal?.removeEventListener?.("abort", onAbort);
      },
    };
  },

  _normalizeAbort(e, userSignal, deadline) {
    if (e?.name === "AbortError" || deadline.signal.aborted) {
      if (deadline.timedOut && !userSignal?.aborted) {
        return new Error(DeepRead.bilingual("ReadFlow 翻译超时（60 分钟）", "ReadFlow translation timed out (60 min)"));
      }
      return this._abortError();
    }
    return e;
  },

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(this._abortError());
      const onAbort = () => {
        clearTimeout(t);
        reject(this._abortError());
      };
      const t = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  },
};
