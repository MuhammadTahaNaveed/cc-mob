#!/usr/bin/env node

// CLI entry point for cc-mob
// Usage:
//   cc-mob       - Start the HTTP/WebSocket server
//   cc-mob mcp   - Start the MCP server (used by Claude Code plugin)

const path = require('path');

// Set plugin root to package directory (one level up from bin/)
process.env.CC_MOB_PLUGIN_ROOT = path.join(__dirname, '..');

const command = process.argv[2];

if (command === 'mcp') {
  // Start MCP server (invoked by Claude Code, not users)
  require('../mcp-server.js');
} else {
  // Default: start HTTP server
  require('../server.js');
}
