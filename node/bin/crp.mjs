#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import readline from "node:readline/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CODEX_CONFIG_PATH = resolve(os.homedir(), ".codex", "config.toml");
const DEFAULT_AUTH_PATH = resolve(os.homedir(), ".codex", "auth.json");
const GLOBAL_HOME = resolve(os.homedir(), ".codex-remote-proxy");
const BIN_DIR = resolve(GLOBAL_HOME, "bin");
const CRP_SHIM_PATH = resolve(BIN_DIR, "crp");
const STATE_FILE = resolve(GLOBAL_HOME, "state.json");
const LOG_FILE = resolve(GLOBAL_HOME, "proxy.log");
const NODE_RUNTIME_CONFIG_PATH = resolve(GLOBAL_HOME, "node", "proxy-config.json");
const OPENAI_SECTION_HEADER = "[model_providers.OpenAI]";

function parseCommandLine(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = argv[0];
  const options = {};

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  return { command, options };
}

function printHelp() {
  console.log("Usage:");
  console.log("  crp check [--json] [--codex-config PATH] [--auth PATH]");
  console.log("  crp start [--json] [--upstream-base-url URL] [--api-key KEY] [--listen-host 127.0.0.1] [--listen-port PORT] [--debug]");
  console.log("  crp install [same as start]");
  console.log("  crp status [--json]");
  console.log("  crp stop [--json]");
  console.log("  crp setup [same as start]");
  console.log("  crp guide [--json]");
  console.log("  crp install-cli [--json]");
}

function maybePrintJson(options, payload) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  return false;
}

function getCommonPaths(options) {
  return {
    codexConfigPath: resolve(options["codex-config"] || DEFAULT_CODEX_CONFIG_PATH),
    authPath: resolve(options.auth || DEFAULT_AUTH_PATH)
  };
}

function readJson(path) {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

function findSectionRange(lines, sectionHeader) {
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== sectionHeader) {
      continue;
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const stripped = lines[index].trim();
      if (stripped.startsWith("[") && stripped.endsWith("]")) {
        end = index;
        break;
      }
    }
    return [start, end];
  }
  return null;
}

function parseTomlScalar(rawValue) {
  if (rawValue === "true" || rawValue === "false") {
    return rawValue === "true";
  }
  if (rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue;
    }
  }
  const numeric = Number(rawValue);
  if (!Number.isNaN(numeric) && rawValue.trim() !== "") {
    return numeric;
  }
  return rawValue;
}

function extractOpenAiSection(text) {
  const lines = splitLines(text);
  const range = findSectionRange(lines, OPENAI_SECTION_HEADER);
  const result = {};
  if (!range) {
    return result;
  }

  for (let index = range[0] + 1; index < range[1]; index += 1) {
    const stripped = lines[index].trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      continue;
    }
    const [key, rawValue] = stripped.split("=", 2).map((item) => item.trim());
    result[key] = parseTomlScalar(rawValue);
  }
  return result;
}

function detectNodeRuntime() {
  const depCheck = spawnSync("node", ["-e", "import('fzstd').then(()=>process.exit(0)).catch(()=>process.exit(1))"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8"
  });
  return {
    available: true,
    version: process.version,
    dependenciesReady: depCheck.status === 0,
    installHint: depCheck.status === 0 ? null : "Run `npm install` in the package directory first.",
    error: null
  };
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

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function startCommand(configPath) {
  return `CODEX_PROXY_CONFIG=${quoteShell(configPath)} node ${quoteShell(resolve(PACKAGE_ROOT, "src", "server.mjs"))}`;
}

function healthCommand(listenHost, listenPort) {
  return `curl http://${listenHost}:${listenPort}/_proxy/health`;
}

function ensureStateDirs() {
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(resolve(GLOBAL_HOME, "node"), { recursive: true });
}

function loadManagedState() {
  if (!existsSync(STATE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function removeManagedState() {
  if (existsSync(STATE_FILE)) {
    try {
      rmSync(STATE_FILE);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getManagedServiceInfo() {
  const state = loadManagedState();
  if (!state) {
    return { state: null, staleStateRemoved: false };
  }
  const alive = Boolean(state.pid && isProcessAlive(state.pid));
  if (!alive) {
    return { state: null, staleStateRemoved: removeManagedState() };
  }
  return {
    state: {
      ...state,
      alive: true
    },
    staleStateRemoved: false
  };
}

function saveManagedState(state) {
  ensureStateDirs();
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function chooseFreePort(host) {
  return await new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) {
          rejectPort(closeError);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function promptValue(question, defaultValue = "") {
  if (!process.stdin.isTTY) {
    if (defaultValue) {
      return defaultValue;
    }
    throw new Error(`${question} is required`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function waitForHealthyProxy(proxyUrl, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${proxyUrl}/_proxy/health`);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Proxy did not become healthy at ${proxyUrl}: ${lastError?.message || "timeout"}`);
}

async function probeConfiguredLocalProxy(codexConfigPath) {
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const provider = extractOpenAiSection(codexText);
  const baseUrl = provider.base_url;
  if (typeof baseUrl !== "string" || !baseUrl) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return null;
  }

  if (!new Set(["127.0.0.1", "localhost"]).has(parsedUrl.hostname)) {
    return null;
  }

  try {
    const health = await waitForHealthyProxy(baseUrl, 1500);
    return { proxyUrl: baseUrl, managed: false, health };
  } catch (error) {
    return { proxyUrl: baseUrl, managed: false, healthError: error.message };
  }
}

function stopManagedService(state = loadManagedState()) {
  if (!state?.pid) {
    return { stopped: false, reason: "no_state" };
  }
  if (!isProcessAlive(state.pid)) {
    const cleared = removeManagedState();
    return { stopped: false, reason: cleared ? "already_stopped" : "already_stopped_state_uncleared" };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    const cleared = removeManagedState();
    return { stopped: false, reason: cleared ? "signal_failed" : "signal_failed_state_uncleared" };
  }
  const cleared = removeManagedState();
  return { stopped: true, reason: cleared ? "signal_sent" : "signal_sent_state_uncleared" };
}

function startManagedService(proxyConfigPath, debug) {
  const env = {
    ...process.env,
    CODEX_PROXY_CONFIG: proxyConfigPath
  };

  if (debug) {
    const child = spawn("node", [resolve(PACKAGE_ROOT, "src", "server.mjs")], {
      cwd: PACKAGE_ROOT,
      env,
      stdio: "inherit"
    });
    return { pid: child.pid, mode: "foreground", child };
  }

  ensureStateDirs();
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn("node", [resolve(PACKAGE_ROOT, "src", "server.mjs")], {
    cwd: PACKAGE_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  closeSync(logFd);
  return { pid: child.pid, mode: "background", logFile: LOG_FILE };
}

function installCliShim() {
  ensureStateDirs();
  const shim = `#!/bin/sh\nexec node ${quoteShell(resolve(PACKAGE_ROOT, "bin", "crp.mjs"))} "$@"\n`;
  writeFileSync(CRP_SHIM_PATH, shim, "utf8");
  chmodSync(CRP_SHIM_PATH, 0o755);
  return {
    shimPath: CRP_SHIM_PATH,
    exportCommand: `export PATH=${quoteShell(BIN_DIR)}:$PATH`
  };
}

function buildGuideData() {
  return {
    entrypoint: "crp",
    preferredImplementation: "node",
    commands: {
      inspect: "crp check --json",
      start: "crp start --upstream-base-url <URL> --api-key <KEY> --json",
      status: "crp status --json",
      stop: "crp stop --json",
      installCli: "npm install -g @cluic/codex-remote-proxy",
      runWithoutInstall: "npx @cluic/codex-remote-proxy guide --json"
    },
    expectedFlow: [
      "Run check --json first.",
      "Read runtimeStatus and recommendedImplementation.",
      "If node dependencies are ready, use the node path.",
      "Run start with --upstream-base-url and --api-key, or let the CLI prompt interactively.",
      "start launches the proxy in the background by default and patches ~/.codex/config.toml.",
      "Use status --json to confirm the proxy is healthy."
    ],
    notes: [
      "The start command modifies ~/.codex/config.toml and creates a backup.",
      "The proxy configuration and state are stored under ~/.codex-remote-proxy/."
    ]
  };
}

function buildCheckData(options) {
  const { codexConfigPath, authPath } = getCommonPaths(options);
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const provider = extractOpenAiSection(codexText);
  const authData = readJson(authPath);
  const managedInfo = getManagedServiceInfo();
  const runtimeStatus = { node: detectNodeRuntime() };

  return {
    codexConfigPath,
    authPath,
    codexOpenAiProvider: {
      baseUrl: provider.base_url ?? null,
      wireApi: provider.wire_api ?? null,
      requiresOpenAiAuth: provider.requires_openai_auth ?? null
    },
    auth: {
      authMode: authData.auth_mode ?? null,
      openAiApiKeyPreview: typeof authData.OPENAI_API_KEY === "string" ? maskSecret(authData.OPENAI_API_KEY) : null,
      accessTokenPrefix: typeof authData?.tokens?.access_token === "string" ? authData.tokens.access_token.slice(0, 2) : null,
      accessTokenLength: typeof authData?.tokens?.access_token === "string" ? authData.tokens.access_token.length : 0
    },
    runtimeStatus,
    implementation: {
      configPath: NODE_RUNTIME_CONFIG_PATH,
      configExists: existsSync(NODE_RUNTIME_CONFIG_PATH),
      startCommand: startCommand(NODE_RUNTIME_CONFIG_PATH)
    },
    recommendedImplementation: "node",
    managedService: managedInfo.state,
    staleStateRemoved: managedInfo.staleStateRemoved,
    globalHome: GLOBAL_HOME,
    globalCommand: "crp"
  };
}

function printHumanCheck(data) {
  console.log(`Codex config path: ${data.codexConfigPath}`);
  console.log(`Codex auth path:   ${data.authPath}`);
  console.log("");
  console.log(`auth_mode: ${data.auth.authMode || "(unknown)"}`);
  console.log(`OPENAI_API_KEY: ${data.auth.openAiApiKeyPreview || "(missing)"}`);
  console.log(`tokens.access_token: ${data.auth.accessTokenPrefix ? `${data.auth.accessTokenPrefix}..., len=${data.auth.accessTokenLength}` : "(missing)"}`);
  console.log("");
  console.log("Codex [model_providers.OpenAI]:");
  console.log(`  base_url: ${data.codexOpenAiProvider.baseUrl || "(missing)"}`);
  console.log(`  wire_api: ${data.codexOpenAiProvider.wireApi || "(missing)"}`);
  console.log(`  requires_openai_auth: ${data.codexOpenAiProvider.requiresOpenAiAuth ?? "(missing)"}`);
  console.log("");
  console.log("Runtime status:");
  console.log(`  node: ${data.runtimeStatus.node.available ? data.runtimeStatus.node.version : data.runtimeStatus.node.error}`);
  if (data.runtimeStatus.node.available && !data.runtimeStatus.node.dependenciesReady) {
    console.log(`        ${data.runtimeStatus.node.installHint}`);
  }
  console.log("");
  console.log(`Global home: ${data.globalHome}`);
  console.log(`Global command: ${data.globalCommand}`);
}

function writeProxyConfig(path, config) {
  ensureStateDirs();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function backupFile(path) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backupPath = `${path}.${timestamp}.bak`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function renderTomlString(value) {
  return JSON.stringify(value);
}

function upsertKey(lines, startIndex, endIndex, key, value) {
  const rendered = typeof value === "boolean" ? (value ? "true" : "false") : renderTomlString(String(value));
  for (let index = startIndex; index < endIndex; index += 1) {
    const stripped = lines[index].trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      continue;
    }
    const currentKey = stripped.split("=", 1)[0].trim();
    if (currentKey === key) {
      lines[index] = `${key} = ${rendered}`;
      return lines;
    }
  }
  lines.splice(endIndex, 0, `${key} = ${rendered}`);
  return lines;
}

function firstSectionIndex(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      return index;
    }
  }
  return lines.length;
}

function patchCodexConfigText(text, proxyUrl) {
  const lines = splitLines(text);
  const topEnd = firstSectionIndex(lines);
  upsertKey(lines, 0, topEnd, "model_provider", "OpenAI");
  let sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);

  if (!sectionRange) {
    if (lines.length && lines[lines.length - 1].trim()) {
      lines.push("");
    }
    lines.push(
      OPENAI_SECTION_HEADER,
      'name = "OpenAI"',
      `base_url = ${renderTomlString(proxyUrl)}`,
      'wire_api = "responses"',
      "requires_openai_auth = true"
    );
    return `${lines.join("\n")}\n`;
  }

  const [sectionStart] = sectionRange;
  upsertKey(lines, sectionStart + 1, sectionRange[1], "name", "OpenAI");
  sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);
  upsertKey(lines, sectionStart + 1, sectionRange[1], "base_url", proxyUrl);
  sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);
  upsertKey(lines, sectionStart + 1, sectionRange[1], "wire_api", "responses");
  sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);
  upsertKey(lines, sectionStart + 1, sectionRange[1], "requires_openai_auth", true);
  return `${lines.join("\n")}\n`;
}

async function installCommand(options) {
  if (options.json && options.debug) {
    throw new Error("--json cannot be combined with --debug");
  }

  const checkData = buildCheckData(options);
  if (!checkData.runtimeStatus.node.dependenciesReady) {
    throw new Error("Node dependencies are missing. Run `npm install` first.");
  }

  const upstreamBaseUrl = options["upstream-base-url"] || await promptValue("Upstream base URL", "");
  const apiKey = options["api-key"] || await promptValue("Upstream API key", "");
  if (!upstreamBaseUrl || !apiKey) {
    throw new Error("Upstream base URL and API key are required");
  }

  const listenHost = options["listen-host"] || "127.0.0.1";
  const listenPort = options["listen-port"] ? Number.parseInt(options["listen-port"], 10) : await chooseFreePort(listenHost);
  const codexConfigPath = getCommonPaths(options).codexConfigPath;
  const authPath = getCommonPaths(options).authPath;
  const proxyConfigPath = NODE_RUNTIME_CONFIG_PATH;
  const proxyUrl = `http://${listenHost}:${listenPort}`;

  const proxyConfig = {
    server: { host: listenHost, port: listenPort, logLevel: "info" },
    upstream: {
      baseUrl: upstreamBaseUrl.replace(/\/$/, ""),
      apiKey,
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    }
  };

  ensureStateDirs();
  writeProxyConfig(proxyConfigPath, proxyConfig);
  if (!existsSync(codexConfigPath)) {
    throw new Error(`Codex config not found: ${codexConfigPath}`);
  }
  const codexBackup = backupFile(codexConfigPath);
  const patchedText = patchCodexConfigText(readFileSync(codexConfigPath, "utf8"), proxyUrl);
  writeFileSync(codexConfigPath, patchedText, "utf8");

  const existingState = loadManagedState();
  if (existingState?.pid && isProcessAlive(existingState.pid)) {
    stopManagedService(existingState);
  }

  const startResult = startManagedService(proxyConfigPath, Boolean(options.debug));
  const managedState = {
    version: 1,
    implementation: "node",
    pid: startResult.pid,
    mode: startResult.mode,
    listenHost,
    listenPort,
    proxyUrl,
    codexConfigPath,
    authPath,
    proxyConfigPath,
    logFile: startResult.logFile || null,
    upstreamBaseUrl,
    codexConfigBackup: codexBackup,
    startedAt: new Date().toISOString()
  };
  saveManagedState(managedState);

  if (options.debug) {
    console.log(`Proxy configured at ${proxyUrl}`);
    console.log("Debug mode is active; the proxy runs in the foreground.");
    await delay(250);
    if (startResult.child?.exitCode != null) {
      stopManagedService(managedState);
      throw new Error(`Proxy exited immediately with code ${startResult.child.exitCode}`);
    }
    if (startResult.child && startResult.child.exitCode == null && startResult.child.signalCode == null) {
      await new Promise((resolveExit) => startResult.child.once("exit", resolveExit));
    }
    return;
  }

  const health = await waitForHealthyProxy(proxyUrl);
  const payload = {
    ok: true,
    implementation: "node",
    proxyUrl,
    pid: startResult.pid,
    listenHost,
    listenPort,
    upstreamBaseUrl,
    codexConfigPath,
    proxyConfigPath,
    logFile: managedState.logFile,
    managedStatePath: STATE_FILE,
    health,
    message: "Proxy configured and started"
  };

  if (!maybePrintJson(options, payload)) {
    console.log("Codex Remote Proxy is ready.");
    console.log(`Proxy URL: ${proxyUrl}`);
    console.log("Running in background: yes");
    console.log("");
    console.log("Next steps:");
    console.log("1. Restart Codex Desktop.");
    console.log("2. Sign in with your ChatGPT account.");
    console.log("3. Continue using Codex as usual; requests will be forwarded to your upstream API.");
    console.log("");
    console.log(`Health check: curl ${proxyUrl}/_proxy/health`);
    console.log("Status: crp status --json");
    console.log("Stop:   crp stop --json");
  }
}

const startCommandAction = installCommand;

function checkCommand(options) {
  const data = buildCheckData(options);
  if (!maybePrintJson(options, data)) {
    printHumanCheck(data);
  }
}

function guideCommand(options) {
  const data = buildGuideData();
  if (!maybePrintJson(options, data)) {
    console.log("AI guide:");
    console.log(`  Entrypoint: ${data.entrypoint}`);
    console.log(`  Inspect first: ${data.commands.inspect}`);
    console.log(`  Install:       ${data.commands.install}`);
    console.log(`  Status:        ${data.commands.status}`);
  }
}

async function statusCommand(options) {
  const managedInfo = getManagedServiceInfo();
  const state = managedInfo.state;
  const alive = Boolean(state);
  const payload = {
    ok: true,
    running: alive,
    state,
    staleStateRemoved: managedInfo.staleStateRemoved
  };
  if (state?.proxyUrl && alive) {
    try {
      payload.health = await waitForHealthyProxy(state.proxyUrl, 2000);
    } catch (error) {
      payload.healthError = error.message;
    }
  } else {
    const probe = await probeConfiguredLocalProxy(getCommonPaths(options).codexConfigPath);
    if (probe) {
      payload.probe = probe;
    }
  }
  if (!maybePrintJson(options, payload)) {
    if (alive) {
      console.log("Proxy is running.");
    } else if (payload.probe?.health) {
      console.log("A proxy is running, but it is unmanaged by this CLI.");
      console.log(`Proxy URL: ${payload.probe.proxyUrl}`);
    } else {
      console.log("Proxy is not running.");
    }
  }
}

async function stopCommand(options) {
  const result = stopManagedService(loadManagedState());
  const payload = { ok: true, stopped: result.stopped, reason: result.reason };
  if (!maybePrintJson(options, payload)) {
    console.log(result.stopped ? "Proxy stopped." : "No running proxy to stop.");
  }
}

async function installCliCommand(options) {
  const result = installCliShim();
  const payload = {
    ok: true,
    shimPath: result.shimPath,
    binDir: BIN_DIR,
    exportCommand: result.exportCommand,
    deprecated: true,
    message: "install-cli is deprecated for public distribution; prefer npm global installation."
  };
  if (!maybePrintJson(options, payload)) {
    console.log("Legacy local shim installed.");
    console.log("For public distribution, prefer:");
    console.log("npm install -g @cluic/codex-remote-proxy");
  }
}

async function main() {
  const { command, options } = parseCommandLine(process.argv.slice(2));
  if (command === "check") return checkCommand(options);
  if (command === "guide") return guideCommand(options);
  if (command === "start" || command === "install" || command === "setup") return await startCommandAction(options);
  if (command === "status") return await statusCommand(options);
  if (command === "stop") return await stopCommand(options);
  if (command === "install-cli") return await installCliCommand(options);
  throw new Error(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
