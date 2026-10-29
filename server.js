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
const TURN_MS = +process.env.TURN_MS || 7000;      // время на ход
const GAME_MS = +process.env.GAME_MS || 180000;    // длительность партии (3 минуты)
const EMOTES = ['67', '😂', '😎', '😡', '😭', '🔥', '👍', '🤯', '🥶', '💀', '🤡', '🎉'];
const cardPoints = (c) => (/^\d$/.test(c.value) ? Number(c.value) : c.color === 'wild' ? 50 : 20);
const FILES = { '/shuffle.mp3': 'audio/mpeg', '/deal.mp3': 'audio/mpeg', '/draw.mp3': 'audio/mpeg' };
const BOTS = [{ name: 'Макс (бот)', avatar: '🤖' }, { name: 'Нова (бот)', avatar: '👽' }, { name: 'Рекс (бот)', avatar: '🐲' }];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (FILES[url]) { // звуки (с поддержкой Range для Safari)
    const f = path.join(__dirname, url);
    return fs.stat(f, (err, st) => {
      if (err) { res.writeHead(404); return res.end(); }
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const head = { 'Content-Type': FILES[url], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
      if (m) {
        const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(f, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...head, 'Content-Length': st.size });
        fs.createReadStream(f).pipe(res);
      }
    });
  }
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
  armTurn(r);
}

function stopTimers(r) {
  clearTimeout(r.turnTimer); clearTimeout(r.gameTimer); clearTimeout(r.botTimer); clearTimeout(r.unoTimer);
}

function armTurn(r) { // 7 секунд на ход
  clearTimeout(r.turnTimer);
  r.turnEnd = Date.now() + TURN_MS;
  r.turnTimer = setTimeout(() => autoPlay(r), TURN_MS);
}

function autoPlay(r) { // время вышло: случайная подходящая карта, а если таких нет — добор
  if (!r.started || r.winner) return;
  const p = r.players[r.turn], top = r.discard[r.discard.length - 1], seq = r.seq;
  const ok = p.hand.filter((c) => c.color === 'wild' || c.color === r.color || c.value === top.value);
  if (ok.length) playCard(r, p, ok[Math.floor(Math.random() * ok.length)].id, COLORS[Math.floor(Math.random() * 4)]);
  if (r.seq === seq) drawAndPass(r, p);
  r.log = `${p.name}: время вышло. ` + r.log;
  broadcast(r);
}

function finish(r, reason, out) { // конец партии + подсчёт очков
  stopTimers(r);
  const team = r.mode === '2v2';
  r.endReason = reason;
  r.scores = r.players.map((p, k) => ({ id: p.id, name: p.name, avatar: p.avatar, cards: p.hand.length, team: team ? k % 2 : null, points: p.hand.reduce((a, c) => a + cardPoints(c), 0) }));
  r.teamScores = team ? [0, 1].map((t) => r.scores.filter((x) => x.team === t).reduce((a, x) => a + x.points, 0)) : null;
  let ids;
  if (reason === 'out') {
    const i = r.players.indexOf(out);
    ids = r.players.filter((_, k) => (team ? k % 2 === i % 2 : k === i)).map((p) => p.id);
  } else if (team) {
    const [a, b] = r.teamScores;
    ids = a === b ? r.players.map((p) => p.id) : r.players.filter((_, k) => k % 2 === (a < b ? 0 : 1)).map((p) => p.id);
    r.tie = a === b;
  } else {
    const min = Math.min(...r.scores.map((x) => x.points));
    ids = r.scores.filter((x) => x.points === min).map((x) => x.id);
    r.tie = ids.length > 1;
  }
  if (reason === 'out') r.tie = false;
  r.winnerIds = ids;
  const names = r.players.filter((p) => ids.includes(p.id)).map((p) => p.name).join(' и ');
  r.winner = r.tie ? 'Ничья' : team ? `Команда ${r.players.findIndex((p) => p.id === ids[0]) % 2 + 1}: ${names}` : names;
  r.unoPending = null;
}

function callUno(r, p) { // нажали «УНО»: хозяин — спасён, другой игрок — ловит
  const u = r.unoPending;
  if (!u || !r.started || r.winner) return;
  const owner = r.players.find((q) => q.id === u.id);
  clearTimeout(r.unoTimer);
  r.unoPending = null; r.seq++; r.lastId = p.id;
  if (p === owner) { r.lastAct = 'uno'; r.log = `${p.name}: УНО!`; emote(r, p, 'УНО!'); }
  else {
    drawCards(r, owner, 2);
    r.lastAct = 'catch';
    r.log = `${p.name} поймал(а) ${owner.name} без УНО — +2 карты!`;
    emote(r, p, 'Поймал!');
  }
}

function emote(r, p, text) {
  for (const q of r.players) send(q.ws, { type: 'emote', from: p.id, text });
}

function scheduleUno(r) { // боты: сами говорят УНО и ловят людей, которые забыли
  const u = r.unoPending;
  if (!u || u.sched || !r.started || r.winner) return;
  u.sched = true;
  const owner = r.players.find((q) => q.id === u.id), oi = r.players.indexOf(owner);
  let who, delay;
  if (owner.isBot) { who = owner; delay = 500 + Math.random() * 800; }
  else {
    const catchers = r.players.filter((q, k) => q.isBot && !(r.mode === '2v2' && k % 2 === oi % 2));
    if (!catchers.length) return;
    who = catchers[Math.floor(Math.random() * catchers.length)];
    delay = 2300 + Math.random() * 900;
  }
  r.unoTimer = setTimeout(() => { if (r.unoPending === u) { callUno(r, who); broadcast(r); } }, delay);
}

function startGame(r) {
  r.deck = makeDeck();
  r.discard = [];
  r.dir = 1;
  r.winner = null;
  r.winnerIds = [];
  r.lacks = {};
  r.players.forEach((p) => { p.hand = []; drawCards(r, p, 7); });
  let c;
  while (!/^\d$/.test((c = r.deck.pop()).value)) r.deck.unshift(c); // стартовая карта — число
  r.discard = [c];
  r.color = c.color;
  r.turn = Math.floor(Math.random() * r.players.length);
  r.started = true;
  r.log = 'Игра началась!';
  r.scores = null; r.teamScores = null; r.tie = false; r.unoPending = null;
  r.gameEnd = Date.now() + GAME_MS;
  clearTimeout(r.gameTimer);
  r.gameTimer = setTimeout(() => { if (r.started && !r.winner) { finish(r, 'time'); broadcast(r); } }, GAME_MS);
  armTurn(r);
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
  r.unoPending = null; clearTimeout(r.unoTimer);

  p.hand.splice(i, 1);
  r.discard.push(c);
  r.seq++; r.lastId = p.id; r.lastAct = 'play';
  if (c.color !== 'wild' && r.lacks[p.id]) r.lacks[p.id].delete(c.color);
  r.color = c.color === 'wild' ? chosen : c.color;
  r.log = `${p.name} сыграл(а) ${c.value}`;

  if (!p.hand.length) {
    r.log = `${p.name} выложил(а) последнюю карту!`;
    finish(r, 'out', p);
    return;
  }
  if (p.hand.length === 1) { r.unoPending = { id: p.id }; r.log += ' — осталась 1 карта!'; }

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
  r.unoPending = null; clearTimeout(r.unoTimer);
  drawCards(r, p, 1);
  r.seq++; r.lastId = p.id; r.lastAct = 'draw';
  (r.lacks[p.id] = r.lacks[p.id] || new Set()).add(r.color); // он не смог сыграть этот цвет
  r.log = `${p.name} берёт карту`;
  advance(r, 1);
}

// ---------- Сеть ----------
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
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
      gameLeft: r.started && r.gameEnd ? Math.max(0, r.gameEnd - Date.now()) : null,
      turnLeft: r.started && !r.winner && r.turnEnd ? Math.max(0, r.turnEnd - Date.now()) : null,
      uno: r.unoPending ? r.unoPending.id : null,
      scores: r.scores,
      teamScores: r.teamScores,
      endReason: r.endReason,
      tie: r.tie,
      players: r.players.map((q, k) => ({ id: q.id, name: q.name, avatar: q.avatar, count: q.hand.length, team: r.mode === '2v2' ? k % 2 : null })),
    });
  }
  scheduleBot(r);
  scheduleUno(r);
}

// ---------- Бот ----------
// Бот видит только то, что видит игрок: свои карты, число карт у других и стол.
// Тактика: копит джокеры, бьёт «+2/+4/пропуск» по тем, кто близок к победе, не бьёт по напарнику,
// держит сильный цвет и запоминает, какого цвета нет у следующего игрока (он брал карту на этот цвет).
function addBot(r) {
  const used = r.players.map((p) => p.name);
  const b = BOTS.find((x) => !used.includes(x.name)) || BOTS[0];
  r.players.push({ id: nextId++, name: b.name, avatar: b.avatar, ws: null, isBot: true, hand: [] });
}

function fillBots(r) {
  while (r.players.length < r.need) addBot(r);
}

function botMove(r, b) {
  const top = r.discard[r.discard.length - 1];
  const n = r.players.length, bi = r.players.indexOf(b);
  const nextP = r.players[(((bi + r.dir) % n) + n) % n];
  const mate = r.mode === '2v2' ? r.players[(bi + 2) % 4] : null;
  const playable = b.hand.filter((c) => c.color === 'wild' || c.color === r.color || c.value === top.value);
  if (!playable.length) return {};
  const cnt = { red: 0, yellow: 0, green: 0, blue: 0 };
  b.hand.forEach((c) => { if (c.color !== 'wild') cnt[c.color]++; });
  const toMate = nextP === mate;
  const lacks = toMate ? new Set() : (r.lacks[nextP.id] || new Set());
  const threat = !toMate && nextP.hand.length <= 2;

  const pickColor = () => {
    let bc = COLORS[0], bs = -1;
    for (const col of COLORS) {
      const s = cnt[col] * 2 + (lacks.has(col) ? 3 : 0) + Math.random();
      if (s > bs) { bs = s; bc = col; }
    }
    return bc;
  };

  let best = null, bestScore = -1e9;
  for (const c of playable) {
    const wild = c.color === 'wild';
    const res = wild ? pickColor() : c.color;
    let s = Math.random() * 0.3;
    if (b.hand.length === 1) s += 1000;                       // последняя карта — выигрыш
    if (/^\d$/.test(c.value)) s += Number(c.value) * 0.3;     // сначала сбрасываем «тяжёлые» числа
    s += cnt[res] * 0.5;                                      // держим свой сильный цвет
    if (lacks.has(res)) s += 2;                               // следующему такой цвет не нужен — он возьмёт карту
    const hit = c.value === 'skip' || c.value === '+2' || c.value === '+4';
    if (c.value === 'skip' || c.value === '+2') s += 2;
    if (hit && toMate) s -= 8;                                // не бьём напарника
    if (hit && threat) s += 9;                                // останавливаем того, кто почти выиграл
    if (c.value === 'reverse') s += n === 2 ? (threat ? 9 : 2) : (threat ? 5 : 1);
    if (wild) {
      s -= c.value === '+4' ? 8 : 6;                          // джокеры копим
      if (b.hand.length <= 2) s += 5;
      if (c.value === '+4' && threat) s += 6;
    }
    if (s > bestScore) { bestScore = s; best = { card: c, color: wild ? res : undefined }; }
  }
  return best;
}

function scheduleBot(r) {
  clearTimeout(r.botTimer);
  if (!r.started || r.winner) return;
  const b = r.players[r.turn];
  if (!b || !b.isBot) return;
  const pend = r.unoPending && r.players.find((q) => q.id === r.unoPending.id);
  const delay = pend && !pend.isBot ? 3500 + Math.random() * 600 : 900 + Math.random() * 900; // человеку даём время нажать УНО
  r.botTimer = setTimeout(() => {
    if (!r.started || r.winner || r.players[r.turn] !== b) return;
    const seq = r.seq, mv = botMove(r, b);
    if (mv.card) playCard(r, b, mv.card.id, mv.color);
    if (r.seq === seq) drawAndPass(r, b);
    broadcast(r);
  }, delay);
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
  if (!r.players.some((p) => !p.isBot)) { stopTimers(r); delete rooms[r.code]; return; }
  if (r.hostId === gone.id) r.hostId = r.players.find((p) => !p.isBot).id;
  if (r.started) stopTimers(r);
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

    if (m.type === 'create' || m.type === 'join' || m.type === 'solo') {
      if (ws.room) return;
      let r;
      if (m.type !== 'join') {
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
      if (m.type === 'solo') { fillBots(r); startGame(r); }
      return broadcast(r);
    }

    const r = ws.room;
    if (!r) return;
    const p = r.players.find((q) => q.ws === ws);

    if (m.type === 'start' && r.hostId === p.id && !r.started) {
      if (r.players.length !== r.need) return send(ws, { type: 'error', text: `Для этого режима нужно игроков: ${r.need}` });
      startGame(r);
    } else if (m.type === 'addbot' && r.hostId === p.id && !r.started && r.players.length < r.need) {
      addBot(r);
    } else if (m.type === 'uno') {
      callUno(r, p);
    } else if (m.type === 'emote') {
      const t = EMOTES[m.i];
      if (!t || Date.now() - (p.lastEmote || 0) < 1200) return;
      p.lastEmote = Date.now();
      return emote(r, p, t);
    } else if (m.type === 'play') {
      playCard(r, p, m.cardId, m.color);
    } else if (m.type === 'draw') {
      drawAndPass(r, p);
    } else if (m.type === 'again' && r.hostId === p.id && r.winner) {
      stopTimers(r); r.started = false; r.winner = null; r.scores = null; r.log = 'Новая партия';
      r.players.forEach((q) => (q.hand = []));
      r.discard = [];
    } else return;
    broadcast(r);
  });

  ws.on('close', () => leave(ws));
});

setInterval(() => wss.clients.forEach((c) => c.readyState === 1 && c.ping()), 25000); // не даём соединению засыпать
server.listen(PORT, () => console.log(`UNO: http://localhost:${PORT}`));
