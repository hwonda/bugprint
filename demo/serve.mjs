// Tiny static server for the demo shop. Usage: node demo/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'app');
const nm = path.join(here, '..', 'node_modules');
const vendor = {
  '/vendor/rrweb.umd.min.cjs': path.join(nm, 'rrweb/dist/rrweb.umd.min.cjs'),
  '/vendor/rrweb-plugin-console-record.umd.min.cjs': path.join(
    nm,
    '@rrweb/rrweb-plugin-console-record/dist/rrweb-plugin-console-record.umd.min.cjs',
  ),
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css' };

// `--fixed` serves app.js with the bug patched, to show the repro test turning green.
const FIXED = process.argv.includes('--fixed') || process.env.DEMO_FIXED === '1';

export function startServer(port = 4173) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    const file = vendor[url] ?? path.join(root, url === '/' ? 'index.html' : path.normalize(url));
    if (!file.startsWith(root) && !Object.values(vendor).includes(file)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      if (FIXED && url === '/app.js') data = String(data).replace('COUPONS[code].rate', 'COUPONS[code.toUpperCase()].rate');
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 4173);
  await startServer(port);
  console.log(`Demo shop on http://localhost:${port}${FIXED ? ' (bug fixed)' : ''}`);
}
