![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy

Codex Remote Proxy lets Codex stay signed into ChatGPT for remote-control features while sending the actual model traffic to your own OpenAI-compatible `base_url` and API key.

[中文文档](./README.zh-CN.md)

Published on npm:

```bash
npm install -g @cluic/codex-remote-proxy
```

## What It Solves

Codex splits request routing and authentication across two local files:

- `~/.codex/config.toml` controls the OpenAI `base_url`
- `~/.codex/auth.json` controls the `Authorization` token

When Codex is signed into ChatGPT, requests may still carry `tokens.access_token` instead of the API key required by your upstream provider.

This project inserts a local proxy that:

1. receives Codex requests on `127.0.0.1`
2. forwards them to the real upstream
3. rewrites `Authorization` to the real upstream API key

## Recommended Installation

The Node implementation is the recommended and most tested path for successful forwarding and conversations.

### Global install

```bash
npm install -g @cluic/codex-remote-proxy
```

Then run:

```bash
crp init
crp start
```

### Without global install

```bash
npx @cluic/codex-remote-proxy init
npx @cluic/codex-remote-proxy start
```

### From this repository

If you are running directly from the repository:

```bash
cd node
npm install
node bin/crp.mjs start
```

After setup:

1. Restart Codex Desktop
2. Sign in with your ChatGPT account
3. Use Codex normally

## Global Home

The CLI manages its own files under:

```text
~/.codex-remote-proxy/
```

This directory is used for:

- runtime config
- managed state
- proxy logs
- optional local shim files

## Secret Handling

You do not have to pass `base_url` and `api_key` to `crp start` every time.

Recommended options:

### Option 1: Save in `~/.codex/config.toml`

Add an optional section like:

```toml
[codex_remote_proxy]
upstream_base_url = "https://your-upstream.example.com"
upstream_api_key = "sk-your-key"
capture_enabled = true
capture_db_path = "/Users/you/.codex-remote-proxy/traffic.sqlite3"
```

Then later runs only need:

```bash
crp start
```

### Option 2: Save once locally with `crp init`

```bash
crp init
crp start
```

`crp init` stores the upstream configuration under:

```text
~/.codex-remote-proxy/config.json
```

After that, later runs only need:

```bash
crp start
```

### Option 3: Use environment variables

```bash
export CRP_UPSTREAM_BASE_URL="https://your-upstream.example.com"
export CRP_UPSTREAM_API_KEY="sk-your-key"
export CRP_CAPTURE_ENABLED="true"
export CRP_CAPTURE_DB_PATH="/Users/you/.codex-remote-proxy/traffic.sqlite3"
crp start
```

`crp start` resolves values in this order:

1. CLI flags
2. Environment variables
3. `~/.codex/config.toml` under `[codex_remote_proxy]` using `upstream_base_url`, `upstream_api_key`, `capture_enabled`, and `capture_db_path`
4. Saved config from `crp init`
5. Interactive prompts

## Request Capture

Request capture is optional and disabled by default.

When enabled, the proxy stores one SQLite row per proxied HTTP transaction under:

```text
~/.codex-remote-proxy/traffic.sqlite3
```

or a custom path you provide with `capture_db_path`.

What is stored:

- full request headers after proxy rewrites
- full request body
- full response headers
- full response body
- SSE responses aggregated into one stored body

Sensitive headers such as `Authorization`, `Cookie`, `Set-Cookie`, and token-like header names are redacted before writing.

Enable capture at startup:

```bash
crp start --capture
crp start --capture --capture-db-path /Users/you/.codex-remote-proxy/custom-traffic.sqlite3
```

Hot-toggle capture on a running managed proxy:

```bash
crp capture on
crp capture off
crp capture status --json
```

You can also edit `~/.codex-remote-proxy/node/proxy-config.json` directly. Changes to `capture.enabled` hot-apply after the proxy validates the SQLite connection. Changes to `capture.dbPath` are detected, but require a restart before the new path is used.

## Global CLI

Main commands:

- `crp check`
  Inspect Codex config, auth mode, runtime availability, and managed service state

- `crp start`
  Accept upstream settings from CLI flags, environment variables, `~/.codex/config.toml` `[codex_remote_proxy]`, or prompts; choose a free port, patch Codex, and start the proxy in the background by default

- `crp init`
  Save upstream settings and optional capture defaults once under `~/.codex-remote-proxy/` so later `crp start` calls do not require secrets again if you do not want to place them in `~/.codex/config.toml`

- `crp install`
  Compatibility alias for `crp start`

- `crp capture on|off|status`
  Toggle SQLite request capture on a running managed proxy, or persist the preference for the next start if the proxy is not running

- `crp status`
  Show managed service status and health. If the proxy is running but not managed by this CLI, it will try to detect that too

- `crp stop`
  Stop the managed service

- `crp guide`
  Print AI-oriented usage guidance

Machine-readable examples:

```bash
crp check --json
crp capture status --json
crp guide --json
crp status --json
```

## For AI Assistants

Recommended flow:

1. Run `crp check --json`
2. Read `recommendedImplementation`
3. If Node dependencies are ready, prefer `node`
4. Prefer existing `~/.codex/config.toml` `[codex_remote_proxy]` with `upstream_base_url`, `upstream_api_key`, `capture_enabled`, and `capture_db_path`, otherwise ask the user to run `crp init` once locally, or rely on environment variables already set outside the AI session
5. Run `crp start`
6. Read `proxyUrl`, `pid`, and `health` from the JSON result
7. Use `crp status --json` for later verification

Notes:

- `start` modifies `~/.codex/config.toml` and creates a backup
- the managed proxy runs in the background by default
- managed state and logs live under `~/.codex-remote-proxy/`
- request capture writes to SQLite only when enabled
- when running directly from this repository, install Node dependencies first
- `~/.codex/config.toml`, `crp init`, or environment variables can keep secrets out of later AI interactions

## Implementations

- [`node/`](./node)
  The packaged npm implementation.

- [`README.zh-CN.md`](./README.zh-CN.md)
  Chinese documentation
