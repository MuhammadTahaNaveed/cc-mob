const os = require('os');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnv() {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (e) {
    // .env not found, that's fine
  }
}

loadEnv();

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function ensureAuthToken() {
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;

  const token = crypto.randomBytes(24).toString('hex');
  let envContent = '';
  try {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (e) {
    // file doesn't exist
  }

  if (!envContent.includes('AUTH_TOKEN=')) {
    envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}AUTH_TOKEN=${token}\n`;
    fs.writeFileSync(ENV_PATH, envContent);
  }

  process.env.AUTH_TOKEN = token;
  return token;
}

const LAN_MODE = process.argv.includes('--lan') || process.env.LAN === '1';
const SESSION_TTL = parseInt(process.env.SESSION_TTL || '86400', 10) * 1000; // default 24h in ms

const config = {
  PORT: parseInt(process.env.PORT || '3456', 10),
  AUTH_TOKEN: ensureAuthToken(),
  EXPIRY: 24 * 60 * 60 * 1000, // 24 hours
  SESSION_TTL,
  LAN_IP: getLanIP(),
  LAN_MODE,
  BIND_HOST: LAN_MODE ? '0.0.0.0' : '127.0.0.1',
  PROJECT_DIR: path.join(__dirname, '..'),

  // Rotate the auth token: generate new one and update .env
  rotateToken() {
    const newToken = crypto.randomBytes(24).toString('hex');
    let envContent = '';
    try {
      envContent = fs.readFileSync(ENV_PATH, 'utf8');
    } catch (e) {}

    // Replace existing AUTH_TOKEN line or append
    if (envContent.includes('AUTH_TOKEN=')) {
      envContent = envContent.replace(/AUTH_TOKEN=.*/g, `AUTH_TOKEN=${newToken}`);
    } else {
      envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}AUTH_TOKEN=${newToken}\n`;
    }
    fs.writeFileSync(ENV_PATH, envContent);
    process.env.AUTH_TOKEN = newToken;
    config.AUTH_TOKEN = newToken;
    return newToken;
  },
};

module.exports = config;
