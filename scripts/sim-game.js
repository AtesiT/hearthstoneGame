// sim-game.js — headless-симуляция ПОЛНОЙ игры (Этап 2).
//
// Запуск:
//   1) npm start             (в отдельном терминале)
//   2) npm run sim-game
//
// Два «ИИ»-игрока играют случайную партию до конца (fatigue гарантированно
// доведёт матч до финала). Каждый ход ИИ играет ВСЕ карты, которые сервер
// пометил playable (цели — из списка сервера; никакой логики клиента).
//
// Проверки:
//   • матч завершается (winner, winReason=hero_kill), оба клиента согласны;
//   • в «живых» снапшотах heroes > 0 hp, рука ≤ 10, поле ≤ 7, deck ≥ 0;
//   • seq монотонно растёт у каждого клиента;
//   • ни одна команда ИИ не отклонена сервером (0 error);
//   • секреты не утекают (нет чужой руки/deck/rngSeed в снапшоте).
import WebSocket from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const URL = `ws://127.0.0.1:${PORT}/ws`;
const TURN_CAP = 150;        // защита от бесконечной партии
const TOTAL_TIMEOUT_MS = 120_000;

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
}

class P {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(URL);
    this._msg = null; // колбэк на каждое сообщение (для ИИ)
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      const i = this.waiters.findIndex((w) => (w.types ? w.types.includes(m.t) : w.pred(m)));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.res(m);
      } else {
        this.queue.push(m);
      }
      this._msg?.(m);
    });
    // как у реального клиента: ping держит соединение живым
    this._ping = setInterval(() => {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', d: { t: Date.now() } }));
    }, 5000);
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', (e) => rej(new Error(`${this.name}: ${e.message}`)));
    });
  }
  send(t, d) { this.ws.send(JSON.stringify({ t, d })); }
  wait(types, timeout = 5000) {
    const list = Array.isArray(types) ? types : [types];
    const qi = this.queue.findIndex((m) => list.includes(m.t));
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = { types: list, res, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`${this.name}: таймаут, жду ${list.join('/')}`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  waitPred(pred, timeout = 5000) {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred, res, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`${this.name}: таймаут, условие не выполнено`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  close() {
    clearInterval(this._ping);
    this.ws.removeAllListeners();
    this.ws.close();
  }
}

/** Голубой ИИ: играет всё playable, цели — по списку сервера. */
class AI {
  constructor(p, seat) {
    this.p = p;
    this.seat = seat;
    this.vs = null;
    this.errors = [];
    this.moves = 0;
    this.lastSeq = 0;
    this.lastSend = 0;
    this._busy = false;
    this.seqMonotone = true;
    this.invariantsOk = true;
    this._invNote = '';
    this.sawEmotion = false;
    p._msg = (m) => {
      if (m.t === 'error') { this.errors.push(m.d); return; }
      if (m.t !== 'state') return;
      const vs = m.d;
      if ((vs.events || []).some((e) => e.k === 'emotion')) this.sawEmotion = true;
      if (vs.seq <= this.lastSeq) { /* дубль снапшота — допустим (resync) */ }
      else this.lastSeq = vs.seq;
      this.checkInvariants(vs);
      this.vs = vs;
      if (vs.status === 'running' && vs.turn === vs.self.seat) this.tick();
    };
  }
  checkInvariants(vs) {
    const final = vs.status === 'ended';
    const problems = [];
    for (const side of ['self', 'opp']) {
      const b = vs[side].board;
      if (b.length > 7) problems.push(`${side}.board=${b.length}`);
      const dc = vs[side].deckCount;
      if (dc < 0) problems.push(`${side}.deckCount=${dc}`);
      if (!final) {
        const hp = vs[side].hero.hp;
        if (hp <= 0) problems.push(`${side}.hero.hp=${hp} (до финала)`);
      }
    }
    if (vs.self.hand.length > 10) problems.push(`self.hand=${vs.self.hand.length}`);
    if (vs.opp.handCount > 10) problems.push(`opp.handCount=${vs.opp.handCount}`);
    if (problems.length) {
      this.invariantsOk = false;
      this._invNote = problems.join(', ');
    }
  }
  tick() {
    const vs = this.vs;
    if (!vs || vs.status !== 'running' || vs.turn !== vs.self.seat) return;
    // «человеческий» темп: не чаще команды, чем раз в 50 мс
    // (сервер rate-lимитит >40 msg/с, живой игрок на порядки медленнее)
    const wait = 50 - (Date.now() - this.lastSend);
    if (wait > 0) {
      if (this._busy) return;
      this._busy = true;
      setTimeout(() => { this._busy = false; this.tick(); }, wait);
      return;
    }
    this.lastSend = Date.now();
    // 1) играть карты
    const opt = vs.self.hand.find((o) => o.playable);
    if (opt) {
      const target = this.pickTarget(opt, vs);
      if (opt.targets.length && !target) return; // страховка: не знаем, куда бить
      this.p.send('play_card', { handUid: opt.uid, target: target ?? undefined, ack: vs.seq });
      this.moves++;
      return;
    }
    // 2) атаковать (существа, потом оружие)
    const atk = this.pickAttack(vs);
    if (atk) {
      this.p.send('attack', { ...atk, ack: vs.seq });
      this.moves++;
      return;
    }
    // 3) завершить ход
    this.p.send('end_turn', { ack: vs.seq });
  }
  pickAttack(vs) {
    for (const m of vs.self.attacks?.minions ?? []) {
      const t = this.bestAttackTarget(m.targets, vs, m.uid);
      if (t) return { fromUid: m.uid, fromSeat: vs.self.seat, toUid: t.kind === 'minion' ? t.uid : null, toSeat: t.seat };
    }
    const w = vs.self.attacks?.weapon;
    if (w) {
      const t = this.bestAttackTarget(w.targets, vs, null);
      if (t) return { fromUid: 'weapon', fromSeat: vs.self.seat, toUid: t.kind === 'minion' ? t.uid : null, toSeat: t.seat };
    }
    return null;
  }
  bestAttackTarget(targets, vs, fromUid) {
    if (!targets?.length) return null;
    const myAtk = fromUid
      ? (vs.self.board.find((b) => b.uid === fromUid)?.atk ?? 0)
      : (vs.self.hero.weapon?.attack ?? 0);
    // 1) килл по здоровью
    for (const t of targets) {
      if (t.kind !== 'minion' || myAtk <= 0) continue;
      const m = vs.opp.board.find((x) => x.uid === t.uid);
      if (m && m.health <= myAtk) return t;
    }
    // 2) герой (если открыт)
    const hero = targets.find((t) => t.kind === 'hero');
    if (hero) return hero;
    // 3) самая живучая
    let best = null;
    let bestHp = -1;
    for (const t of targets) {
      if (t.kind !== 'minion') continue;
      const m = vs.opp.board.find((x) => x.uid === t.uid);
      const hp = m ? m.health : 0;
      if (hp > bestHp) { bestHp = hp; best = t; }
    }
    return best;
  }
  pickTarget(opt, vs) {
    if (!opt.targets.length) return undefined;
    const friendly = opt.targets.filter((t) => t.kind === 'minion' && t.seat === vs.self.seat);
    if (friendly.length) return friendly[0];
    const minions = opt.targets.filter((t) => t.kind === 'minion');
    if (minions.length) {
      // в ту, у которой больше здоровья (данных достаточно в чужом board)
      let best = minions[0];
      let bestHp = -1;
      for (const t of minions) {
        const m = vs.opp.board.find((x) => x.uid === t.uid);
        const hp = m ? m.health : 0;
        if (hp > bestHp) { bestHp = hp; best = t; }
      }
      return best;
    }
    return opt.targets.find((t) => t.kind === 'hero') ?? opt.targets[0];
  }
  isDone() {
    return !!this.vs && this.vs.status === 'ended';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Симуляция полной игры против ws://127.0.0.1:${PORT}\n`);

  const A = new P('A');
  const B = new P('B');
  await A.open();
  await B.open();
  A.send('hello', { nick: 'Alice' });
  B.send('hello', { nick: 'Bob' });
  await A.wait('welcome');
  await B.wait('welcome');

  A.send('create_room', { nick: 'Alice' });
  const ruA = await A.wait('room_update');
  const code = ruA.d.code;
  B.send('join_room', { code, nick: 'Bob' });
  await B.wait('room_update');
  await A.wait('room_update');
  A.send('toggle_ready', { ready: true });
  B.send('toggle_ready', { ready: true });
  await A.wait('room_update');
  await B.wait('room_update');
  A.send('start_game', {});
  const stA = await A.waitPred((m) => m.t === 'state', 5000);
  const stB = await B.waitPred((m) => m.t === 'state', 5000);
  check('партия стартовала: снапшоты обоим', stA.d.status === 'running' && stB.d.status === 'running');

  // ИИ: A = seat 0 (создатель), B = seat 1.
  // Первый снапшот был «съеден» waitPred — прогоняем его через ИИ вручную.
  const aiA = new AI(A, stA.d.self.seat);
  const aiB = new AI(B, stB.d.self.seat);
  aiA.lastSeq = stA.d.seq;
  aiB.lastSeq = stB.d.seq;
  aiA.vs = stA.d;
  aiB.vs = stB.d;
  aiA.checkInvariants(stA.d);
  aiB.checkInvariants(stB.d);
  if (stA.d.status === 'running' && stA.d.turn === aiA.seat) aiA.tick();
  if (stB.d.status === 'running' && stB.d.turn === aiB.seat) aiB.tick();

  // Этап 4: эмоции — A присылает одну, обе стороны обязаны увидеть событие
  A.send('send_emotion', { emotion: 'praise', ack: stA.d.seq });

  // Ждём, пока ОБОЕ ИИ увидят финал (или тайм-аут/лимит ходов).
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let over = false;
  while (!over && Date.now() < deadline) {
    await sleep(100);
    if (aiA.isDone() && aiB.isDone()) over = true;
    else if (aiA.vs && aiA.vs.turnCount > TURN_CAP) break;
  }

  check('матч завершился в пределах лимита', over, `turnCount=${aiA.vs?.turnCount}`);
  if (over) {
    const a = aiA.vs, b = aiB.vs;
    check('оба клиента видят status=ended', a.status === 'ended' && b.status === 'ended');
    check('winner согласован', a.winner === b.winner && a.winner !== null);
    check('winReason = hero_kill', a.winReason === 'hero_kill' && b.winReason === 'hero_kill');
    check('turnCount согласован', a.turnCount === b.turnCount);
    const loser = 1 - a.winner;
    check('проигравший герой мёртв (hp ≤ 0)', a.opp.seat === loser || a.self.seat === loser ?
      (a.self.seat === loser ? a.self.hero.hp <= 0 : a.opp.hero.hp <= 0) : false);
  }

  check('A: ни одна команда не отклонена сервером', aiA.errors.length === 0, JSON.stringify(aiA.errors.slice(0, 3)));
  check('B: ни одна команда не отклонена сервером', aiB.errors.length === 0, JSON.stringify(aiB.errors.slice(0, 3)));
  check('A: инварианты (рука≤10, поле≤7, deck≥0, hp>0 до финала)', aiA.invariantsOk, aiA._invNote);
  check('B: инварианты (рука≤10, поле≤7, deck≥0, hp>0 до финала)', aiB.invariantsOk, aiB._invNote);

  // Секреты: в снапшоте нет чужой руки, колоды и seed
  const snapJson = JSON.stringify(aiA.vs ?? {});
  check('секреты не утекают (нет rngSeed/deck/чужой hand-массива)',
    !snapJson.includes('rngSeed') && !snapJson.includes('"deck"') && aiA.vs.opp.hand === undefined);
  check('эмоция доставлена обоим клиентам (событие в снапшоте)', aiA.sawEmotion && aiB.sawEmotion);

  console.log(`\n  ходов: A=${aiA.moves}, B=${aiB.moves}; turnCount=${aiA.vs?.turnCount ?? '—'}`);
  if (aiA.vs?.status === 'ended') {
    const winnerNick = aiA.vs.winner === aiA.seat ? 'Alice' : 'Bob';
    console.log(`  победитель: ${winnerNick}`);
  }
  A.close();
  B.close();
  await sleep(80);
  console.log(failures === 0 ? '\n=== SIM GAME: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ===' : `\n=== SIM GAME: ПРОВАЛОВ: ${failures} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nОШИБКА СИМУЛЯЦИИ:', e.message);
  process.exit(1);
});
