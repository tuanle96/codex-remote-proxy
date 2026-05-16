![Codex Remote Proxy Banner](./assets/banner.png)

# Codex Remote Proxy

Codex Remote Proxy lets Codex stay signed into ChatGPT for remote-control features while sending the actual model traffic to your own OpenAI-compatible `base_url` and API key.

[中文文档](./README.zh-CN.md)

## What It Solves

Codex splits request routing and authentication across two local files:

- `~/.codex/config.toml` controls the OpenAI `base_url`
- `~/.codex/auth.json` controls the `Authorization` token

When Codex is signed into ChatGPT, requests may still carry `tokens.access_token` instead of the API key required by your upstream provider.

This project inserts a local proxy that:

1. receives Codex requests on `127.0.0.1`
2. forwards them to the real upstream
3. rewrites `Authorization` to the real upstream API key

## Recommended Path

The Node implementation is the recommended and most tested path for successful forwarding and conversations.

Before using the root CLI:

```bash
cd node
npm install
cd ..
```

Then run:

```bash
node cli/codex-remote-proxy.mjs install
```

Or run non-interactively:

```bash
node cli/codex-remote-proxy.mjs install \
  --impl node \
  --upstream-base-url https://your-upstream.example.com \
  --api-key sk-your-key
```

After setup:

1. Restart Codex Desktop
2. Sign in with your ChatGPT account
3. Use Codex normally

## Root CLI

Entrypoint:

```bash
node cli/codex-remote-proxy.mjs
```

Main commands:

- `check`
  Inspect Codex config, auth mode, runtime availability, and managed service state

- `install`
  Prompt for or accept `base_url` and `api_key`, choose a free port, patch Codex, and start the proxy in the background by default

- `status`
  Show managed service status and health

- `stop`
  Stop the managed service

- `guide`
  Print AI-oriented usage guidance

Machine-readable examples:

```bash
node cli/codex-remote-proxy.mjs check --json
node cli/codex-remote-proxy.mjs guide --json
node cli/codex-remote-proxy.mjs status --json
```

## For AI Assistants

Recommended flow:

1. Run `node cli/codex-remote-proxy.mjs check --json`
2. Read `recommendedImplementation`
3. If Node dependencies are ready, prefer `node`
4. Run `install`
5. Read `proxyUrl`, `pid`, and `health` from the JSON result
6. Use `status --json` for later verification

Notes:

- `install` modifies `~/.codex/config.toml` and creates a backup
- the managed proxy runs in the background by default
- the Node path currently requires `cd node && npm install`
- in restricted environments, stale managed state may not be removable automatically

## Implementations

- [`node/`](./node)
  Recommended. Handles compressed Codex request bodies and is the most validated path.

- [`python/`](./python)
  Alternative implementation for Python-first users or further experimentation.

## Additional Docs

- [`docs/README.zh-CN.md`](./docs/README.zh-CN.md)
  Chinese documentation
