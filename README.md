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

### Option 1: Save once locally

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

### Option 2: Use environment variables

```bash
export CRP_UPSTREAM_BASE_URL="https://your-upstream.example.com"
export CRP_UPSTREAM_API_KEY="sk-your-key"
crp start
```

`crp start` resolves values in this order:

1. CLI flags
2. Environment variables
3. Saved config from `crp init`
4. Interactive prompts

## Global CLI

Main commands:

- `crp check`
  Inspect Codex config, auth mode, runtime availability, and managed service state

- `crp start`
  Prompt for or accept `base_url` and `api_key`, choose a free port, patch Codex, and start the proxy in the background by default

- `crp init`
  Save upstream settings once under `~/.codex-remote-proxy/` so later `crp start` calls do not require secrets again

- `crp install`
  Compatibility alias for `crp start`

- `crp status`
  Show managed service status and health. If the proxy is running but not managed by this CLI, it will try to detect that too

- `crp stop`
  Stop the managed service

- `crp guide`
  Print AI-oriented usage guidance

Machine-readable examples:

```bash
crp check --json
crp guide --json
crp status --json
```

## For AI Assistants

Recommended flow:

1. Run `crp check --json`
2. Read `recommendedImplementation`
3. If Node dependencies are ready, prefer `node`
4. Ask the user to run `crp init` once locally, or rely on environment variables already set outside the AI session
5. Run `crp start`
6. Read `proxyUrl`, `pid`, and `health` from the JSON result
7. Use `crp status --json` for later verification

Notes:

- `start` modifies `~/.codex/config.toml` and creates a backup
- the managed proxy runs in the background by default
- managed state and logs live under `~/.codex-remote-proxy/`
- when running directly from this repository, install Node dependencies first
- `crp init` or environment variables can keep secrets out of later AI interactions

## Implementations

- [`node/`](./node)
  The packaged npm implementation.

- [`README.zh-CN.md`](./README.zh-CN.md)
  Chinese documentation
