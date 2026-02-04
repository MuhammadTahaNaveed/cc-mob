# cc-mob

Control Claude Code from your phone - approve permissions and answer questions remotely.

## Installation

cc-mob has two components:
1. **Server** - runs on your machine, bridges Claude Code to your phone
2. **Plugin** - hooks into Claude Code to intercept permissions/questions

### Step 1: Install the server

```bash
npm install -g cc-mob
```

### Step 2: Install the plugin

```bash
claude plugin marketplace add MuhammadTahaNaveed/cc-mob
claude plugin install cc-mob
```

### Step 3: Start the server

```bash
cc-mob
```

Scan the QR code with your phone to authenticate.

### Step 4: Use Claude Code

```bash
claude
```

Permissions and questions will now appear on your phone.

## Development / Local Testing

If you're developing or testing locally:

```bash
# Clone and install
git clone https://github.com/MuhammadTahaNaveed/cc-mob.git
cd cc-mob
npm install

# Terminal 1: Start server
node server.js

# Terminal 2: Run Claude with plugin
claude --plugin-dir /path/to/cc-mob
```

## How It Works

```
┌─────────────┐     hooks      ┌─────────────┐     http      ┌─────────────┐
│ Claude Code │ ─────────────▶ │  cc-mob     │ ◀──────────▶  │   Phone     │
│             │ ◀───────────── │  server     │   websocket   │   Browser   │
└─────────────┘    response    └─────────────┘               └─────────────┘
```

When loaded as a plugin, cc-mob:
- Registers hooks to intercept permission requests and questions
- Provides an MCP tool (`mcp__cc-mob__ask_user`) for asking questions via phone
- Routes all interactions to your phone when the server is running
- Falls back to terminal prompts if the server is not running

## Features

- **Permission forwarding**: Approve/deny tool permissions from your phone
- **Question answering**: Answer Claude's questions remotely
- **Notifications**: Receive notifications on your phone
- **Secure**: Token-based authentication with HttpOnly cookies
- **Graceful fallback**: Falls back to terminal if server is not running

## Configuration

Configuration is stored in `~/.cc-mob/.env` (auto-generated on first server run):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | (generated) | Authentication token |
| `PORT` | 3456 | Server port |
| `SESSION_TTL` | 86400 | Session duration in seconds |

## LAN Mode

To access from other devices on your local network:

```bash
cc-mob --lan
```

## Running as a Service

To have cc-mob start automatically:

### Linux (systemd)

```bash
# Create service file
cat > ~/.config/systemd/user/cc-mob.service << 'EOF'
[Unit]
Description=cc-mob server

[Service]
ExecStart=/usr/bin/cc-mob
Restart=on-failure

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user enable cc-mob
systemctl --user start cc-mob
```

### macOS (launchd)

```bash
# Create plist file
cat > ~/Library/LaunchAgents/com.cc-mob.server.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cc-mob.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/cc-mob</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

# Load the service
launchctl load ~/Library/LaunchAgents/com.cc-mob.server.plist
```

## Troubleshooting

**MCP server fails to connect**
- Ensure the cc-mob server is running: `curl http://localhost:3456/api/health`
- Check server logs for errors

**Phone not receiving requests**
- Verify the server is running
- Re-scan the QR code if your session expired
- Check that your phone can reach the server URL

**Hooks not triggering**
- Verify plugin is loaded: run `/hooks` in Claude Code
- Check that the plugin is enabled: `claude plugin list`

**Plugin install fails with EXDEV error (Linux)**

This is a [known Claude Code bug](https://github.com/anthropics/claude-code/issues/14799) on Linux when `/tmp` is on a different filesystem (tmpfs).

Workaround:
```bash
mkdir -p ~/.claude/tmp
TMPDIR=~/.claude/tmp claude plugin install cc-mob
```

Permanent fix (add to `~/.bashrc` or `~/.zshrc`):
```bash
export TMPDIR="$HOME/.claude/tmp"
```

## License

Apache-2.0
