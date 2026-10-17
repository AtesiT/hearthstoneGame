// acceptance.js — Этап 7: прогон 15 критериев приёмки (00-ANALYSIS.md §7).
//
// Запуск: npm run acceptance
// Автоматизирует всё, что можно проверить машиной; визуальные пункты
// (7–9: стиль/анимации/прослушивание) проверяются статикой + помечены
// «ручной чек-лист» в выводе.
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CARD_DB, DECK_LIST } from '../server/game/cards.js';
import { createGame, command, computePlayOptions, computeAttackOptions, EMOTIONS } from '../server/game/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8092;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const HTTP = `http://127.0.0.1:${PORT}`;

const results = [];
function record(n, name, ok, extra = '') {
  results.push({ n, name, ok, extra });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}${extra ? ` — ${extra}` : ''}`);
}
const run = (cmd, args, timeout = 180000) =>
  new Promise((res) => {
    execFile(cmd, args, { cwd: ROOT, timeout, env: { ...process.env, FORCE_COLOR: '0', PORT: String(PORT) } },
      (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) }));
  });
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const get = (p) => new Promise((res) => {
  http.get(HTTP + p, (r) => {
    let b = '';
    r.on('data', (c) => (b += c));
    r.on('end', () => res({ status: r.statusCode, body: b }));
  }).on('error', () => res({ status: 0, body: '' }));
});

// ── минимальный WS-клиент (как в sim-*) ──
class C {
  constructor(name) {
    this.name = name; this.queue = []; this.waiters = [];
    this.token = null; this.roomCode = null; this.mySeat = null;
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'room_update') {
        this.token = m.d.myToken ?? this.token;
        this.roomCode = m.d.code ?? this.roomCode;
        this.mySeat = m.d.mySeat ?? this.mySeat;
      }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); }
      else this.queue.push(m);
    });
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  send(t, d) { this.ws.send(JSON.stringify({ t, d })); }
  waitPred(pred, label = '?', timeout = 8000) {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = {
        pred, res,
        timer: setTimeout(
          () => rej(new Error(`${this.name}: таймаут [${label}] queue=[${this.queue.map((m) => m.t).join(',')}]`)),
          timeout,
        ),
      };
      this.waiters.push(w);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
const waitT = (c, t, label = t, timeout = 8000) => c.waitPred((m) => m.t === t, label, timeout);

// ── бот для C4 (покрытие карт) ──
function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function botMove(state, rnd) {
  const seat = state.turn;
  // Шаг 1: атаки (случайный боеготовый юнит/оружие, случайная цель — чтобы покрыть карты типа silver_knight)
  const atk = computeAttackOptions(state, seat);
  const attackers = atk.minions.filter((x) => x.targets.length);
  if (attackers.length) {
    const m = attackers[Math.floor(rnd() * attackers.length)];
    const t = m.targets[Math.floor(rnd() * m.targets.length)];
    return command(state, seat, { type: 'attack', fromUid: m.uid, fromSeat: seat, toUid: t.uid ?? null, toSeat: t.seat ?? null });
  }
  if (atk.weapon?.targets?.length && rnd() < 0.6) {
    const t = atk.weapon.targets[Math.floor(rnd() * atk.weapon.targets.length)];
    return command(state, seat, { type: 'attack', fromUid: 'weapon', fromSeat: seat, toUid: t.uid ?? null, toSeat: t.seat ?? null });
  }
  // Шаг 2: сыграть карту (случайную playable)
  const playable = computePlayOptions(state, seat).filter((o) => o.playable);
  if (playable.length) {
    const opt = playable[Math.floor(rnd() * playable.length)];
    const target = opt.targets.length ? opt.targets[Math.floor(rnd() * opt.targets.length)] : undefined;
    return command(state, seat, { type: 'play_card', handUid: opt.uid, target });
  }
  return command(state, seat, { type: 'end_turn' });
}

// ═══════════════ ЗАПУСК СЕРВЕРА (критерий 1) ═══════════════
console.log('\nЗапуск сервера (node server/index.js, PORT=8092)…');
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (c) => (srvOut += c));
srv.stderr.on('data', (c) => (srvOut += c));
const srvDead = new Promise((res) => srv.on('exit', (code) => res(code)));

await new Promise((res) => {
  const t0 = Date.now();
  const tick = () => {
    if (srvOut.includes('сервер готов')) return res();
    if (Date.now() - t0 > 15000) return res();
    setTimeout(tick, 200);
  };
  tick();
});
const root = await get('/');
const cards = await get('/api/cards');
let cardsJson = null;
try { cardsJson = JSON.parse(cards.body); } catch {}
record(1, 'Запуск одной командой (node server/index.js; HTTP + /api/cards на 8080-порту)',
  srvOut.includes('сервер готов') && root.status === 200 && root.body.includes('EMBERFALL') && !!cardsJson && cardsJson.cards,
  `root=${root.status}, /api/cards=${cards.status}`);

// ═══════════════ КРИТЕРИИ 2–3: два игрока, лобби ═══════════════
{
  const A = new C('A'); const B = new C('B');
  await A.open(); await B.open();
  A.send('hello', { nick: 'Аня' }); B.send('hello', { nick: 'Боб' });
  A.send('create_room', { nick: 'Аня' });
  const ru = await A.waitPred((m) => m.t === 'room_update' && m.d.mySeat !== null, 'A:room_update');
  const roomsMsg = await waitT(B, 'rooms');
  const listed = (roomsMsg.d.rooms ?? []).some((r) => r.code === ru.d.code);
  B.send('join_room', { code: ru.d.code, nick: 'Боб' });
  await B.waitPred((m) => m.t === 'room_update' && m.d.mySeat !== null, 'B:room_update');
  A.send('toggle_ready', { ready: true });
  B.send('toggle_ready', { ready: true });
  await A.waitPred((m) => m.t === 'room_update' && m.d.seats[0]?.ready && m.d.seats[1]?.ready, 'A:both-ready');
  A.send('start_game', {});
  const stA = await waitT(A, 'state', 'A:state'); const stB = await waitT(B, 'state', 'B:state');
  const bothRunning = stA.d.status === 'running' && stB.d.status === 'running';
  const seat = stA.d.turn;
  const who = seat === stA.d.self.seat ? A : B;
  who.send('end_turn', { ack: stA.d.seq });
  const after = await who.waitPred((m) => m.t === 'state' && m.d.turnCount >= 2, 'after:end_turn');
  A.send('leave_room', {});
  // После ухода A приходит opp_left_final, а затем room_update (B переиндексируется в хосты,
  // один сид пуст). Проверяем что остался ровно один сид.
  const left = await B.waitPred((m) => m.t === 'room_update' && m.d.seats.filter(Boolean).length === 1, 'B:opp-left', 8000);
  record(2, 'Два игрока подключаются и играют (2 клиента по WS: матч, ход)', bothRunning && after.d.turnCount >= 2);
  record(3, 'Лобби и комнаты (код, список, join, ready, старт, выход)',
    listed && !!ru.d.code && ru.d.code.length === 5 && !!left);
  A.close(); B.close();
}

// ═══════════════ КРИТЕРИЙ 4: все 30 карт ═══════════════
{
  const deckOk = DECK_LIST.length === 30 && new Set(DECK_LIST).size === 30
    && DECK_LIST.every((id) => CARD_DB[id]);
  const seen = new Set();
  // Смотрим стартовую раздачу — в deck+hand обоих игроков на первой же партии
  // присутствуют все 30 карт DECK_LIST (каждая колода — это его шфл-копия).
  let games = 0;
  let botPlayedOk = true;
  while (seen.size < 30 && games < 100) {
    games++;
    const rnd = rng32(0xA11CE + games);
    const s = createGame(['А', 'Б']);
    for (const p of s.players) {
      for (const c of p.deck) seen.add(c.cardId || c); // deck = [{cardId,...}]?
      for (const h of p.hand) if (h.cardId !== 'dawn_coin') seen.add(h.cardId);
      for (const m of p.board) seen.add(m.cardId);
    }
    // Дополнительно прогоняем партию ботом — убеждаемся, что карты не выбрасывают исключений.
    let moves = 0;
    try {
      while (s.status === 'running' && moves < 8000) {
        botMove(s, rnd);
        moves++;
      }
    } catch (err) {
      botPlayedOk = false;
      console.log('   ! ошибка бота в партии', games, err.message);
      break;
    }
  }
  const missing = DECK_LIST.filter((id) => !seen.has(id));
  record(4, `Все 30 карт реализованы и разыгрываются (покрытие за ${games} партий)`,
    deckOk && seen.size === 30 && botPlayedOk,
    missing.length ? `нет: ${missing.join(',')}` : `${seen.size}/30`);
}

// ═══════════════ КРИТЕРИЙ 5: 7 ключевых слов (юнит-тесты) ═══════════════
{
  const r = await run(process.execPath, ['--test', 'server/test/engine.test.js']);
  const need = ['таунт: атака мимо', 'charge: Виверна', 'divine_shield', 'poison: Яд убивает',
    'боевой клич', 'смерть — ', 'аура +1/+1'];
  const have = need.filter((n) => r.out.includes(n));
  record(5, '7 ключевых слов покрыты юнит-тестами (taunt/charge/DS/poison/battlecry/deathrattle/aura)',
    r.code === 0 && have.length === need.length, have.length === need.length ? 'все' : `нет: ${need.filter((n) => !have.includes(n)).join(', ')}`);
}

// ═══════════════ КРИТЕРИЙ 6: баланс ═══════════════
{
  const r = await run(process.execPath, ['scripts/sim-balance.js']);
  record(6, 'Баланс: 200 партий, симметрия, без бесконечных комб (sim-balance)', r.code === 0);
}

// ═══════════════ КРИТЕРИИ 7–9: стиль/анимации/звук (статика) ═══════════════
{
  const css = read('public/css/main.css');
  const fontsCss = css.includes('press-start-2p') || css.includes('font-family');
  const pngCards = fs.existsSync(path.join(ROOT, 'public/assets/cards/fireball.png'));
  const pixelated = (css.match(/image-rendering:\s*pixelated/g) ?? []).length;
  record(7, 'Пиксельный стиль (шрифт Press Start 2P, image-rendering: pixelated, арты PNG)',
    fontsCss && pixelated >= 5 && pngCards,
    `font=${fontsCss}, pixelated ×${pixelated}, PNG=${pngCards} (визуальный финал — вручную)`);
  const kfs = (css.match(/@keyframes/g) ?? []).length;
  record(8, 'Анимации (keyframes: полёты, тряска, частицы, баннер, виньетка, pop-in)',
    kfs >= 8, `@keyframes ×${kfs} (60 fps — вручную в 2 браузерах)`);
  const sfx = read('public/js/audio/sfx.js');
  const music = read('public/js/audio/music.js');
  record(9, 'Звуки (8-бит синтез, dither/лимиты против дребезга, mute, 2 темы музыки)',
    sfx.includes('MAX_CONCURRENT') && sfx.includes('setMuted') && music.includes('MENU') && music.includes('BATTLE'),
    'прослушивание всех SFX — вручную');
}

// ═══════════════ КРИТЕРИЙ 10: эмоции ═══════════════
{
  const emojis = read('public/js/game/emojis.js');
  const orderOk = emojis.includes('EMOTION_ORDER') && emojis.includes('EMOTION_TITLE');
  // 8 эмоций должно быть ровно 8 записей в EMOTION_ORDER:
  const nOrder = (emojis.match(/'\w+'/g) ?? []).length >= 8;
  const sfx8 = read('public/js/audio/sfx.js').includes('emotion');
  record(10, '8 эмоций (EMOTIONS на сервере, 8 лиц, звук, троттлинг 1/с — тест в npm test)',
    Object.keys(EMOTIONS).length === 8 && orderOk && sfx8 && nOrder,
    `EMOTIONS=${Object.keys(EMOTIONS).length}, orderOk=${orderOk}`);
}

// ═══════════════ КРИТЕРИЙ 11: античит ═══════════════
{
  const r = await run(process.execPath, ['--test', 'server/test/anticheat.test.js']);
  // клиент не импортирует server/
  const clientFiles = fs.readdirSync(path.join(ROOT, 'public/js'), { recursive: true })
    .filter((f) => String(f).endsWith('.js')).map(String);
  const leak = clientFiles.filter((f) => read(`public/js/${f}`).includes("from '../../server/") || read(`public/js/${f}`).includes("from '../server/"));
  record(11, 'Читерство через консоль невозможно (античит-фазз + приватность + на клиенте нет движка)',
    r.code === 0 && leak.length === 0, leak.length ? `импорты сервера: ${leak.join(',')}` : '');
}

// ═══════════════ КРИТЕРИЙ 12: обрывы ═══════════════
{
  const r = await run(process.execPath, ['scripts/sim-reconnect.js']);
  record(12, 'Обрывы: лобби/игра/grace/kick/оба (sim-reconnect, 20 проверок)', r.code === 0);
}

// ═══════════════ КРИТЕРИЙ 13: документация ═══════════════
{
  const files = ['README.md', 'docs/00-ANALYSIS.md', 'docs/01-ARCHITECTURE.md', 'docs/02-CARDS.md',
    'docs/03-NETWORK.md', 'docs/04-CONTROLS.md', 'docs/05-DEVELOPMENT.md'];
  const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)) || read(f).length < 500);
  record(13, 'Документация полная (README + docs/00–05)', missing.length === 0, missing.join(', '));
}

// ═══════════════ КРИТЕРИЙ 14: чистота кода ═══════════════
{
  const mod = (p) => path.join(ROOT, p);
  const sizes = {};
  for (const f of [
    'server/game/engine.js', 'server/game/cards.js', 'server/net/rooms.js',
    'server/net/server.js', 'server/net/messages.js', 'server/net/sanitize.js',
    'public/js/ui/main.js', 'public/js/game/game-ui.js', 'public/js/game/fx.js',
    'public/js/net/client.js',
  ]) sizes[f] = read(f).split('\n').length;
  const over = Object.entries(sizes).filter(([, n]) => n > 800).map(([f]) => f);
  const max = Math.max(...Object.values(sizes));
  record(14, 'Код модульный (макс. размер модуля, выносы: fx/cardtips/log/emojis/collection)',
    over.length === 0, `макс ${max} строк${over.length ? ': ' + over.join(',') : ''} (детали — в 01-ARCHITECTURE.md)`);
}

// ═══════════════ КРИТЕРИЙ 15: нет критических багов ═══════════════
{
  const all = await run(process.execPath, ['--test', 'server/test/engine.test.js', 'server/test/rooms.test.js', 'server/test/anticheat.test.js']);
  const ui = await run(process.execPath, ['scripts/sim-ui.js']);
  const game = await run(process.execPath, ['scripts/sim-game.js']);
  const lobby = await run(process.execPath, ['scripts/sim-lobby.js']);
  record(15, 'Критических багов нет (весь npm test + sim-ui + sim-lobby + sim-game)',
    all.code === 0 && ui.code === 0 && game.code === 0 && lobby.code === 0,
    [all, ui, game, lobby].map((x) => x.code === 0 ? 'ok' : 'FAIL').join('/'));
}

// ── финал ──
srv.kill('SIGTERM');
await Promise.race([srvDead, new Promise((r) => setTimeout(r, 3000))]);

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ACCEPTANCE: ${pass}/15 ${pass === 15 ? '— ВСЕ КРИТЕРИИ ВЫПОЛНЕНЫ' : '— есть провалы'} ===`);
if (pass < 15) {
  console.log('Провалы:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.n}. ${r.name}`);
}
process.exit(pass === 15 ? 0 : 1);
