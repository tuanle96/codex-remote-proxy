import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

import { createApp, isDirectExecution } from "../src/server.mjs";

function makeTempDir(prefix) {
  return join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolvePromise, rejectPromise) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolvePromise(address.port);
    });
    server.once("error", rejectPromise);
  });
}

function requestJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-secret",
      "x-client-request-id": "req-it-1",
      "thread-id": "thread-it-1"
    },
    body: JSON.stringify(body)
  });
}

function validCompactText() {
  return [
    "Current task:",
    "Repair the compact proxy route after an upstream fork sync removed the local LLM compact helper implementation.",
    "",
    "User intent:",
    "The user needs /responses/compact to return a valid Responses API handoff instead of a 502 ReferenceError.",
    "",
    "Repo / location:",
    "/Users/tuan/Dev/VibeLab/codex-remote-proxy",
    "",
    "Current state:",
    "The proxy intercepts compact requests and should call the configured chat completions provider directly.",
    "",
    "Important files:",
    "- node/src/server.mjs: owns the compact route and LLM compact helper implementation.",
    "- node/test/server.test.mjs: covers the compact route regression.",
    "",
    "Changes already made:",
    "- Restored the compact helper path and regression coverage in the proxy test suite.",
    "",
    "Known verification:",
    "- Passed: compact route regression test returned a completed response.",
    "- Failed: None recorded.",
    "- Not run: package release workflow.",
    "",
    "Unfinished work:",
    "- Confirm the proxy process is restarted with the patched code.",
    "",
    "Next action:",
    "Run npm test --prefix node and restart the local proxy process after the tests pass.",
    "",
    "Do not do:",
    "- Do not forward /responses/compact to the upstream Responses endpoint.",
    "- Do not reset or discard uncommitted changes.",
    "",
    "This extra detail keeps the compact response above the validator minimum length while preserving concrete state, files, verification, and next action. The content is intentionally deterministic for regression testing."
  ].join("\n");
}

test("compact route uses chat completions helper and returns a compact response", async () => {
  const dir = makeTempDir("crp-compact");
  mkdirSync(dir, { recursive: true });
  const upstreamCalls = [];

  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      upstreamCalls.push({ url: req.url, authorization: req.headers.authorization, payload });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: validCompactText()
          }
        }]
      }));
    });
  });
  const upstreamPort = await listen(upstreamServer);

  const { server, captureManager } = createApp({
    configPath: join(dir, "proxy-config.json"),
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info"
    },
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "upstream-secret",
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: false
    }
  });
  const proxyPort = await listen(server);

  const response = await requestJson(`http://127.0.0.1:${proxyPort}/responses/compact`, {
    model: "gpt-5.4",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "compact this context" }]
    }]
  });

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.status, "completed");
  assert.match(json.output[0].content[0].text, /Current task:/);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "/chat/completions");
  assert.equal(upstreamCalls[0].authorization, "Bearer upstream-secret");
  assert.equal(upstreamCalls[0].payload.model, "gpt-5.5");

  server.close();
  await once(server, "close");
  upstreamServer.close();
  await once(upstreamServer, "close");
  captureManager.close();
  rmSync(dir, { recursive: true, force: true });
});

test("server writes proxied request and response to sqlite", async () => {
  const dir = makeTempDir("crp-server");
  mkdirSync(dir, { recursive: true });

  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = Buffer.concat(chunks).toString("utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "upstream-test-1");
      res.end(JSON.stringify({ ok: true, echoed: JSON.parse(payload) }));
    });
  });
  const upstreamPort = await listen(upstreamServer);

  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info"
    },
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "upstream-secret",
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: true,
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  const { server, captureManager } = createApp({
    configPath: runtimeConfigPath,
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info"
    },
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "upstream-secret",
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: true,
      dbPath
    }
  });
  const proxyPort = await listen(server);

  const response = await requestJson(`http://127.0.0.1:${proxyPort}/responses`, {
    message: "hello"
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);

  server.close();
  await once(server, "close");
  upstreamServer.close();
  await once(upstreamServer, "close");

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT * FROM http_transactions").all();
  db.close();
  captureManager.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, "req-it-1");
  assert.equal(rows[0].thread_id, "thread-it-1");
  assert.equal(rows[0].upstream_request_id, "upstream-test-1");
  assert.match(rows[0].request_headers_json, /REDACTED/);
  assert.match(rows[0].response_body, /"ok":true/);

  rmSync(dir, { recursive: true, force: true });
});

test("isDirectExecution handles both POSIX and Windows paths", () => {
  assert.equal(
    isDirectExecution("file:///Users/example/project/node/src/server.mjs", "/Users/example/project/node/src/server.mjs"),
    true
  );
  assert.equal(
    isDirectExecution("file:///C:/Users/Xingh/project/node/src/server.mjs", "C:\\Users\\Xingh\\project\\node\\src\\server.mjs"),
    true
  );
  assert.equal(
    isDirectExecution("file:///c:/Users/Xingh/project/node/src/server.mjs", "C:/Users/Xingh/project/node/src/server.mjs"),
    true
  );
  assert.equal(
    isDirectExecution("file:///C:/Users/Xingh/project/node/src/server.mjs", "C:\\Users\\Xingh\\project\\node\\src\\other.mjs"),
    false
  );
});
