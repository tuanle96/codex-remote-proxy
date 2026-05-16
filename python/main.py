from __future__ import annotations

import gzip
import io
import logging
import os
import tomllib
import zlib
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter

import brotli
import httpx
import zstandard as zstd
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

CONFIG_ENV_VAR = "CODEX_PROXY_CONFIG"
DEFAULT_CONFIG_PATH = Path(__file__).with_name("proxy-config.toml")
DEFAULT_HEALTH_PATH = "/_proxy/health"

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

STRIP_HEADERS = HOP_BY_HOP_HEADERS | {"content-encoding", "content-length"}

logger = logging.getLogger("codex_proxy")


def _decompress_body(body: bytes, encoding: str) -> bytes:
    encoding = encoding.lower()
    if encoding == "gzip":
        return gzip.decompress(body)
    if encoding == "deflate":
        return zlib.decompress(body)
    if encoding == "br":
        return brotli.decompress(body)
    if encoding == "zstd":
        reader = zstd.ZstdDecompressor().stream_reader(io.BytesIO(body))
        return reader.read()
    return body


def _auto_decompress(body: bytes) -> bytes | None:
    if len(body) < 2:
        return None
    if body[0] == 0x1F and body[1] == 0x8B:
        try:
            return gzip.decompress(body)
        except Exception:
            return None
    if body[0] == 0x78 and body[1] in (0x01, 0x5E, 0x9C, 0xDA):
        try:
            return zlib.decompress(body)
        except Exception:
            return None
    if len(body) >= 4 and body[0] == 0x28 and body[1] == 0xB5 and body[2] == 0x2F and body[3] == 0xFD:
        try:
            reader = zstd.ZstdDecompressor().stream_reader(io.BytesIO(body))
            return reader.read()
        except Exception:
            return None
    try:
        return brotli.decompress(body)
    except Exception:
        return None


@dataclass(slots=True)
class ServerSettings:
    host: str = "127.0.0.1"
    port: int = 15100
    log_level: str = "INFO"


@dataclass(slots=True)
class UpstreamSettings:
    base_url: str
    api_key: str = ""
    timeout_seconds: float = 300.0
    verify_ssl: bool = True
    auth_header: str = "authorization"
    auth_scheme: str = "Bearer"
    extra_headers: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class ProxySettings:
    override_authorization: bool = True
    request_id_header: str = "x-client-request-id"


@dataclass(slots=True)
class AppSettings:
    config_path: Path
    server: ServerSettings
    upstream: UpstreamSettings
    proxy: ProxySettings


def _resolve_config_path() -> Path:
    raw_path = os.environ.get(CONFIG_ENV_VAR)
    return Path(raw_path).expanduser() if raw_path else DEFAULT_CONFIG_PATH


def _configure_logging(level_name: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level_name.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )


def _load_toml(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError(
            f"Proxy config not found: {path}. "
            f"Create it from {path.with_name('proxy-config.example.toml').name} "
            f"or run scripts/configure_codex_proxy.py install first."
        )
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError(f"Proxy config is not a TOML table: {path}")
    return data


def _as_table(data: dict, key: str) -> dict:
    value = data.get(key, {})
    if not isinstance(value, dict):
        raise RuntimeError(f"[{key}] must be a TOML table")
    return value


def _as_string(value: object, *, field_name: str, default: str = "", required: bool = False) -> str:
    if value is None:
        value = default
    if not isinstance(value, str):
        raise RuntimeError(f"{field_name} must be a string")
    result = value.strip()
    if required and not result:
        raise RuntimeError(f"{field_name} is required")
    return result


def _as_bool(value: object, *, field_name: str, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise RuntimeError(f"{field_name} must be a boolean")
    return value


def _as_int(value: object, *, field_name: str, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"{field_name} must be an integer")
    return value


def _as_float(value: object, *, field_name: str, default: float) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{field_name} must be a number")
    return float(value)


def _as_string_dict(value: object, *, field_name: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise RuntimeError(f"{field_name} must be a TOML table")
    result: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise RuntimeError(f"{field_name} values must all be strings")
        result[key] = item
    return result


def load_settings(config_path: Path | None = None) -> AppSettings:
    path = (config_path or _resolve_config_path()).expanduser().resolve()
    data = _load_toml(path)

    server_data = _as_table(data, "server")
    upstream_data = _as_table(data, "upstream")
    proxy_data = _as_table(data, "proxy")

    server = ServerSettings(
        host=_as_string(server_data.get("host"), field_name="server.host", default="127.0.0.1"),
        port=_as_int(server_data.get("port"), field_name="server.port", default=15100),
        log_level=_as_string(server_data.get("log_level"), field_name="server.log_level", default="INFO"),
    )

    upstream = UpstreamSettings(
        base_url=_as_string(upstream_data.get("base_url"), field_name="upstream.base_url", required=True).rstrip("/"),
        api_key=_as_string(upstream_data.get("api_key"), field_name="upstream.api_key", default=""),
        timeout_seconds=_as_float(
            upstream_data.get("timeout_seconds"),
            field_name="upstream.timeout_seconds",
            default=300.0,
        ),
        verify_ssl=_as_bool(upstream_data.get("verify_ssl"), field_name="upstream.verify_ssl", default=True),
        auth_header=_as_string(
            upstream_data.get("auth_header"),
            field_name="upstream.auth_header",
            default="authorization",
        ),
        auth_scheme=_as_string(
            upstream_data.get("auth_scheme"),
            field_name="upstream.auth_scheme",
            default="Bearer",
        ),
        extra_headers=_as_string_dict(upstream_data.get("extra_headers"), field_name="upstream.extra_headers"),
    )

    proxy = ProxySettings(
        override_authorization=_as_bool(
            proxy_data.get("override_authorization"),
            field_name="proxy.override_authorization",
            default=True,
        ),
        request_id_header=_as_string(
            proxy_data.get("request_id_header"),
            field_name="proxy.request_id_header",
            default="x-client-request-id",
        ),
    )

    if proxy.override_authorization and not upstream.api_key:
        raise RuntimeError(
            "upstream.api_key is required when proxy.override_authorization is true"
        )

    return AppSettings(config_path=path, server=server, upstream=upstream, proxy=proxy)


def _build_target_url(base_url: str, path: str, query: str) -> str:
    target = f"{base_url}/{path}" if path else f"{base_url}/"
    return f"{target}?{query}" if query else target


def _format_auth_value(upstream: UpstreamSettings) -> str:
    scheme = upstream.auth_scheme.strip()
    if not scheme:
        return upstream.api_key
    return f"{scheme} {upstream.api_key}"


def _append_or_replace_header(
    headers: list[tuple[str, str]],
    key: str,
    value: str,
) -> list[tuple[str, str]]:
    lowered_key = key.lower()
    return [item for item in headers if item[0].lower() != lowered_key] + [(key, value)]


def _build_upstream_headers(request: Request, settings: AppSettings) -> list[tuple[str, str]]:
    return _build_upstream_headers_with_content_mode(
        request=request,
        settings=settings,
        strip_content_headers=True,
    )


def _build_upstream_headers_with_content_mode(
    *,
    request: Request,
    settings: AppSettings,
    strip_content_headers: bool,
) -> list[tuple[str, str]]:
    headers: list[tuple[str, str]] = []
    auth_header = settings.upstream.auth_header.lower()

    for raw_key, raw_value in request.scope.get("headers", []):
        key = raw_key.decode("latin-1")
        value = raw_value.decode("latin-1")
        lowered_key = key.lower()
        if lowered_key == "host" or lowered_key in HOP_BY_HOP_HEADERS:
            continue
        if strip_content_headers and lowered_key in {"content-encoding", "content-length"}:
            continue
        if settings.proxy.override_authorization and lowered_key == auth_header:
            continue
        headers.append((key, value))

    if settings.proxy.override_authorization:
        headers = _append_or_replace_header(
            headers,
            settings.upstream.auth_header,
            _format_auth_value(settings.upstream),
        )

    for key, value in settings.upstream.extra_headers.items():
        headers = _append_or_replace_header(headers, key, value)

    return headers


def _build_downstream_raw_headers(response: httpx.Response) -> list[tuple[bytes, bytes]]:
    raw_headers: list[tuple[bytes, bytes]] = []
    for key, value in response.headers.multi_items():
        if key.lower() in HOP_BY_HOP_HEADERS:
            continue
        raw_headers.append((key.encode("latin-1"), value.encode("latin-1")))
    return raw_headers


def _is_event_stream(content_type: str) -> bool:
    return content_type.split(";", 1)[0].strip().lower() == "text/event-stream"


def _masked_value(value: str) -> str:
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return value
    return f"{value[:4]}...{value[-4:]}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    _configure_logging(settings.server.log_level)

    timeout = httpx.Timeout(settings.upstream.timeout_seconds)
    client = httpx.AsyncClient(
        timeout=timeout,
        verify=settings.upstream.verify_ssl,
        follow_redirects=False,
    )

    app.state.settings = settings
    app.state.http_client = client

    logger.info(
        "Loaded proxy config from %s, upstream=%s, auth_override=%s, auth_header=%s, api_key=%s",
        settings.config_path,
        settings.upstream.base_url,
        settings.proxy.override_authorization,
        settings.upstream.auth_header,
        _masked_value(settings.upstream.api_key),
    )

    try:
        yield
    finally:
        await client.aclose()


app = FastAPI(title="Codex Remote Proxy", lifespan=lifespan)


@app.get(DEFAULT_HEALTH_PATH)
async def health(request: Request):
    settings: AppSettings = request.app.state.settings
    return {
        "ok": True,
        "config_path": str(settings.config_path),
        "listen_host": settings.server.host,
        "listen_port": settings.server.port,
        "upstream_base_url": settings.upstream.base_url,
        "override_authorization": settings.proxy.override_authorization,
        "auth_header": settings.upstream.auth_header,
        "auth_scheme": settings.upstream.auth_scheme,
        "extra_header_count": len(settings.upstream.extra_headers),
    }


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def proxy(request: Request, path: str):
    settings: AppSettings = request.app.state.settings
    client: httpx.AsyncClient = request.app.state.http_client

    request_id = (
        request.headers.get(settings.proxy.request_id_header)
        or request.headers.get("x-request-id")
        or "-"
    )
    target_url = _build_target_url(settings.upstream.base_url, path, request.url.query)
    started_at = perf_counter()

    body = await request.body()
    req_encoding = request.headers.get("content-encoding", "")
    body_transformed = False
    if req_encoding and body:
        try:
            body = _decompress_body(body, req_encoding)
            body_transformed = True
        except Exception as exc:
            logger.warning("Failed to decompress (%s): %s", req_encoding, exc)
    elif body and len(body) >= 2 and not req_encoding:
        decompressed = _auto_decompress(body)
        if decompressed is not None:
            logger.debug(
                "Auto-decompressed body: %d -> %d bytes (magic: 0x%02x 0x%02x)",
                len(body), len(decompressed), body[0], body[1],
            )
            body = decompressed
            body_transformed = True

    request_headers = _build_upstream_headers_with_content_mode(
        request=request,
        settings=settings,
        strip_content_headers=body_transformed,
    )

    try:
        upstream_request = client.build_request(
            method=request.method,
            url=target_url,
            headers=request_headers,
            content=body,
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.TimeoutException as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        logger.warning(
            "Proxy timeout request_id=%s method=%s path=%s target=%s duration_ms=%s error=%s",
            request_id,
            request.method,
            request.url.path,
            target_url,
            duration_ms,
            exc,
        )
        return JSONResponse(
            status_code=504,
            content={
                "error": {
                    "message": "Upstream request timed out",
                    "type": "proxy_timeout",
                    "request_id": request_id,
                }
            },
        )
    except httpx.HTTPError as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        logger.warning(
            "Proxy upstream error request_id=%s method=%s path=%s target=%s duration_ms=%s error=%s",
            request_id,
            request.method,
            request.url.path,
            target_url,
            duration_ms,
            exc,
        )
        return JSONResponse(
            status_code=502,
            content={
                "error": {
                    "message": "Failed to reach upstream service",
                    "type": "proxy_upstream_error",
                    "request_id": request_id,
                }
            },
        )

    raw_headers = _build_downstream_raw_headers(upstream_response)
    content_type = upstream_response.headers.get("content-type", "")
    is_stream = _is_event_stream(content_type)

    async def iter_upstream_bytes():
        try:
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        finally:
            duration_ms = int((perf_counter() - started_at) * 1000)
            logger.info(
                "Proxied request_id=%s method=%s path=%s status=%s stream=%s duration_ms=%s",
                request_id,
                request.method,
                request.url.path,
                upstream_response.status_code,
                is_stream,
                duration_ms,
            )
            await upstream_response.aclose()

    downstream_response = StreamingResponse(
        iter_upstream_bytes(),
        status_code=upstream_response.status_code,
    )
    downstream_response.raw_headers = raw_headers
    return downstream_response


if __name__ == "__main__":
    import uvicorn

    runtime_settings = load_settings()
    _configure_logging(runtime_settings.server.log_level)
    uvicorn.run(
        app,
        host=runtime_settings.server.host,
        port=runtime_settings.server.port,
        log_level=runtime_settings.server.log_level.lower(),
    )
