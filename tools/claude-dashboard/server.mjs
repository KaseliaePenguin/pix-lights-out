// Claude 利用状況ダッシュボードのローカルサーバー
//
// 起動: npm run dashboard  → http://127.0.0.1:5190
// 会話記録を含むため 127.0.0.1 でのみ待ち受ける (LAN には公開しない)

import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAssets, MIME, resolveAssetPath } from './assets.mjs';
import { collect } from './collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 5190);
const HOST = '127.0.0.1';
const PROJECT = resolve(process.env.DASHBOARD_PROJECT ?? process.cwd());

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** アセットを配信する。音声のシークに必要な Range リクエストにも対応する */
function sendFile(req, res, file) {
  const { size } = statSync(file);
  const headers = {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'index.html')));
      return;
    }
    if (url.pathname === '/api/data') return sendJson(res, collect(PROJECT));
    if (url.pathname === '/api/assets') return sendJson(res, listAssets(PROJECT));
    if (url.pathname === '/file') {
      const file = resolveAssetPath(PROJECT, url.searchParams.get('path') ?? '');
      if (!file) {
        res.writeHead(404).end('Not found');
        return;
      }
      sendFile(req, res, file);
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
