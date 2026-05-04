const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

const PORT      = process.env.PORT           || 3000;
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASS || 'iaconpatrick2025';
const ENV_TOKEN = process.env.APIFY_TOKEN    || '';

const CONFIG_FILE = path.join(__dirname, 'config.json');
const CACHE_FILE  = path.join(__dirname, 'cache.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ─── SESIONES ────────────────────────────────────────────────
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return token;
}

function isValidSession(req) {
  const cookie = req.headers['cookie'] || '';
  const match  = cookie.match(/session=([a-f0-9]{64})/);
  if (!match) return false;
  const expiry = sessions.get(match[1]);
  if (!expiry || Date.now() > expiry) { sessions.delete(match[1]); return false; }
  return true;
}

function requireAuth(req, res) {
  if (isValidSession(req)) return true;
  res.statusCode = 302;
  res.setHeader('Location', '/login');
  res.end();
  return false;
}

// ─── CONFIG / CACHE ──────────────────────────────────────────
function readConfig()      { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveConfigFile(d) { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2)); } catch(e) {} }
function readCache()       { try { return JSON.parse(fs.readFileSync(CACHE_FILE,  'utf8')); } catch { return null; } }
function saveCacheFile(d)  { try { fs.writeFileSync(CACHE_FILE,  JSON.stringify(d)); }        catch(e) {} }

// ─── APIFY PROXY ─────────────────────────────────────────────
function proxyApify(req, res, apifyPath, body) {
  const options = {
    hostname: 'api.apify.com',
    path:     apifyPath,
    method:   req.method,
    headers:  { 'Content-Type': 'application/json', 'User-Agent': 'iaconpatrick-dashboard/2.0' },
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

// ─── SERVER-SIDE APIFY SYNC ──────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGetJSON(reqUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'iaconpatrick-dashboard/2.0' } }, res => {
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
      { hostname, path: reqPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'User-Agent': 'iaconpatrick-dashboard/2.0' } },
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
  const ttHandle = (cfg.ttHandle || 'iaconpatrick').replace('@', '');
  const igHandle = (cfg.igHandle || 'iaconpatrick').replace('@', '');
  const kwArr    = (cfg.nicheKw  || 'IA,marketing,automatización').split(',').slice(0, 3).map(k => k.trim());
  const maxPosts = parseInt(cfg.maxPosts) || 30;
  console.log(`[AUTO-SYNC] Iniciando — ${new Date().toISOString()}`);
  try {
    const ttRaw    = await runActorServer(token, 'clockworks~tiktok-scraper',       { profiles: [ttHandle], resultsType: 'posts', maxPostsPerPage: maxPosts });
    const igRaw    = await runActorServer(token, 'apify~instagram-scraper',          { directUrls: [`https://www.instagram.com/${igHandle}/`], resultsType: 'posts', resultsLimit: maxPosts });
    const trendRaw = await runActorServer(token, 'clockworks~tiktok-hashtag-scraper',{ hashtags: kwArr, resultsPerPage: 20 });
    saveCacheFile({ ttRaw, igRaw, trendRaw, syncedAt: new Date().toISOString() });
    console.log(`[AUTO-SYNC] ✓ Completado — ${ttRaw.length} TT, ${igRaw.length} IG`);
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
    if (match) sessions.delete(match[1]);
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

  // ── PROXY /api/anthropic
  if (pathname === '/api/anthropic') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => proxyAnthropic(req, res, body));
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
  console.log('  ║   @iaconpatrick Dashboard v2.0       ║');
  console.log('  ║   SISTEMA ONLINE                     ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║   URL: http://localhost:${PORT}          ║`);
  console.log(`  ║   Usuario: ${DASH_USER.padEnd(27)}║`);
  console.log('  ║   Ctrl+C para parar                  ║');
  console.log('  ╚══════════════════════════════════════╝\n');
});
