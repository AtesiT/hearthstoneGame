// AI self-play sanity test: подключаемся к запущенному серверу на PORT, запускаем матч против ИИ.
// Запуск: PORT=8092 node scripts/sim-ai.js
import WebSocket from 'ws';
const PORT = Number(process.env.PORT ?? 8080);
const URL = `ws://127.0.0.1:${PORT}/ws`;

class C {
  constructor() {
    this.vs = null; this.done = false; this.errors=[]; this.moves=0; this.lastSeq=-1;
    this.ws = new WebSocket(URL);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'error') this.errors.push(m.d);
      if (m.t === 'state') {
        this.vs = m.d;
        if (this.vs.status === 'ended') { if (!this.done) { this.done = true; this.after(); } return; }
        if (this.vs.turn === 0 && this.vs.seq > this.lastSeq) setTimeout(() => this.doMove(), 60);
      }
      if (m.t === 'room_update' && m.d.phase === 'game') {
        // ОК — ждём state
      }
    });
  }
  connect(nick) {
    return new Promise((res) => {
      this.ws.on('open', () => { this.send('hello',{nick}); res(); });
    });
  }
  send(t, d) { this.ws.send(JSON.stringify({t,d})); }
  doMove() {
    const vs = this.vs;
    if (!vs || vs.status !== 'running' || vs.turn !== 0) return;
    this.lastSeq = vs.seq;
    const o = vs.self.hand.find((x) => x.playable);
    if (o) { this.send('play_card', {handUid:o.uid, target:o.targets?.[0], ack:vs.seq}); this.moves++; return; }
    const ms = (vs.self.attacks?.minions ?? [])[0];
    if (ms) { const t = ms.targets[0]; this.send('attack', {fromUid:ms.uid, fromSeat:0, toUid:t.kind==='minion'?t.uid:null, toSeat:t.seat, ack:vs.seq}); this.moves++; return; }
    const w = vs.self.attacks?.weapon;
    if (w) { const t=w.targets[0]; this.send('attack', {fromUid:'weapon',fromSeat:0,toUid:t.kind==='minion'?t.uid:null,toSeat:t.seat,ack:vs.seq}); this.moves++; return; }
    this.send('end_turn', {ack:vs.seq}); this.moves++;
  }
  after() {
    const vs = this.vs;
    console.log('статус:', vs.status, '| победитель:', vs.winner===0 ? 'Алиса (вы)' : vs.winner===1 ? 'Ярополк (ИИ)' : '???', '| ходов:', vs.turnCount);
    console.log('ходов Алисы:', this.moves);
    console.log('противник:', vs.opp.nick);
    console.log('ошибки:', this.errors.length ? this.errors : 'нет');
    const ok = vs.status==='ended' && vs.winner!==null && !this.errors.length && vs.opp.nick.includes('Ярополк');
    console.log(ok ? 'PASS: ИИ играет полную партию' : 'FAIL');
    try{this.ws.close();}catch{}
    process.exit(ok?0:1);
  }
}

const c = new C();
await c.connect('Alice');
c.send('start_ai_game', {nick:'Alice'});
setTimeout(()=>{ console.log('FAIL: таймаут 90с'); try{c.ws.close();}catch{} process.exit(1); }, 90000);
