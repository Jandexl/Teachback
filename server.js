// Local server for development: serves the app from /public and handles /api/teach.
// No packages needed. Run with:  npm start   (or)   node server.js
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTask, serverOptions, TaskError, warmUp, Cancelled } from './lib/tasks.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
// Only this computer can use the app (and your API credits). To let other devices on your
// network in, for example to test on your phone, set HOST=0.0.0.0 in .env.
const HOST = (process.env.HOST || '').trim() || '127.0.0.1';
const MAX_BODY = 6 * 1024 * 1024;

// Load .env without any package.
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      let value = m[2];
      // "KEY=value  # note": the note is not part of the value (quoted values are kept whole).
      if (/^["']/.test(value)) value = value.replace(/^(["'])(.*)\1.*$/, '$2');
      else value = value.replace(/\s+#.*$/, '');
      process.env[m[1]] = value.trim();
    }
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// If you open the app to other devices (HOST=0.0.0.0), each device gets a generous limit so
// nobody can burn through your AI credits. A real class, voice included, stays far below it.
const LIMIT_PER_10_MIN = 600;
const recent = new Map(); // device address -> times of its recent requests
function tooMany(req) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false; // this computer
  const now = Date.now();
  const times = (recent.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  times.push(now);
  recent.set(ip, times);
  // Forget devices that have gone quiet, so this list does not grow forever.
  if (recent.size > 500) for (const [key, list] of recent) if (!list.some((t) => now - t < 10 * 60 * 1000)) recent.delete(key);
  return times.length > LIMIT_PER_10_MIN;
}

async function handleApi(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (tooMany(req)) return send(res, 429, { error: 'Too many requests from this device. Wait a few minutes and try again.' });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume(); // drain the rest so the reply below reaches the browser
      return send(res, 413, { error: 'Request is too large.' });
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    // If the browser stops waiting (it paused background work, or the tab closed), stop the AI work too.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const result = await runTask(body.task, body.payload, { ...serverOptions(), signal: controller.signal });
    send(res, 200, result);
  } catch (err) {
    if (err instanceof Cancelled) return; // nobody is waiting for the answer
    if (err instanceof SyntaxError) return send(res, 400, { error: 'Request was not valid JSON.' });
    if (!(err instanceof TaskError)) console.error(err);
    send(res, err instanceof TaskError ? err.status : 500, {
      error: err instanceof TaskError ? err.message : 'Something went wrong on the server.',
    });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request', 'text/plain'); // a malformed link must not crash the server
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer((req, res) => {
  const handle = req.url.startsWith('/api/teach') ? handleApi : handleStatic;
  // Any unexpected error answers this one request; it never stops the server.
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const opts = serverOptions();
  console.log(`TeachBack is running at http://localhost:${PORT}`);
  if (!opts.featherlessKey && !opts.apiKey) {
    console.log('Warning: no AI key is set. Add FEATHERLESS_API_KEY (and GEMINI_API_KEY for voice) to .env.');
    return;
  }
  warmUp(opts)
    .then((picked) => {
      const short = (m) => m.split('/').pop();
      if (opts.featherlessKey) {
        if (picked.featherless) {
          console.log(`Classmates (live, speed first): Featherless ${short(picked.featherless)}`);
          const backups = (picked.featherlessChain || []).filter((m) => m !== picked.featherless).map(short);
          if (backups.length) console.log(`  If it is slow or busy, switches to: ${backups.join(', then ')}`);
          const q = (picked.qualityChain || []).map(short);
          if (q.length) console.log(`Quiz checks and report (accuracy first): ${q[0]}${q.length > 1 ? `\n  If it is slow or busy, switches to: ${q.slice(1).join(', then ')}` : ''}`);
          const g = (picked.gradingChain || []).map(short);
          if (g.length) console.log(`Grading the class quiz: ${g[0]}${g.length > 1 ? `\n  If it is slow or busy, switches to: ${g.slice(1).join(', then ')}` : ''}`);
        } else {
          console.log(`Featherless is not working yet: ${picked.featherlessProblem || 'no model was found'}.`);
        }
        if (opts.geminiTextBackup && opts.apiKey) console.log('  Last resort if every Featherless model fails: Gemini');
      }
      if (opts.apiKey) {
        if (!opts.featherlessKey && picked.main) console.log(`Classmates, quizzes and report: Gemini (${picked.main})`);
        if (picked.lite) console.log(`Voice (Brave, Firefox): Gemini ${picked.lite}`);
        else if (!picked.main) console.log('Voice (Brave, Firefox): Gemini (model picked on first use)');
      } else {
        console.log('Voice works only in Chrome and Edge (add GEMINI_API_KEY for Brave and Firefox).');
      }
    })
    .catch(() => console.log('Could not check your models yet. They will be picked on the first request.'));
});
