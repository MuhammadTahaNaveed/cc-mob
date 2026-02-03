const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./lib/config');
const store = require('./lib/store');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Trust proxy headers (needed for localtunnel/ngrok to work with rate limiting)
app.set('trust proxy', 1);

app.use(express.json({ limit: '16kb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

app.use('/api/', apiLimiter);

// Cookie parser helper
function parseCookie(cookieHeader, name) {
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=')[1].trim() : '';
}

// Auth middleware - accepts cookie, header, or query param
function authCheck(req, res, next) {
  const token = req.query.token
    || req.headers['x-auth-token']
    || parseCookieFromReq(req, 'mob_session');
  if (token !== config.AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function parseCookieFromReq(req, name) {
  return parseCookie(req.headers.cookie || '', name);
}

// Serve static files (index.html) - no auth required for page load
app.use(express.static(path.join(__dirname, 'public')));

// Auth endpoint: exchange token for HttpOnly session cookie
app.post('/auth', (req, res) => {
  const { token } = req.body || {};
  if (token !== config.AUTH_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  res.cookie('mob_session', config.AUTH_TOKEN, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'strict',
    maxAge: config.SESSION_TTL,
    path: '/',
  });
  res.json({ ok: true });
});

// Rotate the auth token -- invalidates all existing sessions
app.post('/api/rotate-token', authCheck, (req, res) => {
  const newToken = config.rotateToken();
  // Clear old cookie, set new one
  res.cookie('mob_session', newToken, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'strict',
    maxAge: config.SESSION_TTL,
    path: '/',
  });
  // Close all existing WebSocket connections (they have the old token)
  for (const ws of wsClients) {
    ws.close(4002, 'Token rotated');
  }
  wsClients.clear();
  res.json({ ok: true, message: 'Token rotated. Reconnect with new token.' });
});

// Health check - no auth required, used by hooks to detect if server is running
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// API routes - all require auth
const VALID_TYPES = ['permission', 'question', 'notification'];

app.post('/api/request', createLimiter, authCheck, (req, res) => {
  const { type, payload } = req.body;
  if (!type || !payload) {
    return res.status(400).json({ error: 'type and payload required' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid request type' });
  }
  if (typeof payload !== 'object' || payload === null) {
    return res.status(400).json({ error: 'payload must be an object' });
  }
  const id = store.create(type, payload);
  broadcast({ event: 'new_request', data: store.get(id) ? serialize(store.get(id)) : null });
  res.json({ id });
});

app.get('/api/request/:id/wait', authCheck, async (req, res) => {
  const { id } = req.params;
  try {
    const response = await store.wait(id);
    res.json({ status: 'resolved', response });
  } catch (err) {
    if (err.message === 'Request timeout') {
      res.status(408).json({ error: 'timeout', message: 'Request timed out waiting for response' });
    } else {
      res.status(404).json({ error: err.message });
    }
  }
});

app.post('/api/request/:id/respond', authCheck, (req, res) => {
  const { id } = req.params;
  const { decision } = req.body;
  if (!decision) {
    return res.status(400).json({ error: 'decision required' });
  }
  const ok = store.respond(id, decision);
  if (!ok) {
    return res.status(404).json({ error: 'Request not found or already resolved' });
  }
  // Broadcast is now handled by store 'resolved' event listener
  res.json({ ok: true });
});

app.get('/api/requests', authCheck, (req, res) => {
  res.json({ pending: store.getPending(), all: store.getAll() });
});

app.post('/api/notify', authCheck, (req, res) => {
  const { message } = req.body;
  broadcast({ event: 'notification', data: { message, timestamp: Date.now() } });
  res.json({ ok: true });
});

function serialize(entry) {
  return {
    id: entry.id,
    type: entry.type,
    payload: entry.payload,
    status: entry.status,
    response: entry.response,
    createdAt: entry.createdAt,
    resolvedAt: entry.resolvedAt,
  };
}

// WebSocket
const wsClients = new Set();
const wsConnectTimes = new Map(); // IP -> [timestamps] for rate limiting

wss.on('connection', (ws, req) => {
  // Rate limit WebSocket connections: max 10 per minute per IP
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const times = wsConnectTimes.get(ip) || [];
  const recent = times.filter(t => now - t < 60000);
  if (recent.length >= 10) {
    ws.close(4003, 'Too many connections');
    return;
  }
  recent.push(now);
  wsConnectTimes.set(ip, recent);

  // Auth via cookie (preferred) or query string (fallback for hooks/MCP)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const cookieToken = parseCookie(req.headers.cookie || '', 'mob_session');
  if (token !== config.AUTH_TOKEN && cookieToken !== config.AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  wsClients.add(ws);
  ws.isAlive = true;
  // Send current pending requests on connect
  ws.send(JSON.stringify({ event: 'init', data: { pending: store.getPending() } }));

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));

  // Handle client messages (ping keepalive)
  ws.on('message', (data) => {
    ws.isAlive = true; // Any message means connection is alive
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        // Respond with pong to keep connection alive
        ws.send(JSON.stringify({ event: 'pong' }));
      }
    } catch (e) {
      // Ignore invalid messages
    }
  });
});

// Ping/pong keepalive - terminate stale connections every 30s
const wsKeepalive = setInterval(() => {
  for (const ws of wsClients) {
    if (!ws.isAlive) {
      wsClients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(wsKeepalive));

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// Broadcast when store resolves requests (including timeouts/expiry)
store.on('resolved', (entry) => {
  broadcast({ event: 'resolved', data: entry });
});

// Start
server.listen(config.PORT, config.BIND_HOST, async () => {
  const localUrl = `http://localhost:${config.PORT}`;

  console.log('');
  console.log('  cc-mob server running');
  console.log('  ========================');
  console.log(`  Local:  ${localUrl}`);
  if (config.LAN_MODE) {
    const lanUrl = `http://${config.LAN_IP}:${config.PORT}`;
    console.log(`  LAN:    ${lanUrl}`);
  } else {
    console.log('  LAN:    disabled (use --lan to enable)');
  }

  // Attempt localtunnel
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port: config.PORT });
    const tunnelUrl = `${tunnel.url}?token=${config.AUTH_TOKEN}`;
    console.log(`  Tunnel: ${tunnel.url}`);
    console.log(`  Auth:   ${tunnelUrl}`);

    console.log('');
    const qrcode = require('qrcode-terminal');
    qrcode.generate(tunnelUrl, { small: true }, (qr) => {
      console.log(qr);
    });
    console.log('  Scan the QR code to authenticate. Token will be exchanged for a secure cookie.');

    tunnel.on('close', () => {
      console.log('  [tunnel] Connection closed, attempting reconnect...');
      setTimeout(async () => {
        try {
          const newTunnel = await localtunnel({ port: config.PORT });
          console.log(`  [tunnel] Reconnected: ${newTunnel.url}`);
          newTunnel.on('error', (err) => {
            console.log('  [tunnel] Error:', err.message);
          });
        } catch (e) {
          console.log('  [tunnel] Reconnect failed:', e.message);
        }
      }, 3000);
    });

    tunnel.on('error', (err) => {
      console.log('  [tunnel] Error:', err.message);
      console.log('  [tunnel] Server continues running. Use local/LAN URL instead.');
    });
  } catch (e) {
    console.log(`  Tunnel: failed (${e.message}) - use LAN URL instead`);
  }

  console.log('');
});
