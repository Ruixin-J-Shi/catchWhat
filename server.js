#!/usr/bin/env node
// Zero-dependency static dev server with live reload over SSE.
// Serves ./public, watches it, and pushes a "reload" event on any change.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

function broadcastReload() {
  for (const res of clients) {
    res.write('event: reload\ndata: 1\n\n');
  }
}

// fs.watch fires several times per save; collapse the burst.
let reloadTimer = null;
fs.watch(ROOT, { recursive: true }, (_type, file) => {
  if (file && file.startsWith('.')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log(`[reload] ${file} -> ${clients.size} client(s)`);
    broadcastReload();
  }, 60);
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Access log: the only way to tell a phone/webview actually reached us.
  console.log(`[req] ${req.method} ${url.pathname} host=${req.headers.host} ua=${(req.headers['user-agent'] || '-').slice(0, 60)}`);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const filePath = path.join(ROOT, rel);

  // Keep requests inside ROOT.
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // Document requests fall back to index.html. The in-app container's map-remote
      // rewrite keeps the ORIGINAL path in some entry flows (tapping Profile > Balance
      // asks for /web-inapp/wallet-main/balance) while replacing it in others, so the
      // page must be reachable under any path. Asset 404s stay 404s.
      if ((req.headers.accept || '').includes('text/html')) {
        fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + rel);
            return;
          }
          console.log(`[req] ^ fallback -> index.html`);
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          res.end(html);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`catchWhat dev server on:`);
  console.log(`  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  http://${ip}:${PORT}   <- open this on the phone`);
  console.log(`watching ${ROOT} for changes (live reload enabled)`);
});
