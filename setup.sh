#!/usr/bin/env bash
# cc-mob setup script
# Installs dependencies, configures hooks, and sets up MCP server
#
# NOTE: For plugin installs (claude plugin install), hooks and MCP are
# auto-configured. This script is for standalone use only.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo ""
echo "  cc-mob setup"
echo "  ================"
echo ""

# Step 1: Install npm dependencies
echo "  [1/5] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production 2>&1 | tail -1
echo "  Done."

# Step 2: Make hook scripts executable
echo "  [2/5] Setting hook permissions..."
chmod +x hooks/*.sh
echo "  Done."

# Step 3: Generate auth token if needed
echo "  [3/5] Configuring auth token..."
if [ -f "$SCRIPT_DIR/.env" ] && grep -q "AUTH_TOKEN=" "$SCRIPT_DIR/.env"; then
  echo "  Token already exists in .env"
else
  TOKEN=$(openssl rand -hex 24)
  echo "AUTH_TOKEN=$TOKEN" >> "$SCRIPT_DIR/.env"
  echo "  Generated new auth token."
fi

# Step 4: Configure Claude settings
echo "  [4/5] Configuring Claude Code settings..."

# Backup existing settings
if [ -f "$SETTINGS_FILE" ]; then
  cp "$SETTINGS_FILE" "${SETTINGS_FILE}.backup.$(date +%s)"
  echo "  Backed up existing settings."
fi

# Create settings dir if needed
mkdir -p "$(dirname "$SETTINGS_FILE")"

# Build the hooks and MCP config using node for reliable JSON manipulation
node -e "
const fs = require('fs');
const path = require('path');

const settingsFile = '$SETTINGS_FILE';
const projectDir = '$SCRIPT_DIR';

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch (e) {}

// Ensure hooks object exists
if (!settings.hooks || Array.isArray(settings.hooks)) settings.hooks = {};

// Set up PermissionRequest hook
settings.hooks.PermissionRequest = [
  {
    hooks: [
      {
        type: 'command',
        command: path.join(projectDir, 'hooks', 'permission-handler.sh'),
        timeout: 310,
      },
    ],
  },
];

// Set up PreToolUse hook for AskUserQuestion (blocks and waits for phone answer)
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(g =>
  !(g.hooks && g.hooks.some(h => h.command && h.command.includes('cc-mob')))
);
settings.hooks.PreToolUse.push({
  matcher: 'AskUserQuestion',
  hooks: [
    {
      type: 'command',
      command: path.join(projectDir, 'hooks', 'question-interceptor.sh'),
      timeout: 310,  // 5 min wait + buffer since hook blocks for phone answer
    },
  ],
});

// Remove any old PostToolUse hooks for cc-mob (no longer needed)
if (settings.hooks.PostToolUse) {
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(g =>
    !(g.hooks && g.hooks.some(h => h.command && h.command.includes('cc-mob')))
  );
  if (settings.hooks.PostToolUse.length === 0) {
    delete settings.hooks.PostToolUse;
  }
}

// Set up Notification hook
settings.hooks.Notification = [
  {
    hooks: [
      {
        type: 'command',
        command: path.join(projectDir, 'hooks', 'notification-handler.sh'),
        timeout: 5,
        async: true,
      },
    ],
  },
];

if (settings.mcpServers) {
  delete settings.mcpServers['cc-mob'];
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log('  Settings updated: ' + settingsFile);
"

# Step 5: Register MCP server with Claude Code
echo "  [5/5] Registering MCP server..."
claude mcp remove cc-mob 2>/dev/null || true
claude mcp add --scope user cc-mob -- node "$SCRIPT_DIR/mcp-server.js" 2>&1 | grep -v "^$" || true
echo "  Done."

echo ""
echo "  Setup complete!"
echo ""
echo "  To start:"
echo "    node server.js"
echo ""
echo "  Then open the URL on your phone."
echo "  Claude Code will route permissions and questions to your phone."
echo ""
