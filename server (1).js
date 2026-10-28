const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const COLORS = ['red', 'yellow', 'green', 'blue'];
const rooms = {};
let nextId = 1;
const AVATARS = ['🦊','🐼','🐯','🦁','🐸','🐵','🦄','🐙','🦉','🐲','🤖','👽'];
const MODES = { '1v1': 2, '2v2': 4, ffa: 4 };

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

// ---------- Колода и правила ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  const d = [];
  let id = 0;
  for (const c of COLORS) {
    d.push({ id: id++, color: c, value: '0' });
    for (let n = 1; n <= 9; n++) for (let k = 0; k < 2; k++) d.push({ id: id++, color: c, value: String(n) });
    for (const v of ['skip', 'reverse', '+2']) for (let k = 0; k < 2; k++) d.push({ id: id++, color: c, value: v });
  }
  for (let k = 0; k < 4; k++) {
    d.push({ id: id++, color: 'wild', value: 'wild' });
    d.push({ id: id++, color: 'wild', value: '+4' });
  }
  return shuffle(d);
}

function drawCards(r, p, n) {
  for (let i = 0; i < n; i++) {
    if (!r.deck.length) {
      const top = r.discard.pop();
      r.deck = shuffle(r.discard.splice(0));
      r.discard = [top];
      if (!r.deck.length) return;
    }
    p.hand.push(r.deck.pop());
  }
}

function advance(r, steps) {
  const n = r.players.length;
  r.turn = (((r.turn + r.dir * steps) % n) + n) % n;
}

function startGame(r) {
  r.deck = makeDeck();
  r.discard = [];
  r.dir = 1;
  r.winner = null;
  r.winnerIds = [];
  r.players.forEach((p) => { p.hand = []; drawCards(r, p, 7); });
  let c;
  while (!/^\d$/.test((c = r.deck.pop()).value)) r.deck.unshift(c); // стартовая карта — число
  r.discard = [c];
  r.color = c.color;
  r.turn = Math.floor(Math.random() * r.players.length);
  r.started = true;
  r.log = 'Игра началась!';
}

function playCard(r, p, cardId, chosen) {
  if (!r.started || r.winner || r.players[r.turn] !== p) return;
  const i = p.hand.findIndex((c) => c.id === cardId);
  if (i < 0) return;
  const c = p.hand[i];
  const top = r.discard[r.discard.length - 1];
  const ok = c.color === 'wild' || c.color === r.color || c.value === top.value;
  if (!ok) return;
  if (c.color === 'wild' && !COLORS.includes(chosen)) return;

  p.hand.splice(i, 1);
  r.discard.push(c);
  r.seq++; r.lastId = p.id; r.lastAct = 'play';
  r.color = c.color === 'wild' ? chosen : c.color;
  r.log = `${p.name} сыграл(а) ${c.value}`;

  if (!p.hand.length) {
    const idx = r.players.indexOf(p);
    if (r.mode === '2v2') {
      const team = r.players.filter((_, k) => k % 2 === idx % 2);
      r.winnerIds = team.map((q) => q.id);
      r.winner = `Команда ${(idx % 2) + 1}: ` + team.map((q) => q.name).join(' и ');
    } else {
      r.winnerIds = [p.id];
      r.winner = p.name;
    }
    r.log = `${p.name} выложил(а) последнюю карту!`;
    return;
  }
  if (p.hand.length === 1) r.log += ' — УНО!';

  const n = r.players.length;
  if (c.value === 'reverse') {
    r.dir *= -1;
    advance(r, n === 2 ? 0 : 1); // вдвоём реверс = пропуск хода
  } else if (c.value === 'skip') {
    advance(r, 2);
  } else if (c.value === '+2' || c.value === '+4') {
    const victim = r.players[(((r.turn + r.dir) % n) + n) % n];
    drawCards(r, victim, c.value === '+2' ? 2 : 4);
    r.log += ` — ${victim.name} берёт ${c.value === '+2' ? 2 : 4}`;
    advance(r, 2);
  } else {
    advance(r, 1);
  }
}

function drawAndPass(r, p) {
  if (!r.started || r.winner || r.players[r.turn] !== p) return;
  drawCards(r, p, 1);
  r.seq++; r.lastId = p.id; r.lastAct = 'draw';
  r.log = `${p.name} берёт карту`;
  advance(r, 1);
}

// ---------- Сеть ----------
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(r) {
  for (const p of r.players) {
    send(p.ws, {
      type: 'state',
      code: r.code,
      you: p.id,
      isHost: r.hostId === p.id,
      started: r.started,
      hand: p.hand,
      top: r.discard[r.discard.length - 1] || null,
      color: r.color,
      turn: r.started ? r.players[r.turn].id : null,
      dir: r.dir,
      winner: r.winner,
      log: r.log,
      deckLeft: r.deck.length,
      mode: r.mode,
      need: r.need,
      winnerIds: r.winnerIds,
      seq: r.seq,
      lastId: r.lastId,
      lastAct: r.lastAct,
      players: r.players.map((q, k) => ({ id: q.id, name: q.name, avatar: q.avatar, count: q.hand.length, team: r.mode === '2v2' ? k % 2 : null })),
    });
  }
}

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  } while (rooms[code]);
  return code;
}

function leave(ws) {
  const r = ws.room;
  if (!r) return;
  const idx = r.players.findIndex((p) => p.ws === ws);
  if (idx < 0) return;
  const [gone] = r.players.splice(idx, 1);
  ws.room = null;
  if (!r.players.length) { delete rooms[r.code]; return; }
  if (r.hostId === gone.id) r.hostId = r.players[0].id;
  if (r.started) { // для простоты: выход игрока сбрасывает партию в лобби
    r.started = false;
    r.winner = null;
    r.players.forEach((p) => (p.hand = []));
    r.discard = [];
    r.log = `${gone.name} вышел(ла). Партия сброшена.`;
  } else {
    r.log = `${gone.name} вышел(ла)`;
  }
  broadcast(r);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const name = String(m.name || '').trim().slice(0, 16) || 'Игрок';

    if (m.type === 'create' || m.type === 'join') {
      if (ws.room) return;
      let r;
      if (m.type === 'create') {
        const mode = MODES[m.mode] ? m.mode : '1v1';
        r = { code: newCode(), mode, need: MODES[mode], seq: 0, lastId: null, lastAct: null, players: [], hostId: null, started: false, deck: [], discard: [], turn: 0, dir: 1, color: null, winner: null, winnerIds: [], log: '' };
        rooms[r.code] = r;
      } else {
        r = rooms[String(m.code || '').toUpperCase().trim()];
        if (!r) return send(ws, { type: 'error', text: 'Комната не найдена' });
        if (r.started) return send(ws, { type: 'error', text: 'Игра уже идёт' });
        if (r.players.length >= r.need) return send(ws, { type: 'error', text: 'Комната заполнена' });
      }
      const p = { id: nextId++, name, avatar: AVATARS.includes(m.avatar) ? m.avatar : AVATARS[0], ws, hand: [] };
      r.players.push(p);
      if (!r.hostId) r.hostId = p.id;
      ws.room = r;
      r.log = `${name} в комнате`;
      return broadcast(r);
    }

    const r = ws.room;
    if (!r) return;
    const p = r.players.find((q) => q.ws === ws);

    if (m.type === 'start' && r.hostId === p.id && !r.started) {
      if (r.players.length !== r.need) return send(ws, { type: 'error', text: `Для этого режима нужно игроков: ${r.need}` });
      startGame(r);
    } else if (m.type === 'play') {
      playCard(r, p, m.cardId, m.color);
    } else if (m.type === 'draw') {
      drawAndPass(r, p);
    } else if (m.type === 'again' && r.hostId === p.id && r.winner) {
      r.started = false; r.winner = null; r.log = 'Новая партия';
      r.players.forEach((q) => (q.hand = []));
      r.discard = [];
    } else return;
    broadcast(r);
  });

  ws.on('close', () => leave(ws));
});

setInterval(() => wss.clients.forEach((c) => c.readyState === 1 && c.ping()), 25000); // не даём соединению засыпать
server.listen(PORT, () => console.log(`UNO: http://localhost:${PORT}`));
