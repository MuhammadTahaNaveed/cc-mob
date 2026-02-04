#!/usr/bin/env bash
# cc-mob: Notification hook
# Forwards notifications to the mobile UI (async, non-blocking)

# Use centralized config at ~/.cc-mob/ so server and plugin share the same token
ENV_FILE="$HOME/.cc-mob/.env"

# Load token
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs -d '\n' 2>/dev/null || grep -v '^#' "$ENV_FILE" | xargs)
fi

TOKEN="${AUTH_TOKEN:-}"
PORT="${PORT:-3456}"
BASE_URL="http://127.0.0.1:$PORT"

# Read notification from stdin
PAYLOAD=$(cat)

# Build safe JSON body through node to prevent injection
BODY=$(node -e "
  const payload = process.argv[1];
  let msg;
  try { msg = JSON.parse(payload); } catch(e) { msg = payload; }
  process.stdout.write(JSON.stringify({ message: msg }));
" "$PAYLOAD" 2>/dev/null) || BODY='{"message":"notification"}'

# Post notification (fire and forget, don't fail the hook)
curl -s -X POST "$BASE_URL/api/notify?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" >/dev/null 2>&1 || true

exit 0
