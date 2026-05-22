# Codex Remote Proxy - Hướng dẫn sử dụng

## Đã cài đặt thành công!

### Thông tin cấu hình

- **Service**: `dev.tuanle.codex-remote-proxy`
- **Proxy URL**: `http://127.0.0.1:56210`
- **Upstream**: `https://llm.tuanle.dev/v1`
- **Model**: `claude-opus-4` (có thể thay đổi)

### Quản lý service

```bash
cd /Users/justin/Dev/VibeLab/codex-remote-proxy

# Xem status
./manage-service.sh status

# Restart
./manage-service.sh restart

# Stop
./manage-service.sh stop

# Start
./manage-service.sh start

# Health check
./manage-service.sh health

# Xem logs
./manage-service.sh logs
```

### Thay đổi model

**Cách nhanh nhất: Dùng script helper**

```bash
cd /Users/justin/Dev/VibeLab/codex-remote-proxy

# Thay đổi model
./change-model.sh claude-opus-4-7
./change-model.sh claude-sonnet-4
./change-model.sh gpt-4o
```

Script này sẽ tự động:
- Cập nhật cả 2 file config (user + runtime)
- Restart service
- Verify model đã đổi thành công

**Cách 1: Sửa trực tiếp config file**

```bash
# Edit config
nano ~/.codex-remote-proxy/config.json

# Thay đổi dòng:
"modelOverride": "claude-opus-4"

# Thành model bạn muốn, ví dụ:
"modelOverride": "gpt-4o"

# Restart service
./manage-service.sh restart
```

**Cách 2: Sửa runtime config**

```bash
# Edit runtime config
nano ~/.codex-remote-proxy/node/proxy-config.json

# Tìm và sửa:
"modelOverride": "claude-opus-4"

# Restart service
./manage-service.sh restart
```

**Lưu ý:** Config sẽ được giữ nguyên sau khi restart, không bị ghi đè nữa!

### Các model có thể dùng

- `claude-opus-4` - Claude Opus 4 (đang dùng)
- `claude-sonnet-4` - Claude Sonnet 4
- `claude-haiku-4` - Claude Haiku 4
- `gpt-4o` - GPT-4 Optimized
- `gpt-4-turbo` - GPT-4 Turbo
- `gpt-3.5-turbo` - GPT-3.5 Turbo
- Hoặc bất kỳ model nào upstream API hỗ trợ

### Kiểm tra config hiện tại

```bash
# Xem model đang dùng
curl -s http://127.0.0.1:56210/_proxy/health | jq .modelOverride

# Xem toàn bộ config
./manage-service.sh health
```

### Sử dụng với Codex

1. Restart Codex Desktop
2. Sign in với ChatGPT account
3. Codex sẽ tự động forward requests qua proxy
4. Tất cả requests sẽ dùng model bạn đã config

### Troubleshooting

**Model không thay đổi sau khi restart:**
```bash
# Kiểm tra config file
cat ~/.codex-remote-proxy/node/proxy-config.json | jq .upstream.modelOverride

# Nếu vẫn sai, sửa trực tiếp và restart
nano ~/.codex-remote-proxy/node/proxy-config.json
./manage-service.sh restart
```

**Service không start:**
```bash
# Xem logs
./manage-service.sh logs

# Hoặc
tail -50 ~/.codex-remote-proxy/service.error.log
```

**Proxy không response:**
```bash
# Check service status
launchctl list | grep codex-remote-proxy

# Restart service
./manage-service.sh restart
```

### Files quan trọng

- Config: `~/.codex-remote-proxy/config.json`
- Runtime config: `~/.codex-remote-proxy/node/proxy-config.json`
- Service plist: `~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist`
- Logs: `~/.codex-remote-proxy/service.log`
- Error logs: `~/.codex-remote-proxy/service.error.log`

### Gỡ cài đặt

```bash
# Stop service
./manage-service.sh stop

# Remove service
launchctl unload ~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist
rm ~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist

# Xóa config (optional)
rm -rf ~/.codex-remote-proxy
```
