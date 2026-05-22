# Codex Remote Proxy - Installation Summary

## Cài đặt thành công!

Proxy đã được cài đặt từ source và chạy ngầm như một LaunchAgent service trên macOS.

### Thông tin cấu hình

- **Service name**: `dev.tuanle.codex-remote-proxy`
- **Proxy URL**: `http://127.0.0.1:56210`
- **Upstream URL**: `https://llm.tuanle.dev/v1`
- **Config file**: `~/.codex-remote-proxy/config.json`
- **Service plist**: `~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist`

### Quản lý service

Sử dụng script tiện ích:

```bash
cd /Users/justin/Dev/VibeLab/codex-remote-proxy
./manage-service.sh {start|stop|restart|status|health|logs}
```

Hoặc dùng launchctl trực tiếp:

```bash
# Start service
launchctl load ~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist

# Check status
launchctl list | grep codex-remote-proxy
```

### Kiểm tra trạng thái

```bash
# Proxy status
cd /Users/justin/Dev/VibeLab/codex-remote-proxy/node
node bin/crp.mjs status --json

# Health check
curl http://127.0.0.1:56210/_proxy/health
```

### Log files

- Service output: `~/.codex-remote-proxy/service.log`
- Service errors: `~/.codex-remote-proxy/service.error.log`
- Proxy logs: `~/.codex-remote-proxy/proxy.log`

### Tính năng

- ✅ Tự động khởi động khi login (RunAtLoad)
- ✅ Tự động restart nếu crash (KeepAlive)
- ✅ Chạy ngầm không cần terminal
- ✅ Log đầy đủ cho debugging

### Sử dụng với Codex

1. Restart Codex Desktop
2. Sign in với ChatGPT account
3. Codex sẽ tự động forward requests qua proxy này đến upstream API của bạn

### Gỡ cài đặt

```bash
# Stop và remove service
launchctl unload ~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist
rm ~/Library/LaunchAgents/dev.tuanle.codex-remote-proxy.plist

# Xóa config (optional)
rm -rf ~/.codex-remote-proxy
```
