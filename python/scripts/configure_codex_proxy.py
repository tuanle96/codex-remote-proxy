#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import json
import shutil
import sys
import tomllib
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROXY_CONFIG_PATH = REPO_ROOT / "proxy-config.toml"
DEFAULT_CODEX_CONFIG_PATH = Path.home() / ".codex" / "config.toml"
DEFAULT_AUTH_PATH = Path.home() / ".codex" / "auth.json"

OPENAI_SECTION_HEADER = "[model_providers.OpenAI]"


def _load_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    return data if isinstance(data, dict) else {}


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _mask_secret(value: str) -> str:
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return value
    return f"{value[:4]}...{value[-4:]}"


def _render_toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _prompt_text(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    if value:
        return value
    if default is not None:
        return default
    raise SystemExit(f"{label} is required")


def _prompt_secret(label: str, default: str | None = None) -> str:
    if default:
        value = getpass.getpass(f"{label} [press Enter to keep current value]: ").strip()
        return value or default
    value = getpass.getpass(f"{label}: ").strip()
    if value:
        return value
    raise SystemExit(f"{label} is required")


def _find_section_range(lines: list[str], section_header: str) -> tuple[int, int] | None:
    for start_index, line in enumerate(lines):
        if line.strip() != section_header:
            continue
        end_index = len(lines)
        for next_index in range(start_index + 1, len(lines)):
            stripped = lines[next_index].strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                end_index = next_index
                break
        return start_index, end_index
    return None


def _first_section_index(lines: list[str]) -> int:
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            return index
    return len(lines)


def _upsert_key(lines: list[str], start_index: int, end_index: int, key: str, value: object) -> list[str]:
    rendered = "true" if value is True else "false" if value is False else _render_toml_string(str(value))

    for index in range(start_index, end_index):
        stripped = lines[index].strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        current_key = stripped.split("=", 1)[0].strip()
        if current_key == key:
            lines[index] = f"{key} = {rendered}"
            return lines

    lines.insert(end_index, f"{key} = {rendered}")
    return lines


def _patch_codex_config_text(text: str, proxy_url: str) -> str:
    lines = text.splitlines()
    if not lines:
        lines = []

    top_end = _first_section_index(lines)
    lines = _upsert_key(lines, 0, top_end, "model_provider", "OpenAI")

    section_range = _find_section_range(lines, OPENAI_SECTION_HEADER)
    if section_range is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(
            [
                OPENAI_SECTION_HEADER,
                'name = "OpenAI"',
                f"base_url = {_render_toml_string(proxy_url)}",
                'wire_api = "responses"',
                "requires_openai_auth = true",
            ]
        )
        return "\n".join(lines) + "\n"

    section_start, section_end = section_range
    lines = _upsert_key(lines, section_start + 1, section_end, "name", "OpenAI")
    section_end = _find_section_range(lines, OPENAI_SECTION_HEADER)[1]
    lines = _upsert_key(lines, section_start + 1, section_end, "base_url", proxy_url)
    section_end = _find_section_range(lines, OPENAI_SECTION_HEADER)[1]
    lines = _upsert_key(lines, section_start + 1, section_end, "wire_api", "responses")
    section_end = _find_section_range(lines, OPENAI_SECTION_HEADER)[1]
    lines = _upsert_key(lines, section_start + 1, section_end, "requires_openai_auth", True)
    return "\n".join(lines) + "\n"


def _write_proxy_config(
    path: Path,
    *,
    listen_host: str,
    listen_port: int,
    upstream_base_url: str,
    upstream_api_key: str,
    auth_header: str,
    auth_scheme: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join(
        [
            "[server]",
            f"host = {_render_toml_string(listen_host)}",
            f"port = {listen_port}",
            'log_level = "INFO"',
            "",
            "[upstream]",
            f"base_url = {_render_toml_string(upstream_base_url.rstrip('/'))}",
            f"api_key = {_render_toml_string(upstream_api_key)}",
            "timeout_seconds = 300.0",
            "verify_ssl = true",
            f"auth_header = {_render_toml_string(auth_header)}",
            f"auth_scheme = {_render_toml_string(auth_scheme)}",
            "",
            "[proxy]",
            "override_authorization = true",
            'request_id_header = "x-client-request-id"',
            "",
        ]
    )
    path.write_text(content, encoding="utf-8")


def _backup_file(path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = path.with_name(f"{path.name}.{timestamp}.bak")
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_path)
    return backup_path


def _existing_upstream_base_url(codex_config: dict, proxy_url: str) -> str:
    provider = codex_config.get("model_providers", {}).get("OpenAI", {})
    if not isinstance(provider, dict):
        return ""
    base_url = str(provider.get("base_url", "")).strip()
    if base_url and base_url != proxy_url:
        return base_url
    return ""


def _existing_openai_api_key(auth_data: dict) -> str:
    value = auth_data.get("OPENAI_API_KEY", "")
    return value.strip() if isinstance(value, str) else ""


def _auth_mode(auth_data: dict) -> str:
    value = auth_data.get("auth_mode", "")
    return value if isinstance(value, str) and value else "(unknown)"


def _token_summary(auth_data: dict) -> str:
    tokens = auth_data.get("tokens", {})
    if not isinstance(tokens, dict):
        return "(missing)"
    value = tokens.get("access_token", "")
    if not isinstance(value, str) or not value:
        return "(missing)"
    prefix = value[:2]
    return f"{prefix}..., len={len(value)}"


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--codex-config",
        type=Path,
        default=DEFAULT_CODEX_CONFIG_PATH,
        help="Path to ~/.codex/config.toml",
    )
    parser.add_argument(
        "--auth",
        type=Path,
        default=DEFAULT_AUTH_PATH,
        help="Path to ~/.codex/auth.json",
    )
    parser.add_argument(
        "--proxy-config",
        type=Path,
        default=DEFAULT_PROXY_CONFIG_PATH,
        help="Where to write proxy-config.toml",
    )


def cmd_check(args: argparse.Namespace) -> int:
    codex_config_path = args.codex_config.expanduser()
    auth_path = args.auth.expanduser()
    proxy_config_path = args.proxy_config.expanduser()

    codex_config = _load_toml(codex_config_path)
    auth_data = _load_json(auth_path)
    proxy_config = _load_toml(proxy_config_path)

    provider = codex_config.get("model_providers", {}).get("OpenAI", {})
    if not isinstance(provider, dict):
        provider = {}
    server = proxy_config.get("server", {}) if isinstance(proxy_config.get("server", {}), dict) else {}
    upstream = proxy_config.get("upstream", {}) if isinstance(proxy_config.get("upstream", {}), dict) else {}
    proxy = proxy_config.get("proxy", {}) if isinstance(proxy_config.get("proxy", {}), dict) else {}

    print(f"Codex config path: {codex_config_path}")
    print(f"Codex auth path:   {auth_path}")
    print(f"Proxy config path: {proxy_config_path}")
    print("")
    print(f"auth_mode: {_auth_mode(auth_data)}")
    print(f"OPENAI_API_KEY: {_mask_secret(_existing_openai_api_key(auth_data))}")
    print(f"tokens.access_token: {_token_summary(auth_data)}")
    print("")
    print("Codex [model_providers.OpenAI]:")
    print(f"  base_url: {provider.get('base_url', '(missing)')}")
    print(f"  wire_api: {provider.get('wire_api', '(missing)')}")
    print(f"  requires_openai_auth: {provider.get('requires_openai_auth', '(missing)')}")
    print("")
    if proxy_config:
        print("Proxy config:")
        print(f"  server.host: {server.get('host', '(missing)')}")
        print(f"  server.port: {server.get('port', '(missing)')}")
        print(f"  upstream.base_url: {upstream.get('base_url', '(missing)')}")
        print(f"  upstream.api_key: {_mask_secret(str(upstream.get('api_key', '')))}")
        print(f"  proxy.override_authorization: {proxy.get('override_authorization', '(missing)')}")
    else:
        print("Proxy config: (missing)")
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    codex_config_path = args.codex_config.expanduser()
    auth_path = args.auth.expanduser()
    proxy_config_path = args.proxy_config.expanduser()

    if not codex_config_path.exists():
        raise SystemExit(f"Codex config not found: {codex_config_path}")

    codex_config = _load_toml(codex_config_path)
    auth_data = _load_json(auth_path)
    proxy_url = f"http://{args.listen_host}:{args.listen_port}"

    suggested_upstream_base_url = (
        args.upstream_base_url
        or _existing_upstream_base_url(codex_config, proxy_url)
        or "https://your-openai-compatible-service.example.com"
    )
    suggested_api_key = args.api_key or _existing_openai_api_key(auth_data)

    upstream_base_url = args.upstream_base_url or _prompt_text(
        "Upstream base URL",
        suggested_upstream_base_url,
    )
    upstream_api_key = args.api_key or _prompt_secret(
        "Upstream API key",
        suggested_api_key if suggested_api_key else None,
    )

    if not upstream_base_url.startswith(("http://", "https://")):
        raise SystemExit("Upstream base URL must start with http:// or https://")

    if not upstream_api_key:
        raise SystemExit("Upstream API key is required")

    proxy_backup = _backup_file(proxy_config_path) if proxy_config_path.exists() else None
    _write_proxy_config(
        proxy_config_path,
        listen_host=args.listen_host,
        listen_port=args.listen_port,
        upstream_base_url=upstream_base_url,
        upstream_api_key=upstream_api_key,
        auth_header=args.auth_header,
        auth_scheme=args.auth_scheme,
    )

    codex_backup = _backup_file(codex_config_path)
    updated_text = _patch_codex_config_text(
        codex_config_path.read_text(encoding="utf-8"),
        proxy_url,
    )
    codex_config_path.write_text(updated_text, encoding="utf-8")

    print("Install complete.")
    print(f"  Proxy config: {proxy_config_path}")
    if proxy_backup:
        print(f"  Proxy config backup: {proxy_backup}")
    print(f"  Codex config backup: {codex_backup}")
    print(f"  Codex OpenAI base_url -> {proxy_url}")
    print(f"  Upstream base_url -> {upstream_base_url.rstrip('/')}")
    print("")
    print("Next steps:")
    print("  1. Start the proxy with: python3 main.py")
    print(f"  2. Verify health with: curl {proxy_url}/_proxy/health")
    print("  3. Keep Codex logged into ChatGPT if you need the remote-control feature")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Configure this repository as a local Codex OpenAI proxy.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check", help="Inspect current Codex and proxy setup")
    _add_common_args(check_parser)
    check_parser.set_defaults(func=cmd_check)

    install_parser = subparsers.add_parser("install", help="Generate proxy-config.toml and patch Codex config")
    _add_common_args(install_parser)
    install_parser.add_argument("--listen-host", default="127.0.0.1", help="Local proxy listen host")
    install_parser.add_argument("--listen-port", type=int, default=15100, help="Local proxy listen port")
    install_parser.add_argument("--upstream-base-url", help="Real upstream base URL")
    install_parser.add_argument("--api-key", help="Real upstream API key")
    install_parser.add_argument("--auth-header", default="authorization", help="Header name for upstream auth")
    install_parser.add_argument("--auth-scheme", default="Bearer", help="Prefix before the upstream API key")
    install_parser.set_defaults(func=cmd_install)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
