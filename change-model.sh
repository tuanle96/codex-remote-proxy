#!/bin/bash

# Change Model Script
# Usage: ./change-model.sh <model-name>

if [ -z "$1" ]; then
  echo "Usage: $0 <model-name>"
  echo ""
  echo "Examples:"
  echo "  $0 claude-opus-4-7"
  echo "  $0 claude-sonnet-4"
  echo "  $0 gpt-4o"
  exit 1
fi

MODEL="$1"
USER_CONFIG="$HOME/.codex-remote-proxy/config.json"
RUNTIME_CONFIG="$HOME/.codex-remote-proxy/node/proxy-config.json"

echo "Changing model to: $MODEL"
echo ""

# Update user config
if [ -f "$USER_CONFIG" ]; then
  echo "Updating user config..."
  jq --arg model "$MODEL" '.modelOverride = $model' "$USER_CONFIG" > "$USER_CONFIG.tmp" && mv "$USER_CONFIG.tmp" "$USER_CONFIG"
  echo "✓ Updated: $USER_CONFIG"
else
  echo "⚠ User config not found: $USER_CONFIG"
fi

# Update runtime config
if [ -f "$RUNTIME_CONFIG" ]; then
  echo "Updating runtime config..."
  jq --arg model "$MODEL" '.upstream.modelOverride = $model' "$RUNTIME_CONFIG" > "$RUNTIME_CONFIG.tmp" && mv "$RUNTIME_CONFIG.tmp" "$RUNTIME_CONFIG"
  echo "✓ Updated: $RUNTIME_CONFIG"
else
  echo "⚠ Runtime config not found: $RUNTIME_CONFIG"
fi

echo ""
echo "Restarting service..."
cd /Users/justin/Dev/VibeLab/codex-remote-proxy
./manage-service.sh restart > /dev/null 2>&1

sleep 2

echo ""
echo "Verifying..."
CURRENT_MODEL=$(curl -s http://127.0.0.1:56210/_proxy/health | jq -r '.modelOverride // "null"')

if [ "$CURRENT_MODEL" = "$MODEL" ]; then
  echo "✓ Model changed successfully to: $CURRENT_MODEL"
else
  echo "✗ Failed to change model. Current: $CURRENT_MODEL, Expected: $MODEL"
  exit 1
fi
