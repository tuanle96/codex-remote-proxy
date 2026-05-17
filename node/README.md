# Node Package

This folder is the actual npm package for Codex Remote Proxy.

## Package Summary

- Runtime: Node.js 20+
- Package name: `@cluic/codex-remote-proxy`
- Global command: `crp`
- Main dependency: `fzstd`

## Typical Usage

### Global install

```bash
npm install -g @cluic/codex-remote-proxy
crp start
```

### Without global install

```bash
npx @cluic/codex-remote-proxy start
```

### From this repository

```bash
cd node
npm install
node bin/crp.mjs start
```

## Important Files

- `bin/crp.mjs`
  Global CLI entrypoint

- `src/server.mjs`
  Local proxy server

- `proxy-config.example.json`
  Example proxy config
