# Codex Remote Proxy

Codex Remote Proxy lets Codex stay signed into ChatGPT for remote-control features while sending the actual model traffic to your own OpenAI-compatible upstream and API key.

## Install

```bash
npm install -g @cluic/codex-remote-proxy
```

Then run:

```bash
crp start
```

You can also run it without a global install:

```bash
npx @cluic/codex-remote-proxy start
```

## What It Solves

Codex splits request routing and authentication across two local files:

- `~/.codex/config.toml` controls the OpenAI `base_url`
- `~/.codex/auth.json` controls the `Authorization` token

When Codex is signed into ChatGPT, requests may still carry `tokens.access_token` instead of the API key required by your upstream provider.

This package inserts a local proxy that:

1. receives Codex requests on `127.0.0.1`
2. forwards them to the real upstream
3. rewrites `Authorization` to the real upstream API key

## Recommended Setup

The easiest persistent setup is to add this section to `~/.codex/config.toml`:

```toml
[codex_remote_proxy]
upstream_base_url = "https://your-upstream.example.com"
upstream_api_key = "sk-your-key"
capture_enabled = true
capture_db_path = "/Users/you/.codex-remote-proxy/traffic.sqlite3"
```

Then run:

```bash
crp start
```

If you do not want to place secrets in `~/.codex/config.toml`, use one of these alternatives instead:

### Option 1: Save once locally

```bash
crp init
crp start
```

`crp init` stores the upstream configuration under:

```text
~/.codex-remote-proxy/config.json
```

### Option 2: Use environment variables

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

SQLite request capture is optional and off by default.

When enabled, the proxy stores one full request/response transaction per row in:

```text
~/.codex-remote-proxy/traffic.sqlite3
```

You can enable it at startup:

```bash
crp start --capture
crp start --capture --capture-db-path /Users/you/.codex-remote-proxy/custom-traffic.sqlite3
```

Or hot-toggle it on a running proxy:

```bash
crp capture on
crp capture off
crp capture status --json
```

Edits to `~/.codex-remote-proxy/node/proxy-config.json` also hot-apply `capture.enabled`. Changes to `capture.dbPath` are detected but require a restart before the new database path is used.

## Main Commands

- `crp check`
  Inspect Codex config, auth mode, runtime availability, and managed service state

- `crp start`
  Accept upstream settings from CLI flags, environment variables, `~/.codex/config.toml` `[codex_remote_proxy]`, or prompts; choose a free port, patch Codex, and start the proxy in the background by default

- `crp init`
  Save upstream settings and optional capture defaults once under `~/.codex-remote-proxy/`

- `crp capture on|off|status`
  Toggle SQLite request capture at runtime for a managed proxy, or save the preference for the next start

- `crp status`
  Show managed service status and health

- `crp stop`
  Stop the managed service

- `crp guide`
  Print AI-oriented usage guidance

## Release Flow

This package uses Changesets and GitHub Actions for npm releases.

From `node/`:

```bash
npm run changeset
```

Commit the generated file under `.changeset/` with your feature PR. After the PR is merged to `main`, GitHub Actions will open or update a release PR. Merging that release PR publishes the package to npm.

See [RELEASING.md](./RELEASING.md) for the one-time npm Trusted Publishing setup.

## Notes

- `crp start` modifies `~/.codex/config.toml` and creates a backup
- the managed proxy runs in the background by default
- managed state and logs live under `~/.codex-remote-proxy/`
- request capture redacts sensitive headers before writing
- Node.js 22.13.0 or newer is required
