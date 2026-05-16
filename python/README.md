# Python Version

This implementation is for users who already have Python 3.11+ or want a FastAPI/httpx codebase that is easy to extend.

## Highlights

- Runtime: Python
- Proxy stack: FastAPI + httpx
- Config file: `proxy-config.toml`
- Setup helper: `scripts/configure_codex_proxy.py`

## Quick Start

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp proxy-config.example.toml proxy-config.toml
python3 scripts/configure_codex_proxy.py install
python3 main.py
```

Health check:

```bash
curl http://127.0.0.1:15100/_proxy/health
```

## Setup Model

Users only need to provide:

- `upstream.base_url`
- `upstream.api_key`

The helper script takes care of the rest:

- checking the current mode in `~/.codex/auth.json`
- backing up `~/.codex/config.toml`
- rewriting `[model_providers.OpenAI].base_url` to the local proxy

## Important Files

- `main.py`
  Python proxy server

- `proxy-config.example.toml`
  Example configuration

- `scripts/configure_codex_proxy.py`
  `check` / `install` CLI
