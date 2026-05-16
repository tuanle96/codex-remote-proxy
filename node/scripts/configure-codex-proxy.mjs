#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_PROXY_CONFIG_PATH = resolve(REPO_ROOT, "proxy-config.json");
const DEFAULT_CODEX_CONFIG_PATH = resolve(os.homedir(), ".codex", "config.toml");
const DEFAULT_AUTH_PATH = resolve(os.homedir(), ".codex", "auth.json");
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
  console.log("  node scripts/configure-codex-proxy.mjs check [--codex-config PATH] [--auth PATH] [--proxy-config PATH]");
  console.log("  node scripts/configure-codex-proxy.mjs install [--codex-config PATH] [--auth PATH] [--proxy-config PATH]");
  console.log("    [--listen-host 127.0.0.1] [--listen-port 15100] [--upstream-base-url URL] [--api-key KEY]");
}

function getPaths(options) {
  return {
    codexConfigPath: resolve(options["codex-config"] || DEFAULT_CODEX_CONFIG_PATH),
    authPath: resolve(options.auth || DEFAULT_AUTH_PATH),
    proxyConfigPath: resolve(options["proxy-config"] || DEFAULT_PROXY_CONFIG_PATH)
  };
}

function readJson(path) {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
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

function tokenSummary(authData) {
  const token = authData?.tokens?.access_token;
  if (typeof token !== "string" || !token) {
    return "(missing)";
  }
  return `${token.slice(0, 2)}..., len=${token.length}`;
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

function renderTomlString(value) {
  return JSON.stringify(value);
}

function parseTomlScalar(rawValue) {
  if (rawValue === "true") {
    return "true";
  }
  if (rawValue === "false") {
    return "false";
  }
  if (rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue;
    }
  }
  return rawValue;
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

function backupFile(path) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backupPath = `${path}.${timestamp}.bak`;
  mkdirSync(resolve(path, ".."), { recursive: true });
  copyFileSync(path, backupPath);
  return backupPath;
}

function ensureParentDir(path) {
  mkdirSync(resolve(path, ".."), { recursive: true });
}

function writeProxyConfig(path, config) {
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function checkCommand(options) {
  const { codexConfigPath, authPath, proxyConfigPath } = getPaths(options);
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const provider = extractOpenAiSection(codexText);
  const authData = readJson(authPath);
  const proxyConfig = readJson(proxyConfigPath);

  console.log(`Codex config path: ${codexConfigPath}`);
  console.log(`Codex auth path:   ${authPath}`);
  console.log(`Proxy config path: ${proxyConfigPath}`);
  console.log("");
  console.log(`auth_mode: ${authData.auth_mode || "(unknown)"}`);
  console.log(`OPENAI_API_KEY: ${maskSecret(authData.OPENAI_API_KEY || "")}`);
  console.log(`tokens.access_token: ${tokenSummary(authData)}`);
  console.log("");
  console.log("Codex [model_providers.OpenAI]:");
  console.log(`  base_url: ${provider.base_url || "(missing)"}`);
  console.log(`  wire_api: ${provider.wire_api || "(missing)"}`);
  console.log(`  requires_openai_auth: ${provider.requires_openai_auth || "(missing)"}`);
  console.log("");
  if (Object.keys(proxyConfig).length > 0) {
    console.log("Proxy config:");
    console.log(`  server.host: ${proxyConfig.server?.host ?? "(missing)"}`);
    console.log(`  server.port: ${proxyConfig.server?.port ?? "(missing)"}`);
    console.log(`  upstream.baseUrl: ${proxyConfig.upstream?.baseUrl ?? "(missing)"}`);
    console.log(`  upstream.apiKey: ${maskSecret(proxyConfig.upstream?.apiKey ?? "")}`);
    console.log(`  proxy.overrideAuthorization: ${proxyConfig.proxy?.overrideAuthorization ?? "(missing)"}`);
  } else {
    console.log("Proxy config: (missing)");
  }
}

function installCommand(options) {
  const { codexConfigPath, authPath, proxyConfigPath } = getPaths(options);
  if (!existsSync(codexConfigPath)) {
    throw new Error(`Codex config not found: ${codexConfigPath}`);
  }

  const listenHost = options["listen-host"] || "127.0.0.1";
  const listenPort = Number.parseInt(options["listen-port"] || "15100", 10);
  const upstreamBaseUrl = options["upstream-base-url"];
  const apiKey = options["api-key"];
  const authHeader = options["auth-header"] || "authorization";
  const authScheme = options["auth-scheme"] || "Bearer";

  if (!upstreamBaseUrl || !/^https?:\/\//.test(upstreamBaseUrl)) {
    throw new Error("--upstream-base-url is required and must start with http:// or https://");
  }
  if (!apiKey) {
    throw new Error("--api-key is required");
  }

  const proxyUrl = `http://${listenHost}:${listenPort}`;
  const proxyConfig = {
    server: {
      host: listenHost,
      port: listenPort,
      logLevel: "info"
    },
    upstream: {
      baseUrl: upstreamBaseUrl.replace(/\/$/, ""),
      apiKey,
      timeoutMs: 300000,
      verifySsl: true,
      authHeader,
      authScheme,
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    }
  };

  let proxyBackup = null;
  if (existsSync(proxyConfigPath)) {
    proxyBackup = backupFile(proxyConfigPath);
  }
  writeProxyConfig(proxyConfigPath, proxyConfig);

  const codexBackup = backupFile(codexConfigPath);
  const patchedText = patchCodexConfigText(readFileSync(codexConfigPath, "utf8"), proxyUrl);
  writeFileSync(codexConfigPath, patchedText, "utf8");

  console.log("Install complete.");
  console.log(`  Proxy config: ${proxyConfigPath}`);
  if (proxyBackup) {
    console.log(`  Proxy config backup: ${proxyBackup}`);
  }
  console.log(`  Codex config backup: ${codexBackup}`);
  console.log(`  Codex OpenAI base_url -> ${proxyUrl}`);
  console.log(`  Upstream base_url -> ${proxyConfig.upstream.baseUrl}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Start the proxy with: npm start");
  console.log(`  2. Verify health with: curl ${proxyUrl}/_proxy/health`);
  console.log("  3. Keep Codex logged into ChatGPT if you need the remote-control feature");
  console.log(`  4. Current auth_mode in auth.json: ${readJson(authPath).auth_mode || "(unknown)"}`);
}

function main() {
  const { command, options } = parseCommandLine(process.argv.slice(2));
  if (command === "check") {
    checkCommand(options);
    return;
  }
  if (command === "install") {
    installCommand(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
