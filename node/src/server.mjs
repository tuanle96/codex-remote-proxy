import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import zlib from "node:zlib";
import { decompress as zstdDecompress } from "fzstd";

const CONFIG_ENV_VAR = "CODEX_PROXY_CONFIG";
const DEFAULT_CONFIG_PATH = resolve(import.meta.dirname, "..", "proxy-config.json");
const HEALTH_PATH = "/_proxy/health";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade"
]);

let DEBUG_ENABLED = false;
const THREAD_CONTEXT_CACHE = new Map();

const LLM_COMPACT_SYSTEM_PROMPT = `You are a context compaction assistant. Your job is to create an execution handoff for a coding agent that was interrupted mid-task.

CRITICAL REQUIREMENTS:
- Use EXACTLY these section headers (in English):
  • Current task:
  • User intent:
  • Repo / location:
  • Current state:
  • Important files:
  • Changes already made:
  • Known verification:
  • Unfinished work:
  • Next action:
  • Do not do:

- Be SPECIFIC and EXECUTABLE
- Include file paths, line numbers, command outputs
- "Next action" must be a single clear command or edit
- If you cannot determine the task, say "RECOVERY REQUIRED" explicitly

Quality rules:
- Preserve intent, not transcript
- Include only files directly relevant to the active task, each with a reason
- State "Unknown" explicitly instead of inventing
- Avoid validator metadata or JSON blobs
- Do not truncate mid-sentence
- Deduplicate file paths (prefer repo-relative)
- Extract verification from actual test/command output, not doc mentions
- Make "Next action" a single executable step, not a category list`;

const MAX_LLM_COMPACT_RETRIES = 2;

function resolveConfigPath() {
  return process.env[CONFIG_ENV_VAR] ? resolve(process.env[CONFIG_ENV_VAR]) : DEFAULT_CONFIG_PATH;
}

function loadConfig(configPath = resolveConfigPath()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read proxy config at ${configPath}: ${error.message}`);
  }

  const server = parsed.server ?? {};
  const upstream = parsed.upstream ?? {};
  const proxy = parsed.proxy ?? {};

  if (!upstream.baseUrl || typeof upstream.baseUrl !== "string") {
    throw new Error("upstream.baseUrl is required");
  }
  if ((proxy.overrideAuthorization ?? true) && !upstream.apiKey) {
    throw new Error("upstream.apiKey is required when proxy.overrideAuthorization is true");
  }

  return {
    configPath,
    server: {
      host: typeof server.host === "string" && server.host ? server.host : "127.0.0.1",
      port: Number.isInteger(server.port) ? server.port : 15100,
      logLevel: typeof server.logLevel === "string" && server.logLevel ? server.logLevel : "info"
    },
    upstream: {
      baseUrl: String(upstream.baseUrl).replace(/\/$/, ""),
      apiKey: typeof upstream.apiKey === "string" ? upstream.apiKey : "",
      timeoutMs: Number.isFinite(upstream.timeoutMs) ? Number(upstream.timeoutMs) : 300000,
      verifySsl: typeof upstream.verifySsl === "boolean" ? upstream.verifySsl : true,
      authHeader: typeof upstream.authHeader === "string" && upstream.authHeader ? upstream.authHeader : "authorization",
      authScheme: typeof upstream.authScheme === "string" ? upstream.authScheme : "Bearer",
      extraHeaders: isStringMap(upstream.extraHeaders) ? upstream.extraHeaders : {}
    },
    proxy: {
      overrideAuthorization: typeof proxy.overrideAuthorization === "boolean" ? proxy.overrideAuthorization : true,
      requestIdHeader: typeof proxy.requestIdHeader === "string" && proxy.requestIdHeader ? proxy.requestIdHeader : "x-client-request-id",
      compactDumpDir: typeof proxy.compactDumpDir === "string" && proxy.compactDumpDir ? proxy.compactDumpDir : ""
    }
  };
}

function isStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string");
}

function maskSecret(value) {
  if (!value) {
    return "(empty)";
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function log(level, message, fields = {}) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`);
}

function debugLog(label, data) {
  if (!DEBUG_ENABLED) return;
  const timestamp = new Date().toISOString();
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  for (const line of json.split("\n")) {
    console.log(`${timestamp} DEBUG [${label}] ${line}`);
  }
}

function safeBodyPreview(buffer, maxLen = 4096) {
  if (!buffer || !buffer.length) return "(empty)";
  try {
    const text = buffer.toString("utf-8");
    return text.length > maxLen ? text.slice(0, maxLen) + `... (${buffer.length} bytes total)` : text;
  } catch {
    return `(${buffer.length} bytes, binary)`;
  }
}

function defaultCompactDumpDir() {
  return resolve(process.env.HOME || process.cwd(), ".codex-remote-proxy", "compact-dumps");
}

function compactDumpDir(settings) {
  if (settings.proxy.compactDumpDir) return resolve(settings.proxy.compactDumpDir);
  return DEBUG_ENABLED ? defaultCompactDumpDir() : "";
}

function safeDumpName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "unknown";
}

function redactText(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-...redacted")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer ...redacted")
    .replace(/"apiKey"\s*:\s*"[^"]+"/gi, '"apiKey":"...redacted"')
    .replace(/"authorization"\s*:\s*"[^"]+"/gi, '"authorization":"...redacted"');
}

function redactedJson(value) {
  return JSON.parse(redactText(JSON.stringify(value)));
}

function writeCompactDump(settings, requestId, phase, payload) {
  const dir = compactDumpDir(settings);
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = resolve(dir, `${timestamp}_${safeDumpName(requestId)}_${phase}.json`);
    writeFileSync(file, `${JSON.stringify(redactedJson(payload), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    log("warn", "Failed to write compact dump", { error: JSON.stringify(error.message) });
  }
}

function joinUrlPath(baseUrl, pathname, search = "") {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const path = String(pathname || "").startsWith("/") ? pathname : `/${pathname || ""}`;
  base.pathname = `${basePath}${path === "/" ? "" : path}` || "/";
  base.search = search;
  return base;
}

function buildTargetUrl(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl, "http://127.0.0.1");
  return joinUrlPath(baseUrl, incoming.pathname, incoming.search);
}

function formatAuthorization(upstream) {
  const scheme = upstream.authScheme.trim();
  return scheme ? `${scheme} ${upstream.apiKey}` : upstream.apiKey;
}

const CONTENT_HEADERS = new Set(["content-encoding", "content-length"]);

function decompressBody(buffer, encoding) {
  const enc = encoding.toLowerCase().trim();
  if (enc === "gzip") return zlib.gunzipSync(buffer);
  if (enc === "deflate") return zlib.inflateSync(buffer);
  if (enc === "br") return zlib.brotliDecompressSync(buffer);
  if (enc === "zstd") return Buffer.from(zstdDecompress(buffer));
  return buffer;
}

function autoDecompress(buffer) {
  if (buffer.length < 2) return null;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { return zlib.gunzipSync(buffer); } catch { return null; }
  }
  if (buffer[0] === 0x78 && (buffer[1] === 0x01 || buffer[1] === 0x5e || buffer[1] === 0x9c || buffer[1] === 0xda)) {
    try { return zlib.inflateSync(buffer); } catch { return null; }
  }
  if (buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    try { return Buffer.from(zstdDecompress(buffer)); } catch { return null; }
  }
  try { return zlib.brotliDecompressSync(buffer); } catch { return null; }
}

function normalizeResponsesPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let changed = false;

  if (payload.model === "gpt-5.4") {
    payload.model = "gpt-5.5";
    changed = true;
  }

  if (payload.store !== false) {
    payload.store = false;
    changed = true;
  }

  if (payload.reasoning === null || typeof payload.reasoning !== "object" || Array.isArray(payload.reasoning)) {
    payload.reasoning = {};
    changed = true;
  }

  if (!payload.reasoning.effort) {
    payload.reasoning.effort = "medium";
    changed = true;
  }

  if (!payload.reasoning.summary) {
    payload.reasoning.summary = "auto";
    changed = true;
  }

  if (!Array.isArray(payload.include)) {
    payload.include = [];
    changed = true;
  }

  if (!payload.include.includes("reasoning.encrypted_content")) {
    payload.include.push("reasoning.encrypted_content");
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "parallel_tool_calls")) {
    payload.parallel_tool_calls = true;
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "instructions")) {
    payload.instructions = "";
    changed = true;
  }

  return changed;
}

function rewriteRequestBody(buffer, { normalizeResponses = false } = {}) {
  if (!buffer.length) return { body: buffer, rewritten: false, normalized: false };
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return { body: buffer, rewritten: false, normalized: false };
  }

  let rewritten = false;
  let normalized = false;

  if (normalizeResponses) {
    normalized = normalizeResponsesPayload(payload);
    rewritten = normalized;
  } else if (payload && typeof payload === "object" && payload.model === "gpt-5.4") {
    payload.model = "gpt-5.5";
    rewritten = true;
  }

  if (rewritten) return { body: Buffer.from(JSON.stringify(payload)), rewritten, normalized };
  return { body: buffer, rewritten: false, normalized: false };
}

function extractTextParts(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTextParts(item, out);
    return out;
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") out.push(value.text);
    if (typeof value.input_text === "string") out.push(value.input_text);
    if (typeof value.output_text === "string") out.push(value.output_text);
    if (value.content) extractTextParts(value.content, out);
  }
  return out;
}

function previewText(text, maxLen = 500) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function parseResponseStream(buffer) {
  const text = buffer.toString("utf8");
  const events = text.split(/\r?\n\r?\n/);
  const deltas = [];
  let completed = null;

  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;

    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") continue;

    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      continue;
    }

    if (typeof payload.delta === "string") deltas.push(payload.delta);
    if (payload.type === "response.completed" && payload.response) completed = payload.response;
  }

  const textOutput = deltas.join("");
  if (completed) return normalizeCompactResponse(completed, textOutput);
  return createCompactResponse(textOutput);
}

function getResponseText(response) {
  const texts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") texts.push(content.text);
    }
  }
  return texts.join("\n");
}

function createCompactResponse(text, base = {}) {
  return {
    id: base.id || `resp_compact_${Date.now()}`,
    object: "response",
    created_at: base.created_at || Math.floor(Date.now() / 1000),
    status: "completed",
    output: [{
      id: "msg_compact_0",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    }]
  };
}

function normalizeCompactResponse(response, fallbackText = "") {
  const text = getResponseText(response) || fallbackText;
  if (text.trim()) return createCompactResponse(text, response);
  return createCompactResponse("", response);
}

const REQUIRED_HANDOFF_SECTIONS = [
  "Current task:",
  "User intent:",
  "Repo / location:",
  "Current state:",
  "Important files:",
  "Changes already made:",
  "Known verification:",
  "Unfinished work:",
  "Next action:",
  "Do not do:"
];

function compactOutputQuality(response, cachedContext) {
  const text = getResponseText(response);
  const hasFunctionCall = Array.isArray(response?.output) && response.output.some((item) => item?.type === "function_call");
  const saysNoTask = /không có task|chưa có task|no task|no specific task|chờ nhiệm vụ|gửi task tiếp/i.test(text);
  const acknowledgedOnly = /đã nhận context|đã nạp hướng dẫn|sẽ theo AGENTS\.md|send.*task|gửi.*task/i.test(text);
  const missingSections = REQUIRED_HANDOFF_SECTIONS.filter((section) => !text.includes(section));
  const tooShort = text.trim().length < 500;
  const missesFiles = cachedContext?.hasFiles && !cachedContext.files.some((file) => text.includes(file));
  const hasValidatorMetadata = /Proxy note:|\{"bad":true|"missesFiles"|"hasFunctionCall"/.test(text);
  const genericUnknown = /Current task:\s*Unknown from compacted context/i.test(text);
  const bad = hasFunctionCall || tooShort || saysNoTask || acknowledgedOnly || missingSections.length > 0 || missesFiles || hasValidatorMetadata || genericUnknown;
  return { bad, hasFunctionCall, tooShort, saysNoTask, acknowledgedOnly, missingSections, missesFiles, hasValidatorMetadata, genericUnknown, textLength: text.length };
}

function analyzeCompactInput(buffer) {
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    return { parseError: error.message, bytes: buffer.length };
  }

  const input = Array.isArray(payload.input) ? payload.input : [];
  const messages = input.filter((item) => item && item.type === "message");
  const byRole = {};
  const recent = [];

  for (const message of messages) byRole[message.role || "unknown"] = (byRole[message.role || "unknown"] || 0) + 1;
  for (const message of messages.slice(-6)) {
    const text = extractTextParts(message.content).join("\n");
    recent.push({ role: message.role || "unknown", phase: message.phase || null, text: previewText(text, 350) });
  }

  const allText = extractTextParts(payload.input).join("\n");
  const fileMentions = [...new Set((allText.match(/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|md|html|css|toml|yml|yaml)/g) || []))].slice(-20);
  return { model: payload.model, inputItems: input.length, messageCount: messages.length, byRole, bytes: buffer.length, fileMentions, recent };
}

function analyzeCompactOutput(response) {
  const text = getResponseText(response);
  return {
    status: response?.status,
    outputItems: Array.isArray(response?.output) ? response.output.length : 0,
    textLength: text.length,
    text: previewText(text, 1200),
    mentionsFiles: /\.(mjs|js|ts|tsx|json|md|html|css|toml|ya?ml)\b/.test(text),
    mentionsNext: /next|tiếp|todo|remaining|còn|verify|test|lint|typecheck|commit/i.test(text),
    saysNoTask: /không có task|chưa có task|no task|no specific task|chờ nhiệm vụ|gửi task tiếp/i.test(text)
  };
}

function cacheKeyFromHeaders(req) {
  return String(req.headers["thread_id"] || req.headers["thread-id"] || req.headers["session_id"] || req.headers["session-id"] || "");
}

function interestingFiles(files) {
  const noise = /(^|\/)SKILL\.md$|(^|\/)AGENTS\.md$|(^|\/)CLAUDE\.md$|(^|\/)MEMORY\.md$|(^|\/)memory_summary\.md$|rollout_summaries\/|\.codex\/|\.omx\/|cloudflared|pulsecall|deep-research|audit-.*\.md$|report.*\.html$|screenshot-manifest\.js$|ralph-progress\.js$|project\.ya?ml$|config\.(toml|ya?ml)$/i;
  const relevant = /(^|\/)(src|tests|test|app|lib|sse|routes?)\/|\.(test|spec)\.(mjs|js|ts|tsx)$/i;
  const unique = [...new Set(files)]
    .map((file) => String(file).replace(/^\/+Users\/tuan\/Dev\/VibeLab\/9router\//, ""))
    .filter((file) => file && !file.startsWith("r0/") && !file.startsWith("r1/") && !noise.test(file));
  const focused = unique.filter((file) => relevant.test(file));
  return (focused.length ? focused : unique).slice(-35);
}

function workspacePath(value) {
  const path = String(value || "");
  if (!path || path === "unknown" || path.includes("\n")) return "";
  if (!existsSync(path)) return "";
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
    return path;
  } catch {
    return "";
  }
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function collectLocalEvidence(workspaces) {
  const workspace = (workspaces || []).map(workspacePath).find(Boolean);
  if (!workspace) return null;
  const root = gitOutput(workspace, ["rev-parse", "--show-toplevel"]) || workspace;
  const status = gitOutput(workspace, ["status", "--short"]);
  const diffStat = gitOutput(workspace, ["diff", "--stat"]);
  const branch = gitOutput(workspace, ["branch", "--show-current"]);
  return {
    workspace: root,
    branch: branch || "Unknown",
    status: status || "Clean or no status output",
    diffStat: diffStat || "No unstaged diff stat",
    changedFiles: interestingFiles(status.split(/\r?\n/).map((line) => line.replace(/^..\s+/, "")).filter(Boolean))
  };
}

function inferWorkspacesFromFiles(files) {
  const candidates = [];
  for (const file of files || []) {
    const text = String(file);
    const match = text.match(/^(\/Users\/[^\s]+\/Dev\/VibeLab\/[^\/\s]+)/);
    if (match) candidates.push(match[1]);
  }
  return [...new Set(candidates)];
}

function isProxyFallbackText(text) {
  return /Current task:\s*Unknown from compacted context/i.test(text) || /Previous compact lacked a concrete task description/i.test(text);
}

function stripProxyFallbackMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((item) => {
    if (!item || item.type !== "message") return true;
    return !isProxyFallbackText(extractTextParts(item.content).join("\n"));
  });
}

function summarizeRequestForCache(req, buffer) {
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }

  const input = stripProxyFallbackMessages(Array.isArray(payload.input) ? payload.input : []);
  const text = extractTextParts(input).join("\n");
  const files = interestingFiles(text.match(/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|md|html|css|toml|yml|yaml)/g) || []);
  const snippets = [];

  for (const message of input.slice(-10)) {
    if (!message || message.type !== "message") continue;
    const messageText = extractTextParts(message.content).join("\n");
    if (!messageText.trim() || isProxyFallbackText(messageText)) continue;
    snippets.push(`${message.role || "unknown"}${message.phase ? `/${message.phase}` : ""}: ${previewText(messageText, 650)}`);
  }

  let metadata = null;
  const rawMetadata = req.headers["x-codex-turn-metadata"];
  if (typeof rawMetadata === "string") {
    try {
      const parsed = JSON.parse(rawMetadata);
      metadata = {
        workspaces: parsed.workspaces ? Object.keys(parsed.workspaces) : [],
        hasChanges: Object.values(parsed.workspaces || {}).some((workspace) => Boolean(workspace?.has_changes)),
        turnId: parsed.turn_id || null
      };
    } catch {}
  }

  return { at: new Date().toISOString(), model: payload.model, path: req.url, files, metadata, snippets: snippets.slice(-6) };
}

function rememberThreadContext(req, buffer) {
  if (!req.url?.startsWith("/responses") || req.url.startsWith("/responses/compact")) return;
  const key = cacheKeyFromHeaders(req);
  if (!key) return;
  const summary = summarizeRequestForCache(req, buffer);
  if (!summary) return;
  const existing = THREAD_CONTEXT_CACHE.get(key) || { requests: [] };
  existing.requests.push(summary);
  existing.requests = existing.requests.slice(-6);
  THREAD_CONTEXT_CACHE.set(key, existing);
  debugLog("THREAD CONTEXT CACHE", { key, requests: existing.requests.length, latest: { at: summary.at, files: summary.files, metadata: summary.metadata, snippets: summary.snippets } });
}

function getCachedContext(req) {
  const key = cacheKeyFromHeaders(req);
  const cached = key ? THREAD_CONTEXT_CACHE.get(key) : null;
  const requests = cached?.requests || [];
  const files = interestingFiles(requests.flatMap((request) => request.files || []));
  const workspaces = [...new Set(requests.flatMap((request) => request.metadata?.workspaces || []))];
  const hasChanges = requests.some((request) => request.metadata?.hasChanges);
  const snippets = requests.flatMap((request) => request.snippets || []).slice(-12);
  const localEvidence = collectLocalEvidence(workspaces);
  const evidenceFiles = localEvidence?.changedFiles || [];
  const allFiles = interestingFiles([...files, ...evidenceFiles]);
  return { key, requests, files: allFiles, workspaces, hasChanges: hasChanges || Boolean(localEvidence?.status && localEvidence.status !== "Clean or no status output"), snippets, hasFiles: allFiles.length > 0, localEvidence };
}

function buildCachedContextText(cachedContext) {
  if (!cachedContext.requests.length) return "";
  const lines = [
    "REMOTE COMPACT HANDOFF CONTEXT. This is a summarization task, not an implementation turn.",
    "Ignore any previous proxy-generated recovery handoff that says 'Current task: Unknown from compacted context'. It was a failed fallback, not source truth.",
    "Do not call tools or functions. Do not continue coding. Return one assistant message containing only an execution handoff.",
    "Preserve the active user goal and ordered todo/plan verbatim when present. Put the ordered plan in Current task, Unfinished work, and make Next action the first unfinished item.",
    "Use this exact shape and headings:",
    "Current task:\n<one or two concrete sentences; use Unknown if not identifiable>",
    "User intent:\n<what the user asked for or why the work exists; use Unknown if not identifiable>",
    "Repo / location:\n<absolute repo path and relevant working directory>",
    "Current state:\n<uncommitted changes, branch if known, mode/workflow if active>",
    "Important files:\n- <path>: <why it matters>",
    "Changes already made:\n- <specific behavior/code/test change>",
    "Known verification:\n- Passed: <commands/tests that passed, or None recorded>\n- Failed: <commands/tests that failed and key error, or None recorded>\n- Not run: <important checks not yet run>",
    "Unfinished work:\n- <concrete remaining task>",
    "Next action:\n<single highest-signal executable next step>",
    "Do not do:\n- <unrelated context/file cluster to ignore>\n- Do not reset or discard uncommitted changes.",
    "Quality rules: preserve intent, not transcript. Include only files directly relevant to the active task, each with a reason. State Unknown explicitly instead of inventing. Avoid validator metadata or JSON blobs.",
    `Thread/session: ${cachedContext.key || "unknown"}`
  ];
  if (cachedContext.workspaces.length) lines.push(`Workspace(s): ${cachedContext.workspaces.join(", ")}`);
  if (cachedContext.hasChanges) lines.push("Working tree has changes according to Codex metadata or local git evidence.");
  if (cachedContext.localEvidence) {
    lines.push(`Local git evidence workspace: ${cachedContext.localEvidence.workspace}`);
    lines.push(`Local git branch: ${cachedContext.localEvidence.branch}`);
    lines.push(`Local git status --short:\n${cachedContext.localEvidence.status}`);
    lines.push(`Local git diff --stat:\n${cachedContext.localEvidence.diffStat}`);
  }
  if (cachedContext.files.length) lines.push(`Candidate files from recent context and local git evidence: ${cachedContext.files.join(", ")}`);
  if (cachedContext.snippets.length) {
    lines.push("Recent excerpts to extract signal from:");
    for (const snippet of cachedContext.snippets) lines.push(`- ${snippet}`);
  }
  lines.push("If the active task, important files, verification, or next action cannot be identified, output the safe recovery handoff with Unknown fields and next action: run git status --short, git diff --stat, and inspect focused diffs.");
  return lines.join("\n");
}

function injectCachedContextIntoCompact(req, buffer) {
  const cachedContext = getCachedContext(req);
  const cachedText = buildCachedContextText(cachedContext);
  if (!cachedText) return { body: buffer, injected: false, reason: "no_cache", cachedContext };

  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    return { body: buffer, injected: false, reason: error.message, cachedContext };
  }

  const input = stripProxyFallbackMessages(Array.isArray(payload.input) ? payload.input : []);
  const existingText = extractTextParts(input).join("\n");
  if (existingText.includes("REMOTE COMPACT HANDOFF CONTEXT")) {
    payload.input = input;
    return { body: Buffer.from(JSON.stringify(payload)), injected: false, reason: "already_injected", cachedContext };
  }

  payload.tools = [];
  payload.tool_choice = "none";
  payload.parallel_tool_calls = false;
  payload.input = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: cachedText }] },
    ...input
  ];

  return { body: Buffer.from(JSON.stringify(payload)), injected: true, reason: "ok", cachedChars: cachedText.length, cachedContext };
}

function fallbackCompactContextFromRequest(buffer) {
  let analysis;
  try {
    analysis = analyzeCompactInput(buffer);
  } catch {
    analysis = null;
  }
  const mentionedFiles = analysis?.fileMentions || [];
  const inferredWorkspaces = inferWorkspacesFromFiles(mentionedFiles);
  const localEvidence = collectLocalEvidence(inferredWorkspaces);
  const files = interestingFiles([...mentionedFiles, ...(localEvidence?.changedFiles || [])]);
  const snippets = (analysis?.recent || [])
    .map((item) => `${item.role || "unknown"}${item.phase ? `/${item.phase}` : ""}: ${item.text || ""}`)
    .filter((item) => item.trim() && !/<turn_aborted>|\[Request interrupted by user\]/i.test(item))
    .slice(-8);
  return {
    key: "compact-request",
    requests: snippets.length ? [{}] : [],
    files,
    workspaces: inferredWorkspaces,
    hasChanges: Boolean(localEvidence?.status && localEvidence.status !== "Clean or no status output"),
    snippets,
    hasFiles: files.length > 0,
    localEvidence
  };
}

function mergeCompactContexts(primary, secondary) {
  if (!primary?.requests?.length) return secondary;
  if (!secondary?.requests?.length) return primary;
  const localEvidence = primary.localEvidence || secondary.localEvidence;
  const files = interestingFiles([...(primary.files || []), ...(secondary.files || []), ...(localEvidence?.changedFiles || [])]);
  const workspaces = [...new Set([...(primary.workspaces || []), ...(secondary.workspaces || [])])];
  const snippets = [...(primary.snippets || []), ...(secondary.snippets || [])]
    .filter((item) => !/<turn_aborted>|\[Request interrupted by user\]/i.test(item))
    .slice(-16);
  return {
    key: primary.key || secondary.key,
    requests: [...(primary.requests || []), ...(secondary.requests || [])].slice(-8),
    files,
    workspaces,
    hasChanges: Boolean(primary.hasChanges || secondary.hasChanges || (localEvidence?.status && localEvidence.status !== "Clean or no status output")),
    snippets,
    hasFiles: files.length > 0,
    localEvidence
  };
}

function compactContextForSelection(cachedContext, body) {
  return mergeCompactContexts(cachedContext, fallbackCompactContextFromRequest(body));
}

function snippetText(cachedContext) {
  return cachedContext.snippets.join("\n");
}

function sentenceFromText(text, patterns) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const sentences = normalized.split(/(?<=[.!?。])\s+|\s+-\s+/).map((item) => item.trim()).filter(Boolean);
  for (const pattern of patterns) {
    const found = sentences.find((sentence) => pattern.test(sentence));
    if (found) return found.slice(0, 400);
  }
  return "";
}

function inferTaskFromContext(cachedContext) {
  const text = snippetText(cachedContext);
  const fromFinal = sentenceFromText(text, [/đang làm|current task|active task|mục tiêu|goal|kế hoạch|plan|implement|finish|fix|release|diff/i]);
  if (fromFinal) return fromFinal;
  if (cachedContext.localEvidence?.diffStat && cachedContext.localEvidence.diffStat !== "No unstaged diff stat") {
    return "Continue the active work represented by the current git diff and recent conversation snippets.";
  }
  return "Unknown from compacted context.";
}

function inferUserIntentFromContext(cachedContext) {
  const text = snippetText(cachedContext);
  const userLine = [...cachedContext.snippets].reverse().find((line) => /^user/i.test(line));
  if (userLine) return previewText(userLine.replace(/^user[^:]*:\s*/i, ""), 500);
  const intent = sentenceFromText(text, [/user wants|người dùng muốn|yêu cầu|asked|mục tiêu|goal|release|diff|verify|test|fix/i]);
  return intent || "Unknown. The compact context did not contain a concrete user intent.";
}

function inferActivePlanFromContext(cachedContext) {
  const text = snippetText(cachedContext);
  const plan = [];
  const numbered = text.match(/(?:^|\s)(?:\d+\.|[-*])\s+([^\n.]{12,180})/g) || [];
  for (const item of numbered.slice(-6)) {
    const cleaned = item.replace(/^\s*(?:\d+\.|[-*])\s+/, "").trim();
    if (cleaned && !/memory|citation|screenshot/i.test(cleaned)) plan.push(cleaned.replace(/[.;:,]$/, "."));
  }
  for (const pattern of [/next action[^:]*:\s*([^\n]{12,180})/i, /tiếp theo[^:]*:\s*([^\n]{12,180})/i, /còn (?:lại|rủi ro)[^:]*:\s*([^\n]{12,180})/i]) {
    const match = text.match(pattern);
    if (match?.[1]) plan.push(match[1].trim().replace(/[.;:,]$/, "."));
  }
  return [...new Set(plan)].slice(0, 6);
}

function inferVerificationFromContext(cachedContext) {
  const text = snippetText(cachedContext);
  const passed = [];
  const failed = [];
  const notRun = [];
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^assistant\/(?:commentary|final_answer):\s*/i, "").trim()).filter(Boolean);

  for (const line of lines) {
    const commands = [...line.matchAll(/`([^`]{2,80})`/g)].map((match) => match[1]);
    const hasPass = /\b(OK|pass(?:ed)?|xanh|0 fail|green)\b/i.test(line);
    const hasFail = /\b(fail(?:ed)?|đỏ|red|error)\b/i.test(line) && !/0 fail/i.test(line);
    const hasPending = /\b(đang chạy|still running|not run|chưa chạy|pending|chờ)\b/i.test(line);
    const target = commands.length ? commands.join(", ") : previewText(line, 180);
    if (hasFail) failed.push(target);
    else if (hasPending) notRun.push(target);
    else if (hasPass) passed.push(target);
  }

  return { passed: [...new Set(passed)].filter(Boolean).slice(0, 8), failed: [...new Set(failed)].filter(Boolean).slice(0, 6), notRun: [...new Set(notRun)].filter(Boolean).slice(0, 6) };
}

function executableNextAction(activePlan, hasSignal) {
  const candidate = activePlan.find((item) => /^(run|inspect|fix|continue|verify|check|review|decide|stage|commit|rerun|read|open|compare|chạy|kiểm|sửa|đọc|xem|so|quyết)/i.test(item));
  if (candidate) return candidate;
  if (activePlan.length) return `Inspect and continue: ${activePlan[0]}`;
  if (hasSignal) return "Inspect the focused current diff and recent verification output, then continue the first unfinished item from the captured task.";
  return "Run `git status --short`, `git diff --stat`, and inspect focused diffs for changed source/test files. Infer the active task only from current repo evidence.";
}

function describeFile(file) {
  if (/\.(test|spec)\.(mjs|js|ts|tsx)$|(^|\/)tests?\//i.test(file)) return "test file directly mentioned by current diff or compact context.";
  if (/(^|\/)src\//i.test(file)) return "source file directly mentioned by current diff or compact context.";
  if (/(^|\/)scripts?\//i.test(file)) return "script/tooling file directly mentioned by current diff or compact context.";
  if (/(^|\/)schema/i.test(file)) return "schema/config contract file directly mentioned by current diff or compact context.";
  if (/package\.json|README|CHANGELOG|\.md$/i.test(file)) return "release/docs/config file directly mentioned by current diff or compact context.";
  return "directly mentioned file from active compact context; inspect focused diff before editing.";
}

function synthesizeCompactSummary(cachedContext) {
  const repo = cachedContext.workspaces.length ? cachedContext.workspaces.join(", ") : "Unknown";
  const files = cachedContext.files.length ? cachedContext.files : [];
  const evidence = cachedContext.localEvidence;
  const task = inferTaskFromContext(cachedContext);
  const activePlan = inferActivePlanFromContext(cachedContext);
  const verification = inferVerificationFromContext(cachedContext);
  const hasSignal = !task.startsWith("Unknown");
  const currentTask = activePlan.length
    ? `${task} Active ordered plan from the latest user goal: ${activePlan.join(" ")}`
    : task;
  const lines = [
    "Current task:",
    currentTask,
    "",
    "User intent:",
    inferUserIntentFromContext(cachedContext),
    "",
    "Repo / location:",
    evidence?.workspace || repo,
    "",
    "Current state:",
    evidence ? `Branch: ${evidence.branch}. git status --short: ${evidence.status}. git diff --stat: ${evidence.diffStat}. Preserve current worktree state, not stale compact fallback text.` : (cachedContext.hasChanges ? "Uncommitted changes exist according to Codex metadata. Preserve them. Continue from current worktree state, not from stale compact fallback text." : "Current worktree state is unknown. Preserve any uncommitted changes."),
    "",
    "Important files:"
  ];
  if (files.length) {
    for (const file of files.slice(0, 14)) lines.push(`- ${file}: ${describeFile(file)}`);
  } else {
    lines.push("Unknown. Must recover from git diff/status and recent test output.");
  }
  lines.push("", "Changes already made:");
  if (hasSignal) {
    lines.push(`- ${task}`);
    if (evidence?.diffStat && evidence.diffStat !== "No unstaged diff stat") lines.push("- Current git diff/stat is captured in Current state and Important files.");
    if (verification.passed.length || verification.failed.length || verification.notRun.length) lines.push("- Recent verification signals are captured in Known verification.");
  } else {
    lines.push("Unknown.");
  }
  lines.push(
    "",
    "Known verification:",
    `- Passed: ${verification.passed.length ? verification.passed.join("; ") : "None recorded in proxy structured cache"}`,
    `- Failed: ${verification.failed.length ? verification.failed.join("; ") : "None recorded in proxy structured cache"}`,
    `- Not run: ${verification.notRun.length ? verification.notRun.join("; ") : (hasSignal ? "Confirm targeted unit tests, lint/typecheck, and full build status from current repo output." : "Unknown")}`,
    "",
    "Unfinished work:"
  );
  if (activePlan.length) {
    for (const item of activePlan) lines.push(`- ${item}`);
  } else if (hasSignal) {
    lines.push("- Continue from the captured task, git evidence, and verification state; inspect focused diffs before editing.");
  } else {
    lines.push("- Recover task intent from repository state.");
  }
  const nextAction = executableNextAction(activePlan, hasSignal);
  lines.push(
    "",
    "Next action:",
    nextAction,
    "",
    "Do not do:",
    "- Do not reuse or trust previous proxy fallback handoffs that say `Current task: Unknown from compacted context`.",
    "- Do not continue unrelated memories, global config, Cloudflare, PulseCall, or report-generation context unless the current diff proves it is relevant.",
    "- Do not reset or discard uncommitted changes."
  );
  return lines.join("\n");
}

function chooseCompactResponse(response, cachedContext) {
  const quality = compactOutputQuality(response, cachedContext);
  if (!quality.bad) return { response: normalizeCompactResponse(response), quality, fallback: false, synthesized: false };
  return { response: createCompactResponse(synthesizeCompactSummary(cachedContext)), quality, fallback: false, synthesized: true };
}

function sanitizeHeadersForDebug(headersObject) {
  const result = {};
  for (const [key, value] of Object.entries(headersObject)) {
    result[key] = key.toLowerCase() === "authorization" ? maskSecret(String(value)) : value;
  }
  return result;
}

function buildUpstreamHeaders(req, settings, targetUrl, { stripContentHeaders }) {
  const headers = [];
  const authHeader = settings.upstream.authHeader.toLowerCase();

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    const loweredKey = key.toLowerCase();
    if (
      loweredKey === "host" ||
      HOP_BY_HOP_HEADERS.has(loweredKey) ||
      (stripContentHeaders && CONTENT_HEADERS.has(loweredKey))
    ) {
      continue;
    }
    if (settings.proxy.overrideAuthorization && loweredKey === authHeader) {
      continue;
    }
    headers.push([key, value]);
  }

  upsertHeader(headers, "Host", targetUrl.host);

  if (settings.proxy.overrideAuthorization) {
    upsertHeader(headers, settings.upstream.authHeader, formatAuthorization(settings.upstream));
  }

  for (const [key, value] of Object.entries(settings.upstream.extraHeaders)) {
    upsertHeader(headers, key, value);
  }

  return headers;
}

function upsertHeader(headers, key, value) {
  const lowered = key.toLowerCase();
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    if (headers[index][0].toLowerCase() === lowered) {
      headers.splice(index, 1);
    }
  }
  headers.push([key, value]);
}

function writeHeadersToResponse(res, rawHeaders) {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    res.appendHeader(key, value);
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function isEventStream(contentType = "") {
  return contentType.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}

function upstreamJsonRequest(settings, pathname, payload) {
  return new Promise((resolvePromise, reject) => {
    const targetUrl = joinUrlPath(settings.upstream.baseUrl, pathname);
    const transport = targetUrl.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload));
    const headers = {
      "content-type": "application/json",
      "content-length": String(body.length),
      [settings.upstream.authHeader]: formatAuthorization(settings.upstream),
      ...settings.upstream.extraHeaders
    };
    log("info", "Upstream JSON request", { pathname, target_url: targetUrl.href, body_bytes: body.length });
    debugLog("UPSTREAM JSON REQUEST", {
      pathname,
      targetUrl: targetUrl.href,
      headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === "authorization" ? maskSecret(value) : value])),
      bodyBytes: body.length
    });

    const request = transport.request(
      {
        method: "POST",
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
        rejectUnauthorized: settings.upstream.verifySsl,
        timeout: settings.upstream.timeoutMs
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 502) < 200 || (response.statusCode || 502) >= 300) {
            reject(new Error(`Upstream ${pathname} failed with ${response.statusCode}: ${previewText(raw, 1000)}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`Failed to parse upstream ${pathname} response: ${error.message}`));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error(`Upstream ${pathname} timed out`)));
    request.on("error", reject);
    request.end(body);
  });
}

function compactContextPrompt(cachedContext, originalAnalysis, validation = null) {
  const lines = [];
  if (validation) {
    lines.push("Previous compact attempt failed validation. Fix these issues exactly:");
    lines.push(JSON.stringify(validation));
    lines.push("");
  }
  lines.push("Create a compact execution handoff from this context.");
  lines.push("");
  lines.push("Compact request analysis:");
  lines.push(JSON.stringify(originalAnalysis, null, 2));
  lines.push("");
  lines.push("Proxy context and local evidence:");
  lines.push(buildCachedContextText(cachedContext) || "No cached context available.");
  return lines.join("\n");
}

function extractChatCompletionText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return extractTextParts(content).join("\n");
  return "";
}

function validateLlmCompactText(text, cachedContext) {
  const response = createCompactResponse(text);
  const quality = compactOutputQuality(response, cachedContext);
  const nextAction = String(text).match(/Next action:\s*([\s\S]*?)(?:\nDo not do:|$)/i)?.[1]?.trim() || "";
  const badNextAction = !nextAction || nextAction.length < 12 || /^(unknown|none|n\/a)$/i.test(nextAction) || /\n-\s.*\n-\s/.test(nextAction);
  return { ok: !quality.bad && !badNextAction, quality, badNextAction, nextAction };
}

async function runLlmCompact(settings, cachedContext, originalAnalysis) {
  let validation = null;
  for (let attempt = 0; attempt <= MAX_LLM_COMPACT_RETRIES; attempt += 1) {
    const payload = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: LLM_COMPACT_SYSTEM_PROMPT },
        { role: "user", content: compactContextPrompt(cachedContext, originalAnalysis, validation) }
      ],
      temperature: 0.2,
      max_tokens: 4096,
      stream: false
    };
    const raw = await upstreamJsonRequest(settings, "/chat/completions", payload);
    const text = extractChatCompletionText(raw).trim();
    validation = validateLlmCompactText(text, cachedContext);
    debugLog("LLM COMPACT ATTEMPT", { attempt, validation, text: previewText(text, 2000) });
    if (validation.ok || attempt === MAX_LLM_COMPACT_RETRIES) {
      return { response: createCompactResponse(text), validation, attempts: attempt + 1 };
    }
  }
  throw new Error("LLM compact failed unexpectedly");
}

function createServer(settings) {
  return http.createServer((req, res) => {
    if (!req.url) {
      writeJson(res, 400, { error: { message: "Missing request URL", type: "proxy_bad_request" } });
      return;
    }

    if (req.url === HEALTH_PATH) {
      writeJson(res, 200, {
        ok: true,
        configPath: settings.configPath,
        listenHost: settings.server.host,
        listenPort: settings.server.port,
        upstreamBaseUrl: settings.upstream.baseUrl,
        overrideAuthorization: settings.proxy.overrideAuthorization,
        authHeader: settings.upstream.authHeader,
        authScheme: settings.upstream.authScheme,
        extraHeaderCount: Object.keys(settings.upstream.extraHeaders).length
      });
      return;
    }

    const requestId = req.headers[settings.proxy.requestIdHeader] || req.headers["x-request-id"] || "-";
    const targetUrl = buildTargetUrl(settings.upstream.baseUrl, req.url);
    const transport = targetUrl.protocol === "https:" ? https : http;
    const startedAt = Date.now();

      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        let body = Buffer.concat(chunks);
        const contentEncoding = req.headers["content-encoding"];
        let bodyTransformed = false;
        if (contentEncoding && body.length) {
          try {
            body = decompressBody(body, contentEncoding);
            bodyTransformed = true;
          } catch (error) {
            log("warn", "Failed to decompress request body", {
              encoding: contentEncoding,
              error: error.message
            });
        }
        } else if (body.length >= 2 && contentEncoding === undefined) {
          const decompressed = autoDecompress(body);
          if (decompressed) {
            debugLog("AUTODECOMP", {
              originalSize: body.length,
              decompressedSize: decompressed.length,
              magicBytes: `0x${body[0].toString(16).padStart(2, "0")} 0x${body[1].toString(16).padStart(2, "0")}`,
            });
            body = decompressed;
            bodyTransformed = true;
          }
        }

        const normalizeResponses = req.url.startsWith("/responses") && !req.url.startsWith("/responses/compact");
        const rewrite = rewriteRequestBody(body, { normalizeResponses });
        if (rewrite.rewritten) {
          body = rewrite.body;
          bodyTransformed = true;
          debugLog("REQUEST REWRITE", { model: "gpt-5.5", normalizedResponses: rewrite.normalized });
        }
        if (req.url.startsWith("/responses/compact")) {
          log("info", "Compact request received", { request_id: requestId, path: req.url });
          const cachedContext = compactContextForSelection(getCachedContext(req), body);
          const compactInputAnalysis = analyzeCompactInput(body);
          debugLog("COMPACT INPUT ANALYSIS", compactInputAnalysis);
          writeCompactDump(settings, requestId, "request", {
            requestId,
            path: req.url,
            mode: "llm_compact",
            inputAnalysis: compactInputAnalysis,
            localEvidence: cachedContext?.localEvidence || null
          });
          try {
            const llmCompact = await runLlmCompact(settings, cachedContext, compactInputAnalysis);
            const compactOutputAnalysis = { ...analyzeCompactOutput(llmCompact.response), validation: llmCompact.validation, attempts: llmCompact.attempts, mode: "llm_compact" };
            debugLog("LLM COMPACT RESPONSE", llmCompact.response);
            writeCompactDump(settings, requestId, "response", { requestId, stream: false, outputAnalysis: compactOutputAnalysis, response: llmCompact.response });
            writeJson(res, 200, llmCompact.response);
            log("info", "Proxied compact request", {
              request_id: requestId,
              method: req.method || "POST",
              path: req.url,
              status: 200,
              adapted: true,
              mode: "llm_compact",
              attempts: llmCompact.attempts,
              duration_ms: Date.now() - startedAt
            });
          } catch (error) {
            log("error", "LLM compact failed", { request_id: requestId, error: error.message });
            writeJson(res, 502, { error: { message: error.message, type: "llm_compact_failed" } });
          }
          return;
        }
        rememberThreadContext(req, body);

      const headers = buildUpstreamHeaders(req, settings, targetUrl, {
        stripContentHeaders: bodyTransformed
      });
      if (bodyTransformed) {
        if (body.length) {
          upsertHeader(headers, "content-length", String(Buffer.byteLength(body)));
        }
      }

      debugLog("REQUEST", {
        method: req.method,
        path: req.url,
        targetUrl: targetUrl.href,
        incomingHeaders: sanitizeHeadersForDebug(Object.fromEntries(Object.entries(req.headers))),
        upstreamHeaders: Object.fromEntries(headers.map(([k, v]) => [k, k.toLowerCase() === "authorization" ? maskSecret(v) : v])),
        body: safeBodyPreview(body),
      });

      const upstreamRequest = transport.request(
        {
          method: req.method,
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
          rejectUnauthorized: settings.upstream.verifySsl
        },
        (upstreamResponse) => {
          const stream = isEventStream(upstreamResponse.headers["content-type"]);

          debugLog("RESPONSE HEADERS", {
            status: upstreamResponse.statusCode,
            headers: upstreamResponse.headers,
          });

          const respChunks = [];
          if (!stream) {
            upstreamResponse.on("data", (chunk) => respChunks.push(chunk));
          }

          res.statusCode = upstreamResponse.statusCode || 502;
          writeHeadersToResponse(res, upstreamResponse.rawHeaders);
          upstreamResponse.pipe(res);
          upstreamResponse.on("end", () => {
            if (!stream && respChunks.length) {
              debugLog("RESPONSE BODY", {
                status: upstreamResponse.statusCode,
                body: safeBodyPreview(Buffer.concat(respChunks)),
              });
            }
            log("info", "Proxied request", {
              request_id: requestId,
              method: req.method || "GET",
              path: req.url,
              status: upstreamResponse.statusCode || 502,
              stream,
              duration_ms: Date.now() - startedAt
            });
          });
        }
      );

      upstreamRequest.setTimeout(settings.upstream.timeoutMs, () => {
        upstreamRequest.destroy(new Error("upstream timeout"));
      });

      upstreamRequest.on("error", (error) => {
        const statusCode = error.message === "upstream timeout" ? 504 : 502;
        debugLog("UPSTREAM ERROR", {
          error: error.message,
          code: error.code || "(none)",
          stack: error.stack,
        });
        if (!res.headersSent) {
          writeJson(res, statusCode, {
            error: {
              message: statusCode === 504 ? "Upstream request timed out" : "Failed to reach upstream service",
              type: statusCode === 504 ? "proxy_timeout" : "proxy_upstream_error",
              request_id: requestId
            }
          });
        } else {
          res.destroy(error);
        }
        log("warn", "Proxy request failed", {
          request_id: requestId,
          method: req.method || "GET",
          path: req.url,
          status: statusCode,
          duration_ms: Date.now() - startedAt,
          error: JSON.stringify(error.message)
        });
      });

      upstreamRequest.end(body);
    });
  });
}

const settings = loadConfig();
DEBUG_ENABLED = settings.server.logLevel.toLowerCase() === "debug";
log("info", "Loaded proxy config", {
  config_path: settings.configPath,
  upstream: settings.upstream.baseUrl,
  auth_override: settings.proxy.overrideAuthorization,
  auth_header: settings.upstream.authHeader,
  api_key: maskSecret(settings.upstream.apiKey)
});

const server = createServer(settings);
server.on("error", (error) => {
  log("error", "Node proxy failed to listen", {
    host: settings.server.host,
    port: settings.server.port,
    error: JSON.stringify(error.message)
  });
  process.exit(1);
});

server.listen(settings.server.port, settings.server.host, () => {
  log("info", "Node proxy listening", {
    host: settings.server.host,
    port: settings.server.port
  });
});
