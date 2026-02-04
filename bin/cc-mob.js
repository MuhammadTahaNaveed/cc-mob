#!/usr/bin/env node

// CLI entry point for cc-mob
// Sets CC_MOB_PLUGIN_ROOT so config/server find the right paths

const path = require('path');

// Set plugin root to package directory (one level up from bin/)
process.env.CC_MOB_PLUGIN_ROOT = path.join(__dirname, '..');

// Start the server
require('../server.js');
