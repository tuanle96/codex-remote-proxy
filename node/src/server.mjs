import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
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
      requestIdHeader: typeof proxy.requestIdHeader === "string" && proxy.requestIdHeader ? proxy.requestIdHeader : "x-client-request-id"
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

function buildTargetUrl(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl, "http://127.0.0.1");
  const path = incoming.pathname === "/" ? "" : incoming.pathname;
  return new URL(`${baseUrl}${path}${incoming.search}`);
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
      req.on("end", () => {
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
