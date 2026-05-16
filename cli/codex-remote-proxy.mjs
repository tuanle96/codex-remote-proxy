#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import readline from "node:readline/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CODEX_CONFIG_PATH = resolve(os.homedir(), ".codex", "config.toml");
const DEFAULT_AUTH_PATH = resolve(os.homedir(), ".codex", "auth.json");
const DEFAULT_NODE_PROXY_CONFIG_PATH = resolve(REPO_ROOT, "node", "proxy-config.json");
const DEFAULT_PYTHON_PROXY_CONFIG_PATH = resolve(REPO_ROOT, "python", "proxy-config.toml");
const STATE_DIR = resolve(os.homedir(), ".codex", "codex-remote-proxy");
const STATE_FILE = resolve(STATE_DIR, "state.json");
const LOG_FILE = resolve(STATE_DIR, "proxy.log");
const NODE_RUNTIME_CONFIG_PATH = resolve(STATE_DIR, "node", "proxy-config.json");
const PYTHON_RUNTIME_CONFIG_PATH = resolve(STATE_DIR, "python", "proxy-config.toml");
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
  console.log("  node cli/codex-remote-proxy.mjs check [--json]");
  console.log("    [--codex-config PATH] [--auth PATH]");
  console.log("");
  console.log("  node cli/codex-remote-proxy.mjs install [--json]");
  console.log("    [--impl node|python] [--upstream-base-url URL] [--api-key KEY]");
  console.log("    [--listen-host 127.0.0.1] [--listen-port PORT] [--debug]");
  console.log("    [--codex-config PATH] [--auth PATH] [--proxy-config PATH]");
  console.log("");
  console.log("  node cli/codex-remote-proxy.mjs status [--json]");
  console.log("  node cli/codex-remote-proxy.mjs stop [--json]");
  console.log("  node cli/codex-remote-proxy.mjs setup [same as install]");
  console.log("");
  console.log("  node cli/codex-remote-proxy.mjs guide [--json]");
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

function firstSectionIndex(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      return index;
    }
  }
  return lines.length;
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

function detectPythonRuntime() {
  const result = spawnSync("python3", ["--version"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  });
  return {
    available: result.status === 0,
    version: result.status === 0 ? (result.stdout || result.stderr).trim() : null,
    error: result.status === 0 ? null : (result.stderr || result.error?.message || "python3 not available").trim()
  };
}

function detectNodeRuntime() {
  const depCheck = spawnSync("node", ["-e", "import('fzstd').then(()=>process.exit(0)).catch(()=>process.exit(1))"], {
    cwd: resolve(REPO_ROOT, "node"),
    encoding: "utf8"
  });
  return {
    available: true,
    version: process.version,
    dependenciesReady: depCheck.status === 0,
    installHint: depCheck.status === 0 ? null : "Run `cd node && npm install` first.",
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

function chooseRecommendedImplementation(runtimeStatus) {
  if (runtimeStatus.node.available && runtimeStatus.node.dependenciesReady) {
    return "node";
  }
  if (runtimeStatus.python.available) {
    return "python";
  }
  if (runtimeStatus.node.available) {
    return "node";
  }
  return null;
}

function defaultProxyConfigPath(impl) {
  return impl === "python" ? DEFAULT_PYTHON_PROXY_CONFIG_PATH : DEFAULT_NODE_PROXY_CONFIG_PATH;
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function startCommand(impl, configPath) {
  if (impl === "python") {
    return `CODEX_PROXY_CONFIG=${quoteShell(configPath)} python3 python/main.py`;
  }
  return `CODEX_PROXY_CONFIG=${quoteShell(configPath)} node node/src/server.mjs`;
}

function healthCommand(listenHost, listenPort) {
  return `curl http://${listenHost}:${listenPort}/_proxy/health`;
}

function ensureStateDirs() {
  mkdirSync(resolve(STATE_DIR, "node"), { recursive: true });
  mkdirSync(resolve(STATE_DIR, "python"), { recursive: true });
}

function runtimeConfigPathForImpl(impl) {
  return impl === "python" ? PYTHON_RUNTIME_CONFIG_PATH : NODE_RUNTIME_CONFIG_PATH;
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

async function promptSecret(question, defaultValue = "") {
  return await promptValue(question, defaultValue);
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

function startManagedService(impl, proxyConfigPath, debug) {
  const executable = impl === "python" ? "python3" : "node";
  const scriptPath = impl === "python"
    ? resolve(REPO_ROOT, "python", "main.py")
    : resolve(REPO_ROOT, "node", "src", "server.mjs");

  const env = {
    ...process.env,
    CODEX_PROXY_CONFIG: proxyConfigPath
  };

  if (debug) {
    const child = spawn(executable, [scriptPath], {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit"
    });
    return { pid: child.pid, mode: "foreground", child };
  }

  ensureStateDirs();
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(executable, [scriptPath], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  closeSync(logFd);
  return { pid: child.pid, mode: "background", logFile: LOG_FILE };
}

function buildGuideData() {
  return {
    entrypoint: "node cli/codex-remote-proxy.mjs",
    preferredImplementation: "node",
    commands: {
      inspect: "node cli/codex-remote-proxy.mjs check --json",
      installNode: "node cli/codex-remote-proxy.mjs install --impl node --upstream-base-url <URL> --api-key <KEY> --json",
      installPython: "node cli/codex-remote-proxy.mjs install --impl python --upstream-base-url <URL> --api-key <KEY> --json",
      status: "node cli/codex-remote-proxy.mjs status --json",
      stop: "node cli/codex-remote-proxy.mjs stop --json"
    },
    expectedFlow: [
      "Run check --json first.",
      "Read recommendedImplementation from the JSON output.",
      "If node dependencies are ready, prefer --impl node unless the user explicitly wants python.",
      "If node is available but dependencies are missing, ask the user to run `cd node && npm install` first or fall back to python.",
      "Run install with --upstream-base-url and --api-key, or let the CLI prompt interactively.",
      "install starts the proxy in the background by default and patches ~/.codex/config.toml.",
      "Use status --json to confirm the proxy is healthy.",
      "Use stop --json if you need to shut it down."
    ],
    notes: [
      "The install command modifies ~/.codex/config.toml and creates a backup.",
      "The proxy configuration is stored outside Codex internal files.",
      "Both implementations rewrite Authorization to the real upstream API key."
    ]
  };
}

function buildCheckData(options) {
  const { codexConfigPath, authPath } = getCommonPaths(options);
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const provider = extractOpenAiSection(codexText);
  const authData = readJson(authPath);
  const managedInfo = getManagedServiceInfo();
  const runtimeStatus = {
    node: detectNodeRuntime(),
    python: detectPythonRuntime()
  };
  const recommendedImplementation = chooseRecommendedImplementation(runtimeStatus);

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
    implementations: {
      node: {
        configPath: NODE_RUNTIME_CONFIG_PATH,
        configExists: existsSync(NODE_RUNTIME_CONFIG_PATH),
        startCommand: startCommand("node", NODE_RUNTIME_CONFIG_PATH)
      },
      python: {
        configPath: PYTHON_RUNTIME_CONFIG_PATH,
        configExists: existsSync(PYTHON_RUNTIME_CONFIG_PATH),
        startCommand: startCommand("python", PYTHON_RUNTIME_CONFIG_PATH)
      }
    },
    recommendedImplementation,
    managedService: managedInfo.state,
    staleStateRemoved: managedInfo.staleStateRemoved
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
  console.log(`  python: ${data.runtimeStatus.python.available ? data.runtimeStatus.python.version : data.runtimeStatus.python.error}`);
  console.log("");
  console.log(`Recommended implementation: ${data.recommendedImplementation || "(none)"}`);
  console.log("");
  if (data.managedService) {
    console.log("Managed service:");
    console.log(`  implementation: ${data.managedService.implementation}`);
    console.log(`  proxy_url: ${data.managedService.proxyUrl}`);
    console.log(`  pid: ${data.managedService.pid}`);
    console.log(`  alive: ${data.managedService.alive}`);
    console.log(`  log_file: ${data.managedService.logFile || "(none)"}`);
  } else {
    console.log("Managed service: (not configured)");
  }
}

function runImplementationInstaller(impl, options) {
  const { codexConfigPath, authPath } = getCommonPaths(options);
  const listenHost = options["listen-host"] || "127.0.0.1";
  const listenPort = options["listen-port"] || "15100";
  const upstreamBaseUrl = options["upstream-base-url"];
  const apiKey = options["api-key"];
  const proxyConfigPath = resolve(options["proxy-config"] || defaultProxyConfigPath(impl));
  const authHeader = options["auth-header"] || "authorization";
  const authScheme = options["auth-scheme"] || "Bearer";

  if (!upstreamBaseUrl || !apiKey) {
    throw new Error("--upstream-base-url and --api-key are required");
  }

  const runtimeStatus = {
    node: detectNodeRuntime(),
    python: detectPythonRuntime()
  };

  if (impl === "python" && !runtimeStatus.python.available) {
    throw new Error(`python implementation requested but python3 is not available: ${runtimeStatus.python.error}`);
  }

  const executable = impl === "python" ? "python3" : "node";
  const scriptPath = impl === "python"
    ? resolve(REPO_ROOT, "python", "scripts", "configure_codex_proxy.py")
    : resolve(REPO_ROOT, "node", "scripts", "configure-codex-proxy.mjs");

  const args = [
    scriptPath,
    "install",
    "--codex-config", codexConfigPath,
    "--auth", authPath,
    "--proxy-config", proxyConfigPath,
    "--listen-host", listenHost,
    "--listen-port", String(listenPort),
    "--upstream-base-url", upstreamBaseUrl,
    "--api-key", apiKey,
    "--auth-header", authHeader,
    "--auth-scheme", authScheme
  ];

  const result = spawnSync(executable, args, {
    cwd: REPO_ROOT,
    encoding: "utf8"
  });

  return {
    impl,
    executable,
    args,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    proxyConfigPath,
    listenHost,
    listenPort: Number(listenPort),
    upstreamBaseUrl,
    startCommand: startCommand(impl, proxyConfigPath),
    healthCheckCommand: healthCommand(listenHost, listenPort)
  };
}

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
    console.log(`  Node install:  ${data.commands.installNode}`);
    console.log(`  Python install:${data.commands.installPython}`);
    console.log("");
    for (const step of data.expectedFlow) {
      console.log(`- ${step}`);
    }
  }
}

async function installCommand(options) {
  if (options.json && options.debug) {
    throw new Error("--json cannot be combined with --debug");
  }

  const checkData = buildCheckData(options);
  const impl = options.impl || checkData.recommendedImplementation || "node";

  if (!["node", "python"].includes(impl)) {
    throw new Error("Unable to choose an implementation. Use --impl node or --impl python explicitly.");
  }

  if (impl === "node" && !checkData.runtimeStatus.node.dependenciesReady) {
    throw new Error("Node dependencies are missing. Run `cd node && npm install` first.");
  }

  const upstreamBaseUrl = options["upstream-base-url"] || await promptValue("Upstream base URL", "");
  const apiKey = options["api-key"] || await promptSecret("Upstream API key", "");
  if (!upstreamBaseUrl) {
    throw new Error("Upstream base URL is required");
  }
  if (!apiKey) {
    throw new Error("Upstream API key is required");
  }

  const listenHost = options["listen-host"] || "127.0.0.1";
  const listenPort = options["listen-port"] ? Number.parseInt(options["listen-port"], 10) : await chooseFreePort(listenHost);
  if (!Number.isInteger(listenPort) || listenPort <= 0) {
    throw new Error("listen port must be a positive integer");
  }

  const codexConfigPath = getCommonPaths(options).codexConfigPath;
  const authPath = getCommonPaths(options).authPath;
  const proxyConfigPath = runtimeConfigPathForImpl(impl);
  const existingState = loadManagedState();
  if (existingState?.pid && isProcessAlive(existingState.pid)) {
    stopManagedService(existingState);
  }

  ensureStateDirs();
  const result = runImplementationInstaller(impl, {
    ...options,
    "codex-config": codexConfigPath,
    auth: authPath,
    "proxy-config": proxyConfigPath,
    "listen-host": listenHost,
    "listen-port": String(listenPort),
    "upstream-base-url": upstreamBaseUrl,
    "api-key": apiKey
  });

  if (result.status !== 0) {
    const errorPayload = {
      ok: false,
      implementation: impl,
      status: result.status,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim()
    };
    if (!maybePrintJson(options, errorPayload)) {
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    process.exit(result.status || 1);
  }

  const proxyUrl = `http://${listenHost}:${listenPort}`;
  const startResult = startManagedService(impl, proxyConfigPath, Boolean(options.debug));
  const managedState = {
    version: 1,
    implementation: impl,
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
    startedAt: new Date().toISOString()
  };
  saveManagedState(managedState);

  if (options.debug) {
    console.log("");
    console.log(`Proxy configured at ${proxyUrl}`);
    console.log(`Implementation: ${impl}`);
    console.log(`Config file: ${proxyConfigPath}`);
    console.log("Debug mode is active; the proxy runs in the foreground.");
    console.log("Restart Codex Desktop and sign in with your ChatGPT account if needed.");
    await delay(250);
    if (startResult.child?.exitCode != null) {
      stopManagedService(managedState);
      throw new Error(`Proxy exited immediately with code ${startResult.child.exitCode}`);
    }
    if (startResult.child && startResult.child.exitCode == null && startResult.child.signalCode == null) {
      await new Promise((resolveExit) => {
        startResult.child.once("exit", () => resolveExit());
      });
    }
    return;
  }

  let health = null;
  try {
    health = await waitForHealthyProxy(proxyUrl);
  } catch (error) {
    stopManagedService(managedState);
    throw error;
  }

  const payload = {
    ok: true,
    implementation: impl,
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
    console.log(`Implementation: ${impl}`);
    console.log(`Running in background: yes`);
    console.log("");
    console.log("Next steps:");
    console.log("1. Restart Codex Desktop.");
    console.log("2. Sign in with your ChatGPT account.");
    console.log("3. Continue using Codex as usual; requests will be forwarded to your upstream API.");
    console.log("");
    console.log(`Health check: curl ${proxyUrl}/_proxy/health`);
    console.log(`Status: node cli/codex-remote-proxy.mjs status --json`);
    console.log(`Stop:   node cli/codex-remote-proxy.mjs stop --json`);
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
      const health = await waitForHealthyProxy(state.proxyUrl, 2000);
      payload.health = health;
    } catch (error) {
      payload.healthError = error.message;
    }
  }
  if (!maybePrintJson(options, payload)) {
    console.log(alive ? "Proxy is running." : "Proxy is not running.");
    if (state) {
      console.log(`Implementation: ${state.implementation}`);
      console.log(`Proxy URL: ${state.proxyUrl}`);
      console.log(`PID: ${state.pid}`);
      console.log(`Log file: ${state.logFile || "(none)"}`);
    }
  }
}

async function stopCommand(options) {
  const state = loadManagedState();
  const result = stopManagedService(state);
  const payload = {
    ok: true,
    stopped: result.stopped,
    reason: result.reason
  };
  if (!maybePrintJson(options, payload)) {
    console.log(result.stopped ? "Proxy stopped." : "No running proxy to stop.");
  }
}

async function main() {
  const { command, options } = parseCommandLine(process.argv.slice(2));
  if (command === "check") {
    checkCommand(options);
    return;
  }
  if (command === "guide") {
    guideCommand(options);
    return;
  }
  if (command === "install" || command === "setup") {
    await installCommand(options);
    return;
  }
  if (command === "status") {
    await statusCommand(options);
    return;
  }
  if (command === "stop") {
    await stopCommand(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
