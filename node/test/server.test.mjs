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
