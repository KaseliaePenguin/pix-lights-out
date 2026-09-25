// Claude 利用状況ダッシュボードのローカルサーバー
//
// 起動: npm run dashboard  → http://127.0.0.1:5190
// 会話記録を含むため 127.0.0.1 でのみ待ち受ける (LAN には公開しない)

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 5190);
const HOST = '127.0.0.1';

const server = createServer((req, res) => {
  try {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'index.html')));
      return;
    }
    if (req.url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(collect()));
      return;
    }
    res.writeHead(404).end('Not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(e?.stack ?? e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude dashboard: http://${HOST}:${PORT}`);
});
