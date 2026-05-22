# Model Override Feature

## Tính năng mới: Override Model

Proxy giờ đây hỗ trợ override model name trong tất cả requests gửi đến upstream API.

### Cách sử dụng

#### Option 1: Lưu trong config file

Thêm `modelOverride` vào `~/.codex-remote-proxy/config.json`:

```json
{
  "upstreamBaseUrl": "https://llm.tuanle.dev/v1",
  "apiKey": "sk-your-key",
  "listenHost": "127.0.0.1",
  "listenPort": 56210,
  "captureEnabled": false,
  "modelOverride": "claude-opus-4"
}
```

#### Option 2: CLI flag

```bash
crp start --model-override "claude-opus-4"
```

#### Option 3: Environment variable

```bash
export CRP_MODEL_OVERRIDE="claude-opus-4"
crp start
```

### Ví dụ model names

- `claude-opus-4` - Claude Opus 4
- `claude-sonnet-4` - Claude Sonnet 4
- `gpt-4o` - GPT-4 Optimized
- `gpt-4-turbo` - GPT-4 Turbo
- Hoặc bất kỳ model name nào mà upstream API của bạn hỗ trợ

### Cách hoạt động

Khi `modelOverride` được set:
- Tất cả requests từ Codex sẽ có `model` field được thay thế bằng giá trị `modelOverride`
- Nếu không set, proxy sẽ giữ nguyên model từ Codex (hoặc convert `gpt-5.4` → `gpt-5.5` theo mặc định)

### Kiểm tra config

```bash
curl http://127.0.0.1:56210/_proxy/health | jq .modelOverride
```

### Thay đổi model

1. Sửa file config:
```bash
nano ~/.codex-remote-proxy/config.json
```

2. Restart service:
```bash
cd /Users/justin/Dev/VibeLab/codex-remote-proxy
./manage-service.sh restart
```

3. Verify:
```bash
./manage-service.sh health | jq .modelOverride
```
