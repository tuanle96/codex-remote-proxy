# Node Version

This implementation is currently the most practical and most tested path for getting successful forwarding and conversations working.

## Highlights

- Runtime: Node.js 20+
- Proxy stack: native `http` / `https`
- npm dependency: `fzstd`
- Config file: `proxy-config.json`
- Setup helper: `scripts/configure-codex-proxy.mjs`

## Quick Start

```bash
cd node
npm install
cp proxy-config.example.json proxy-config.json
node scripts/configure-codex-proxy.mjs install \
  --upstream-base-url https://your-upstream.example.com \
  --api-key sk-your-key
npm start
```

Health check:

```bash
curl http://127.0.0.1:15100/_proxy/health
```

## Best For

- users who already have Node available
- users who do not want a Python virtual environment
- users who want the implementation that has already been validated against Codex compressed request bodies
- future packaging into a single-file CLI or desktop-friendly binary

## Important Files

- `src/server.mjs`
  Node proxy server

- `proxy-config.example.json`
  Example configuration

- `scripts/configure-codex-proxy.mjs`
  `check` / `install` CLI
