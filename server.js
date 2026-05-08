const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const url       = require('url');
const crypto    = require('crypto');
const pdfParse  = require('pdf-parse');

const PORT      = process.env.PORT           || 3000;
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASS || 'dashboard2026';
const ENV_TOKEN = process.env.APIFY_TOKEN    || '';

const CONFIG_FILE   = path.join(__dirname, 'config.json');
const CACHE_FILE    = path.join(__dirname, 'cache.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
};

// ─── SESIONES (persistidas en disco) ─────────────────────────
const sessions = new Map();

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now  = Date.now();
    let n = 0;
    for (const [token, expiry] of Object.entries(data)) {
      if (expiry > now) { sessions.set(token, expiry); n++; }
    }
    if (n) console.log(`[Auth] ${n} sesión(es) restauradas desde disco`);
  } catch { /* primera vez, sin archivo */ }
}

function saveSessions() {
  try {
    const data = Object.fromEntries([...sessions.entries()].filter(([, e]) => e > Date.now()));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data));
  } catch(e) {}
}

loadSessions();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  saveSessions();
  return token;
}

function isValidSession(req) {
  const cookie = req.headers['cookie'] || '';
  const match  = cookie.match(/session=([a-f0-9]{64})/);
  if (!match) return false;
  const expiry = sessions.get(match[1]);
  if (!expiry || Date.now() > expiry) { sessions.delete(match[1]); saveSessions(); return false; }
  return true;
}

function requireAuth(req, res) {
  if (isValidSession(req)) return true;
  const pathname = url.parse(req.url).pathname;
  if (pathname.startsWith('/api/')) {
    // Las rutas de API devuelven JSON 401, no HTML redirect
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'session_expired' }));
  } else {
    res.statusCode = 302;
    res.setHeader('Location', '/login');
    res.end();
  }
  return false;
}

// ─── CONFIG / CACHE ──────────────────────────────────────────
function readConfig()      { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveConfigFile(d) { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2)); } catch(e) {} }
function readCache()       { try { return JSON.parse(fs.readFileSync(CACHE_FILE,  'utf8')); } catch { return null; } }
function saveCacheFile(d)  { try { fs.writeFileSync(CACHE_FILE,  JSON.stringify(d)); }        catch(e) {} }

// ─── APIFY PROXY ─────────────────────────────────────────────
function proxyApify(req, res, apifyPath, body) {
  // Si no hay token en la URL pero existe APIFY_TOKEN en el entorno, inyectarlo
  if (ENV_TOKEN && !apifyPath.includes('token=')) {
    apifyPath += (apifyPath.includes('?') ? '&' : '?') + 'token=' + ENV_TOKEN;
  } else if (ENV_TOKEN && apifyPath.includes('token=test')) {
    apifyPath = apifyPath.replace('token=test', 'token=' + ENV_TOKEN);
  }
  const options = {
    hostname: 'api.apify.com',
    path:     apifyPath,
    method:   req.method,
    headers:  { 'Content-Type': 'application/json', 'User-Agent': 'social-analytics-dashboard/2.0' },
  };
  if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
  const proxyReq = https.request(options, (proxyRes) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = proxyRes.statusCode;
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end',  () => res.end(data));
  });
  proxyReq.on('error', e => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

// ─── ANTHROPIC PROXY ─────────────────────────────────────────
function proxyAnthropic(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
  const apiKey     = parsed._apiKey;
  const payload    = { ...parsed };
  delete payload._apiKey;
  const payloadStr = JSON.stringify(payload);
  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers:  { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payloadStr) },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = proxyRes.statusCode;
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end',  () => res.end(data));
  });
  proxyReq.on('error', e => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
  proxyReq.write(payloadStr);
  proxyReq.end();
}

// ─── OPENAI PROXY ─────────────────────────────────────────────
function proxyOpenAI(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
  const apiKey     = parsed._apiKey;
  const payload    = { ...parsed };
  delete payload._apiKey;
  const payloadStr = JSON.stringify(payload);
  const options = {
    hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
    headers:  { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(payloadStr) },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = proxyRes.statusCode;
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end',  () => res.end(data));
  });
  proxyReq.on('error', e => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
  proxyReq.write(payloadStr);
  proxyReq.end();
}

// ─── GEMINI PROXY ─────────────────────────────────────────────
function proxyGemini(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
  const apiKey     = parsed._apiKey;
  const model      = parsed._model || 'gemini-2.0-flash';
  const payload    = { contents: parsed.contents };
  const payloadStr = JSON.stringify(payload);
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path:     `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr) },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = proxyRes.statusCode;
    let data = '';
    proxyRes.on('data', c => data += c);
    proxyRes.on('end',  () => res.end(data));
  });
  proxyReq.on('error', e => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
  proxyReq.write(payloadStr);
  proxyReq.end();
}

// ─── SERVER-SIDE APIFY SYNC ──────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGetJSON(reqUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'social-analytics-dashboard/2.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPostJSON(hostname, reqPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request(
      { hostname, path: reqPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'User-Agent': 'social-analytics-dashboard/2.0' } },
      res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject); req.write(bodyStr); req.end();
  });
}

async function runActorServer(token, actorId, input) {
  const sd = await httpsPostJSON('api.apify.com', `/v2/acts/${actorId}/runs?token=${token}`, input);
  if (!sd.data) throw new Error(`Actor ${actorId}: no se pudo iniciar`);
  const runId = sd.data.id, dsId = sd.data.defaultDatasetId;
  let status = 'RUNNING', attempts = 0;
  while (status === 'RUNNING' || status === 'READY') {
    if (attempts++ > 80) throw new Error(`Timeout en ${actorId}`);
    await delay(4000);
    const pr = await httpsGetJSON(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    status = pr.data?.status || 'FAILED';
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`${actorId} falló`);
  }
  const items = await httpsGetJSON(`https://api.apify.com/v2/datasets/${dsId}/items?token=${token}&format=json`);
  return Array.isArray(items) ? items : [];
}

async function runAutoSync() {
  const cfg   = readConfig();
  const token = ENV_TOKEN || cfg.apifyToken;
  if (!token) { console.log('[AUTO-SYNC] Sin token Apify, saltando.'); return; }
  const ttHandle = (cfg.ttHandle || '').replace('@', '');
  const igHandle = (cfg.igHandle || '').replace('@', '');
  const kwArr    = (cfg.nicheKw  || 'IA,marketing,automatización').split(',').slice(0, 3).map(k => k.trim());
  const maxPosts = parseInt(cfg.maxPosts) || 30;
  console.log(`[AUTO-SYNC] Iniciando — ${new Date().toISOString()}`);
  try {
    const ttRaw       = await runActorServer(token, 'clockworks~tiktok-scraper',        { profiles: [ttHandle], resultsType: 'posts', maxPostsPerPage: maxPosts, shouldDownloadVideos: false, shouldDownloadCovers: false });
    const igProfileRaw= await runActorServer(token, 'apify~instagram-scraper',           { directUrls: [`https://www.instagram.com/${igHandle}/`], resultsType: 'posts', resultsLimit: 1 }).catch(()=>[]);
    const igRaw       = await runActorServer(token, 'apify~instagram-scraper',           { directUrls: [`https://www.instagram.com/${igHandle}/`], resultsType: 'posts', resultsLimit: maxPosts });
    const trendRaw    = await runActorServer(token, 'clockworks~tiktok-hashtag-scraper', { hashtags: kwArr, resultsPerPage: 30 });
    saveCacheFile({ ttRaw, igRaw, igProfileRaw, trendRaw, syncedAt: new Date().toISOString() });
    console.log(`[AUTO-SYNC] ✓ Completado — ${ttRaw.length} TT, ${igRaw.length} IG, followers en perfil: ${igProfileRaw[0]?.followersCount||'N/D'}`);
  } catch(e) { console.error('[AUTO-SYNC] Error:', e.message); }
}

setTimeout(runAutoSync, 15000);
setInterval(runAutoSync, 7 * 24 * 60 * 60 * 1000);

// ─── SERVER ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204; res.end(); return;
  }

  // ── LOGIN page (sin auth)
  if (pathname === '/login') {
    fs.readFile(path.join(__dirname, 'login.html'), (err, data) => {
      if (err) { res.statusCode = 404; res.end('Not found'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(data);
    });
    return;
  }

  // ── POST /api/login — valida credenciales y crea sesión
  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { user, pass } = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        if (user === DASH_USER && pass === DASH_PASS) {
          const token = createSession();
          res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/`);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Usuario o contraseña incorrectos' }));
        }
      } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }

  // ── POST /api/logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookie = req.headers['cookie'] || '';
    const match  = cookie.match(/session=([a-f0-9]{64})/);
    if (match) { sessions.delete(match[1]); saveSessions(); }
    res.setHeader('Set-Cookie', 'session=; Max-Age=0; Path=/');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Auth en todas las demás rutas
  if (!requireAuth(req, res)) return;

  // ── POST /api/config
  if (pathname === '/api/config') {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { saveConfigFile(JSON.parse(body)); res.end(JSON.stringify({ ok: true })); } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); } });
    } else { res.end(JSON.stringify(readConfig())); }
    return;
  }

  // ── GET|POST /api/cache
  if (pathname === '/api/cache') {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { saveCacheFile(JSON.parse(body)); res.end(JSON.stringify({ ok: true })); } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); } });
    } else { const cache = readCache(); res.end(cache ? JSON.stringify(cache) : 'null'); }
    return;
  }

  // ── PROXY /api/apify/*
  if (pathname.startsWith('/api/apify/')) {
    const apifyPath = pathname.replace('/api/apify', '') + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    if (req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => proxyApify(req, res, apifyPath, body)); }
    else { proxyApify(req, res, apifyPath, null); }
    return;
  }

  // ── POST /api/parse-pdf — extrae texto de un PDF en base64
  if (pathname === '/api/parse-pdf' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { data, name } = JSON.parse(body);
        if (!data) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing data' })); return; }
        const buffer = Buffer.from(data, 'base64');
        const result = await pdfParse(buffer);
        const text = result.text.replace(/\s+/g, ' ').trim().slice(0, 6000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text, pages: result.numpages, chars: text.length }));
      } catch(e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Error al parsear el PDF: ' + e.message }));
      }
    });
    return;
  }

  // ── GET /api/scrape?url=... — extrae texto de una URL para contexto IA
  if (pathname === '/api/scrape' && req.method === 'GET') {
    const targetUrl = parsed.query && parsed.query.url;
    if (!targetUrl) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Missing url param' })); return; }
    let u;
    try { u = new URL(targetUrl); } catch(e) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid URL' })); return; }
    if (!['http:', 'https:'].includes(u.protocol)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Only http/https allowed' })); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const scrapeReq = mod.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardBot/1.0)', 'Accept': 'text/html' }, timeout: 8000 },
      (scrapeRes) => {
        // Follow single redirect
        if ((scrapeRes.statusCode === 301 || scrapeRes.statusCode === 302) && scrapeRes.headers.location) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ text: `Redirigido a: ${scrapeRes.headers.location}. Usa la URL final directamente.`, redirected: true }));
          return;
        }
        let data = '';
        scrapeRes.on('data', c => { if (data.length < 500000) data += c; });
        scrapeRes.on('end', () => {
          const text = data
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ text, length: text.length }));
        });
      }
    );
    scrapeReq.on('error', e => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
    scrapeReq.on('timeout', () => { scrapeReq.destroy(); res.statusCode = 504; res.end(JSON.stringify({ error: 'Timeout al leer la web' })); });
    return;
  }

  // ── PROXY /api/anthropic
  if (pathname === '/api/anthropic') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => proxyAnthropic(req, res, body));
    return;
  }

  // ── PROXY /api/openai
  if (pathname === '/api/openai') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => proxyOpenAI(req, res, body));
    return;
  }

  // ── PROXY /api/gemini
  if (pathname === '/api/gemini') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => proxyGemini(req, res, body));
    return;
  }

  // ── ARCHIVOS ESTÁTICOS
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'text/plain');
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   Social Analytics Dashboard v2.0       ║');
  console.log('  ║   SISTEMA ONLINE                     ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║   URL: http://localhost:${PORT}          ║`);
  console.log(`  ║   Usuario: ${DASH_USER.padEnd(27)}║`);
  console.log('  ║   Ctrl+C para parar                  ║');
  console.log('  ╚══════════════════════════════════════╝\n');
});
