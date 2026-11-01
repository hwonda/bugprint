// Tiny server for the demo shop: static files + a fake coupon/order API.
// Usage: node demo/serve.mjs [port] [--fixed]
//   --fixed / DEMO_FIXED=1           serve app.js with the bug patched
//   DEMO_COUPON_EXPIRED=1            the API reports SAVE20 as expired (what production
//                                    returned on the day the bug was recorded)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'app');
const nm = path.join(here, '..', 'node_modules');
const vendor = {
  '/vendor/rrweb.umd.min.cjs': path.join(nm, 'rrweb/dist/rrweb.umd.min.cjs'),
  '/vendor/rrweb-plugin-console-record.umd.min.cjs': path.join(nm, '@rrweb/rrweb-plugin-console-record/dist/rrweb-plugin-console-record.umd.min.cjs'),
  '/vendor/rrweb-plugin-network-record.umd.min.cjs': path.join(nm, '@rrweb/rrweb-plugin-network-record/dist/rrweb-plugin-network-record.umd.min.cjs'),
  '/vendor/bugprint-recorder.js': path.join(here, '..', 'dist/recorder/plugin.js'),
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css' };

const FIXED = process.argv.includes('--fixed') || process.env.DEMO_FIXED === '1';
const EXPIRED = process.env.DEMO_COUPON_EXPIRED === '1';

function api(req, res, url) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const coupon = /^\/api\/coupons\/([^/]+)$/.exec(url);
  if (coupon && req.method === 'GET') {
    const code = decodeURIComponent(coupon[1]).toUpperCase();
    if (code !== 'SAVE20') return send(404, { code, expired: false, discount: null });
    return EXPIRED
      ? send(200, { code, expired: true, discount: null })
      : send(200, { code, expired: false, discount: { rate: 0.2 } });
  }
  if (url === '/api/orders' && req.method === 'POST') return send(201, { id: 'ord_1042', status: 'placed' });
  return send(404, { error: 'not found' });
}

export function startServer(port = 4173) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    if (url.startsWith('/api/')) return api(req, res, url);
    const file = vendor[url] ?? path.join(root, url === '/' ? 'index.html' : path.normalize(url));
    if (!file.startsWith(root) && !Object.values(vendor).includes(file)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      if (FIXED && url === '/app.js') data = String(data).replace('if (res.ok) {', 'if (res.ok && !data.expired) {');
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 4173);
  await startServer(port);
  console.log(`Demo shop on http://localhost:${port}${FIXED ? ' (bug fixed)' : ''}${EXPIRED ? ' (coupon expired)' : ''}`);
}
