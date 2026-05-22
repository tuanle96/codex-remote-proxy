#!/bin/bash

# Codex Remote Proxy Service Manager
# Location: /Users/justin/Dev/VibeLab/codex-remote-proxy/manage-service.sh

SERVICE_NAME="dev.tuanle.codex-remote-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
PROJECT_DIR="/Users/justin/Dev/VibeLab/codex-remote-proxy/node"

case "$1" in
  start)
    echo "Starting Codex Remote Proxy service..."
    launchctl load "$PLIST_PATH"
    sleep 2
    launchctl list | grep "$SERVICE_NAME"
    ;;

  stop)
    echo "Stopping Codex Remote Proxy service..."
    launchctl unload "$PLIST_PATH"
    ;;

  restart)
    echo "Restarting Codex Remote Proxy service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null
    sleep 1
    launchctl load "$PLIST_PATH"
    sleep 2
    launchctl list | grep "$SERVICE_NAME"
    ;;

  status)
    echo "Checking service status..."
    launchctl list | grep "$SERVICE_NAME"
    echo ""
    cd "$PROJECT_DIR" && node bin/crp.mjs status --json | jq .
    ;;

  health)
    echo "Checking proxy health..."
    curl -s http://127.0.0.1:56210/_proxy/health | jq .
    ;;

  logs)
    echo "=== Service Output Log ==="
    tail -50 "$HOME/.codex-remote-proxy/service.log"
    echo ""
    echo "=== Service Error Log ==="
    tail -50 "$HOME/.codex-remote-proxy/service.error.log"
    echo ""
    echo "=== Proxy Log ==="
    tail -50 "$HOME/.codex-remote-proxy/proxy.log"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|health|logs}"
    echo ""
    echo "Commands:"
    echo "  start   - Start the service"
    echo "  stop    - Stop the service"
    echo "  restart - Restart the service"
    echo "  status  - Show service and proxy status"
    echo "  health  - Check proxy health endpoint"
    echo "  logs    - Show recent logs"
    exit 1
    ;;
esac
