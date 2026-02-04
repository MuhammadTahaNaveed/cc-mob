#!/usr/bin/env bash
# cc-mob: PreToolUse hook for AskUserQuestion
# Simple approach: phone OR terminal, not both
# Server ON → Phone only (block terminal, return answer via deny message)
# Server OFF → Terminal only (normal Claude Code flow)

# Support plugin context via CLAUDE_PLUGIN_ROOT, fallback to script-relative
SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="$SCRIPT_DIR/.env"

# Load env
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

# Override: CC_MOB_TERMINAL_ONLY=1 forces terminal mode
[ "$CC_MOB_TERMINAL_ONLY" = "1" ] && exit 0

# Server not running? Use terminal
curl -s -f --connect-timeout 1 "$BASE_URL/api/health" >/dev/null 2>&1 || exit 0

# Read payload from stdin
PAYLOAD=$(cat)

# Extract tool_input
TOOL_INPUT=$(echo "$PAYLOAD" | node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  console.log(JSON.stringify(data.tool_input || {}));
" 2>/dev/null)

# No questions? Allow normal flow
HAS_QUESTIONS=$(echo "$TOOL_INPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log((d.questions && d.questions.length > 0) ? 'yes' : 'no');
" 2>/dev/null)

[ "$HAS_QUESTIONS" != "yes" ] && exit 0

# Send question to server and get request ID
RESPONSE=$(curl -s -f -X POST "$BASE_URL/api/request?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"question\",\"payload\":$TOOL_INPUT}" 2>/dev/null)

REQUEST_ID=$(echo "$RESPONSE" | node -e "
  try { const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.id||''); } catch(e){}
" 2>/dev/null)

# Failed to create request? Fallback to terminal
[ -z "$REQUEST_ID" ] && exit 0

# Wait for phone answer (5 minute timeout)
RESULT=$(curl -s --max-time 300 "$BASE_URL/api/request/$REQUEST_ID/wait?token=$TOKEN" 2>/dev/null)

# Timeout or error? Fallback to terminal
[ -z "$RESULT" ] && exit 0

# Extract answer from response
ANSWER=$(echo "$RESULT" | node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.response && d.response.answer !== undefined) {
      const ans = d.response.answer;
      if (typeof ans === 'object' && ans !== null) {
        // Multi-question format: { 'question text': 'answer' }
        // Return as JSON for Claude to parse
        console.log(JSON.stringify(ans));
      } else {
        console.log(String(ans));
      }
    }
  } catch(e){}
" 2>/dev/null)

# No answer? Fallback to terminal
[ -z "$ANSWER" ] && exit 0

# Escape answer for JSON (handle quotes, newlines, etc.)
ESCAPED_ANSWER=$(echo "$ANSWER" | node -e "
  const fs = require('fs');
  const s = fs.readFileSync('/dev/stdin', 'utf8').trim();
  // Output without surrounding quotes since we embed in JSON string
  console.log(JSON.stringify(s).slice(1, -1));
" 2>/dev/null)

# Return deny with answer embedded in message
# Claude will see the answer in permissionDecisionReason
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "User answered via phone: $ESCAPED_ANSWER"
  }
}
EOF
