// EMBERFALL — точка входа сервера.
// Одна команда: npm start → HTTP (статика public/) + WebSocket (/ws) на порту 8080.
//
// Сервер слушает 0.0.0.0, чтобы другие игроки в локальной сети могли
// подключиться по адресу http://<IP-хоста>:8080.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { NetServer } from './net/server.js';
import { CARD_DB, DECK_LIST } from './game/cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    serveStatic(req, res);
  } catch (e) {
    console.error('[http] ошибка:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error');
  }
});

// Мини-статик-хендлер (~60 строк вместо Express — см. 00-ANALYSIS.md §2.1).
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('400');
    return;
  }

  // Публичный DB карт (для рендера рук/поля и коллекции).
  // Не секрет: секреты — СОДЕРЖИМОЕ колод и руки, а не описание карт.
  if (p === '/api/cards') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify({ cards: CARD_DB, deck: DECK_LIST }));
    return;
  }

  if (p === '/') p = '/index.html';

  // Защита от path traversal: итоговый путь обязан оставаться внутри public/.
  const file = path.normalize(path.join(PUBLIC_ROOT, p));
  if (file !== PUBLIC_ROOT && !file.startsWith(PUBLIC_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Length': st.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

const net = new NetServer(server);

server.listen(PORT, '0.0.0.0', () => {
  printBanner();
});

function printBanner() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  const lines = [
    '',
    '  ╔══════════════════════════════════════════════╗',
    "  ║  EMBERFALL — «Пепел и Пламя» — сервер готов   ║",
    '  ╚══════════════════════════════════════════════╝',
    `   Локально:  http://localhost:${PORT}`,
    ...ips.map((ip) => `   В сети:    http://${ip}:${PORT}`),
    ...ips.length === 0 ? ['   (IPv4-адрес не найден — проверьте сеть)'] : [],
    '   Другу: открыть адрес «В сети» в браузере.',
    '',
  ];
  console.log(lines.join('\n'));
}

process.on('SIGINT', () => {
  console.log('\nОстановка сервера…');
  net.closeAll('Сервер перезапускается');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
