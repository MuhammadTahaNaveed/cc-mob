const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Load .env for AUTH_TOKEN
const envPath = path.join(__dirname, '.env');
try {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch (e) {}

const PORT = process.env.PORT || 3456;
const TOKEN = process.env.AUTH_TOKEN || '';

function httpRequest(method, urlPath, body, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: `${urlPath}${urlPath.includes('?') ? '&' : '?'}token=${TOKEN}`,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const mcpServer = new McpServer({
  name: 'cc-mob',
  version: '1.0.0',
});

mcpServer.tool(
  'ask_user',
  `Ask the user a question via their phone. Use this tool with the SAME parameters you would use for AskUserQuestion.

Parameters:
- questions: Array of 1-4 question objects, each with:
  - question (string): The question to ask
  - header (string): Short label displayed as a chip/tag (max 12 chars)
  - options (array): Available choices, each with label (string) and description (string)
  - multiSelect (boolean): Whether multiple options can be selected

The user will always have an "Other" free-text option automatically. Returns an answers object mapping question text to the selected label or custom text.`,
  {
    questions: z.array(z.object({
      question: z.string(),
      header: z.string(),
      options: z.array(z.object({
        label: z.string(),
        description: z.string(),
      })).min(2).max(4),
      multiSelect: z.boolean(),
    })).min(1).max(4).optional()
      .describe('Array of 1-4 questions with options. Use this format for rich question cards.'),
    question: z.string().optional()
      .describe('Simple question string (legacy format). Prefer using "questions" array instead.'),
    options: z.array(z.string()).optional()
      .describe('Simple options list (legacy format). Prefer using "questions" array instead.'),
  },
  async (params) => {
    try {
      let payload;

      if (params.questions && params.questions.length > 0) {
        // New rich format
        payload = { questions: params.questions };
      } else if (params.question) {
        // Legacy simple format - pass through as-is for backwards compat
        payload = { question: params.question, options: params.options || [] };
      } else {
        return { content: [{ type: 'text', text: 'Error: Must provide either "questions" array or "question" string.' }] };
      }

      // Create request on server
      const createRes = await httpRequest('POST', '/api/request', {
        type: 'question',
        payload,
      });

      if (!createRes.id) {
        return { content: [{ type: 'text', text: 'Error: Failed to create question request. Is the cc-mob server running?' }] };
      }

      // Long-poll for answer
      const waitRes = await httpRequest('GET', `/api/request/${createRes.id}/wait`);

      if (waitRes.response && waitRes.response.answer) {
        const answer = waitRes.response.answer;
        // If answer is an object (multi-question answers map), return as JSON
        if (typeof answer === 'object') {
          return { content: [{ type: 'text', text: JSON.stringify({ answers: answer }) }] };
        }
        return { content: [{ type: 'text', text: answer }] };
      }

      return { content: [{ type: 'text', text: 'No response from user (timeout)' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error reaching cc-mob server: ${err.message}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
