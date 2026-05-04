// ============================================================
// @iaconpatrick Dashboard — Servidor local
// Ejecutar: node server.js
// Luego abrir: http://localhost:3000
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// ─── MIME TYPES ───────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ─── APIFY PROXY ──────────────────────────────────────────
// Todas las llamadas a /api/apify/* se redirigen a api.apify.com/*
// Sin restricciones de CORS porque es servidor → servidor
function proxyApify(req, res, apifyPath, body) {
  const options = {
    hostname: 'api.apify.com',
    path: apifyPath,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'iaconpatrick-dashboard/2.0',
    },
  };

  if (body) {
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  const proxyReq = https.request(options, (proxyRes) => {
    // CORS headers para el browser
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = proxyRes.statusCode;

    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      res.end(data);
    });
  });

  proxyReq.on('error', (e) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
}

// ─── ANTHROPIC PROXY ──────────────────────────────────────
function proxyAnthropic(req, res, body) {
  // Parsear el body para extraer la api key y el payload real
  let parsed;
  try { parsed = JSON.parse(body); } catch(e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const apiKey = parsed._apiKey;
  const payload = { ...parsed };
  delete payload._apiKey; // no enviamos la key en el payload

  const payloadStr = JSON.stringify(payload);

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payloadStr),
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = proxyRes.statusCode;

    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => res.end(data));
  });

  proxyReq.on('error', (e) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  });

  proxyReq.write(payloadStr);
  proxyReq.end();
}

// ─── SERVER ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── PROXY: /api/apify/* → https://api.apify.com/*
  if (pathname.startsWith('/api/apify/')) {
    const apifyPath = pathname.replace('/api/apify', '') + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => proxyApify(req, res, apifyPath, body));
    } else {
      proxyApify(req, res, apifyPath, null);
    }
    return;
  }

  // ── PROXY: /api/anthropic → https://api.anthropic.com/v1/messages
  if (pathname === '/api/anthropic') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => proxyAnthropic(req, res, body));
    return;
  }

  // ── STATIC FILES ──────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'text/plain');
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   @iaconpatrick Dashboard v2.0       ║');
  console.log('  ║   SISTEMA ONLINE                     ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║   URL: http://localhost:${PORT}          ║`);
  console.log('  ║   Ctrl+C para parar                  ║');
  console.log('  ╚══════════════════════════════════════╝\n');
});
