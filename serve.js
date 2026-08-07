// Tiny static server (dev only, no dependencies).
// Usage: node serve.js [folder] [port] — defaults: prototype 5173
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, process.argv[2] || 'prototype');
const PORT = parseInt(process.argv[3], 10) || 5173;
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Serving ${ROOT} at http://localhost:${PORT}`));
