#!/usr/bin/env bash
# cc-mob: PermissionRequest hook
# Forwards permission prompts to the mobile UI for approve/deny

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load token
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val; do
    key=$(echo "$key" | xargs)
    [[ -z "$key" || "$key" == \#* ]] && continue
    export "$key=$val"
  done < "$ENV_FILE"
fi

TOKEN="${AUTH_TOKEN:-}"
PORT="${PORT:-3456}"
BASE_URL="http://127.0.0.1:$PORT"
REQUEST_ID=""
TMPFILE=""

# Cleanup: cancel pending request and remove temp file
cleanup() {
  if [ -n "$REQUEST_ID" ]; then
    local id="$REQUEST_ID"
    REQUEST_ID=""  # Clear to avoid double-cancel
    curl -s -X POST "$BASE_URL/api/request/$id/respond?token=$TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"decision":{"decision":"deny","reason":"Answered in terminal"}}' >/dev/null 2>&1 &
  fi
  [ -n "$TMPFILE" ] && rm -f "$TMPFILE"
}
trap cleanup EXIT SIGTERM SIGINT SIGHUP

# Always output a valid hook response, even on error
deny_response() {
  local msg="${1:-Error in permission handler}"
  # Escape message through node to prevent JSON injection and shell expansion
  local escaped_msg
  escaped_msg=$(node -e "process.stdout.write(JSON.stringify(String(process.argv[1])))" "$msg" 2>/dev/null) || escaped_msg='"Error in permission handler"'
  cat <<HOOKEOF
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": ${escaped_msg}
    }
  }
}
HOOKEOF
  exit 0
}

# Quick check: is the server running? If not, exit silently so Claude Code
# falls through to its normal permission prompt.
curl -s -f --connect-timeout 2 "$BASE_URL/api/health?token=$TOKEN" >/dev/null 2>&1 || exit 0

# Read JSON payload from stdin into a temp file to avoid shell expansion issues
TMPFILE=$(mktemp)
cat > "$TMPFILE"

# Skip AskUserQuestion - it's handled by the question-interceptor via PreToolUse
TOOL_NAME=$(node -e "
  const fs = require('fs');
  try {
    const d = JSON.parse(fs.readFileSync('$TMPFILE', 'utf8'));
    console.log(d.tool_name || '');
  } catch(e) {}
" 2>/dev/null)

if [ "$TOOL_NAME" = "AskUserQuestion" ]; then
  rm -f "$TMPFILE"
  exit 0  # Let question-interceptor handle it
fi

# Build the request body safely using node (avoids shell expansion issues)
REQUEST_BODY=$(node -e "
  const fs = require('fs');
  const payload = fs.readFileSync('$TMPFILE', 'utf8').trim();
  try { JSON.parse(payload); } catch(e) { process.exit(1); }
  console.log(JSON.stringify({ type: 'permission', payload: JSON.parse(payload) }));
" 2>/dev/null) || exit 0

# POST the permission request to the server
RESPONSE=$(curl -s -f -X POST "$BASE_URL/api/request?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY" 2>/dev/null) || exit 0

# Extract request ID using node for reliable JSON parsing
REQUEST_ID=$(node -e "
  try {
    const d = JSON.parse(process.argv[1]);
    if (d.id) { console.log(d.id); } else { process.exit(1); }
  } catch(e) { process.exit(1); }
" "$RESPONSE" 2>/dev/null)
if [ -z "$REQUEST_ID" ]; then
  deny_response "Failed to get request ID from server"
fi
export REQUEST_ID

# Long-poll for the user's decision (60s timeout)
# If timeout, exit silently so Claude Code falls through to terminal prompt
RESULT=$(curl -s -f --max-time 60 "$BASE_URL/api/request/$REQUEST_ID/wait?token=$TOKEN" 2>/dev/null)
if [ -z "$RESULT" ]; then
  # Timeout or error - exit silently, cleanup will cancel the request
  exit 0
fi

# Extract decision using node for reliable JSON parsing
DECISION=$(node -e "
  try {
    const d = JSON.parse(process.argv[1]);
    const dec = d.response && d.response.decision;
    if (dec) { console.log(dec); } else { process.exit(1); }
  } catch(e) { process.exit(1); }
" "$RESULT" 2>/dev/null) || deny_response "Failed to parse response"

# Clear REQUEST_ID since request was resolved via mobile (prevent cleanup from double-resolving)
REQUEST_ID=""

if [ "$DECISION" = "allow" ]; then
  cat <<'HOOKEOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
HOOKEOF
else
  cat <<'HOOKEOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Denied from phone"
    }
  }
}
HOOKEOF
fi
