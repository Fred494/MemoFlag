const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const SIM = require('./data/similar.json'); // { codigo: [codigos semelhantes] } — nunca contém nomes
const ALL = Object.keys(SIM);

const MAX_PLAYERS = 8;
const MAX_PICKS = 5;
const IDENTIFY_MS = 40000;
const MEMO_COUNT = 10;
const PRELOAD_MAX_MS = 7000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, file) => {
    // bandeiras podem ficar em cache; HTML/CSS/JS são sempre revalidados
    res.setHeader('Cache-Control', /[\\/]flags[\\/]/.test(file) ? 'public, max-age=604800' : 'no-cache');
  },
}));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/jogar', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/health', (_req, res) => res.send('ok'));

const rooms = new Map();

// Ranking acessível a outros mini jogos
app.get('/api/salas/:code/ranking', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({ erro: 'Sala não encontrada' });
  res.json({
    sala: room.code,
    fase: room.phase,
    ranking: leaderboard(room).map(p => ({ posicao: p.rank, nome: p.name, pontos: p.total, tempoMs: p.totalTime })),
  });
});

/* ---------- utilitários ---------- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pick = (arr, n) => shuffle(arr.slice()).slice(0, n);
const token = () => crypto.randomBytes(12).toString('hex');

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(c)) return c;
  }
}

/* ---------- geração de uma ronda ---------- */
function buildRound(room) {
  const used = room.used;
  let pool = ALL.filter(c => !used.has(c));
  if (pool.length < MEMO_COUNT) pool = ALL.slice();
  const memo = pick(pool, MEMO_COUNT);
  const memoSet = new Set(memo);
  const sm = shuffle(memo.slice());
  const correct = sm.slice(0, 5);
  const others = sm.slice(5);

  const chosen = new Set();
  const decoys = [];
  const add = c => { chosen.add(c); decoys.push(c); };
  const okLoose = c => !memoSet.has(c) && !chosen.has(c);
  const okStrict = c => okLoose(c) && !used.has(c);

  const take = (src, n) => {
    let cand = (SIM[src] || []).filter(okStrict);
    if (cand.length < n) cand = cand.concat((SIM[src] || []).filter(c => okLoose(c) && !cand.includes(c)));
    pick(cand.slice(0, n + 3), n).forEach(add);
  };
  correct.forEach(c => take(c, 3));
  others.forEach(c => take(c, 1));

  // completar até 20 (primeiro com semelhantes, depois aleatório)
  if (decoys.length < 20) {
    const union = shuffle([].concat(...memo.map(c => SIM[c] || [])));
    for (const strict of [true, false]) {
      for (const c of union) {
        if (decoys.length >= 20) break;
        if (strict ? okStrict(c) : okLoose(c)) add(c);
      }
    }
  }
  if (decoys.length < 20) {
    for (const strict of [true, false]) {
      for (const c of shuffle(ALL.slice())) {
        if (decoys.length >= 20) break;
        if (strict ? okStrict(c) : okLoose(c)) add(c);
      }
    }
  }

  memo.forEach(c => used.add(c));
  decoys.forEach(c => used.add(c));

  // baralhar a grelha sem deixar as corretas concentradas
  const correctSet = new Set(correct);
  let grid = shuffle(correct.concat(decoys));
  for (let t = 0; t < 300; t++) {
    const rows = [0, 0, 0, 0, 0], cols = [0, 0, 0, 0, 0];
    grid.forEach((c, i) => { if (correctSet.has(c)) { rows[Math.floor(i / 5)]++; cols[i % 5]++; } });
    if (Math.max(...rows) <= 2 && Math.max(...cols) <= 2) break;
    shuffle(grid);
  }
  return { memo, correct, grid, flagMs: room.settings.memoTime * 1000 / MEMO_COUNT };
}

/* ---------- estado e difusão ---------- */
function leaderboard(room) {
  const list = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, total: p.total, totalTime: p.totalTime,
    connected: p.connected, submitted: p.submitted,
    roundScore: p.roundScore,
  }));
  list.sort((a, b) => b.total - a.total || a.totalTime - b.totalTime || a.name.localeCompare(b.name));
  let rank = 0;
  list.forEach((p, i) => {
    const prev = list[i - 1];
    if (!prev || prev.total !== p.total || prev.totalTime !== p.totalTime) rank = i + 1;
    p.rank = rank;
  });
  return list;
}

function stateFor(room, p) {
  const isHost = !p;
  const cur = room.cur;
  const s = {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    round: room.round,
    rounds: room.settings.rounds,
    players: leaderboard(room),
    max: MAX_PLAYERS,
    maxPicks: MAX_PICKS,
  };
  if (isHost) { s.joinUrl = room.joinUrl; if (room.phase === 'lobby') s.qr = room.qr; }
  else { s.me = p.id; s.myName = p.name; }

  if (room.phase === 'preload' && cur) {
    s.preload = isHost ? [...new Set(cur.memo.concat(cur.grid))] : cur.grid.slice();
  }
  if (room.phase === 'memorize' && cur) {
    s.memo = { index: cur.idx, total: MEMO_COUNT, flagMs: cur.flagMs, remaining: Math.max(0, cur.flagMs - (Date.now() - cur.flagStartedAt)) };
    if (isHost) s.memo.code = cur.memo[cur.idx];
  }
  if (room.phase === 'identify' && cur) {
    s.grid = cur.grid;
    s.remaining = Math.max(0, IDENTIFY_MS - (Date.now() - cur.idStart));
    s.total = IDENTIFY_MS;
    if (!isHost) { s.mySel = p.sel; s.submitted = p.submitted; }
  }
  if (room.phase === 'reveal' && cur) {
    s.grid = cur.grid;
    s.correct = cur.correct;
    if (isHost) s.memoList = cur.memo;
    else { s.mySel = p.sel; s.roundScore = p.roundScore; }
    s.last = room.round >= room.settings.rounds;
  }
  return s;
}

function broadcast(room) {
  if (room.hostSocket) io.to(room.hostSocket).emit('state', stateFor(room, null));
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', stateFor(room, p));
  }
  room.touched = Date.now();
}

function clearTimers(room) {
  clearTimeout(room.timer);
  room.timer = null;
}

/* ---------- fluxo do jogo ---------- */
function startRound(room) {
  clearTimers(room);
  room.round++;
  for (const p of room.players.values()) { p.sel = []; p.submitted = false; p.subTime = 0; p.roundScore = 0; }
  room.cur = buildRound(room);
  room.cur.idx = 0;
  room.cur.hostReady = false;
  room.phase = 'preload';
  broadcast(room);
  room.timer = setTimeout(() => beginMemo(room), PRELOAD_MAX_MS);
}

function beginMemo(room) {
  if (room.phase !== 'preload') return;
  clearTimers(room);
  room.phase = 'memorize';
  room.cur.idx = 0;
  showFlag(room);
}

function showFlag(room) {
  const cur = room.cur;
  cur.flagStartedAt = Date.now();
  broadcast(room);
  room.timer = setTimeout(() => {
    cur.idx++;
    if (cur.idx < MEMO_COUNT) showFlag(room);
    else beginIdentify(room);
  }, cur.flagMs);
}

function beginIdentify(room) {
  clearTimers(room);
  room.phase = 'identify';
  room.cur.idStart = Date.now();
  broadcast(room);
  room.timer = setTimeout(() => finishIdentify(room), IDENTIFY_MS);
}

function submitPlayer(room, p, sel, timeMs) {
  if (p.submitted) return;
  const grid = new Set(room.cur.grid);
  const clean = [...new Set(Array.isArray(sel) ? sel : [])].filter(c => grid.has(c)).slice(0, MAX_PICKS);
  p.sel = clean;
  p.submitted = true;
  p.subTime = timeMs;
}

function finishIdentify(room) {
  if (room.phase !== 'identify') return;
  clearTimers(room);
  const correct = new Set(room.cur.correct);
  for (const p of room.players.values()) {
    if (!p.submitted) submitPlayer(room, p, p.sel, IDENTIFY_MS);
    p.roundScore = p.sel.filter(c => correct.has(c)).length;
    p.total += p.roundScore;
    p.totalTime += p.subTime;
  }
  room.phase = 'reveal';
  broadcast(room);
}

function checkAllSubmitted(room) {
  if (room.phase !== 'identify') return;
  const active = [...room.players.values()].filter(p => p.connected);
  if (active.length && active.every(p => p.submitted)) finishIdentify(room);
}

function resetToLobby(room) {
  clearTimers(room);
  room.phase = 'lobby';
  room.round = 0;
  room.cur = null;
  room.used = new Set();
  for (const [id, p] of room.players) {
    if (!p.connected) room.players.delete(id);
    else { p.total = 0; p.totalTime = 0; p.sel = []; p.submitted = false; p.roundScore = 0; }
  }
  broadcast(room);
}

/* ---------- sockets ---------- */
function baseUrl(socket) {
  const h = socket.handshake.headers;
  const proto = (h['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${h['x-forwarded-host'] || h.host}`;
}

async function attachHost(socket, room) {
  room.hostSocket = socket.id;
  socket.data = { room: room.code, role: 'host' };
  room.joinUrl = `${baseUrl(socket)}/jogar?sala=${room.code}`;
  try {
    room.qr = await QRCode.toString(room.joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  } catch { room.qr = ''; }
  broadcast(room);
}

io.on('connection', socket => {
  const hostRoom = () => {
    const r = rooms.get(socket.data && socket.data.room);
    return r && socket.data.role === 'host' && r.hostSocket === socket.id ? r : null;
  };
  const playerOf = () => {
    const r = rooms.get(socket.data && socket.data.room);
    if (!r || socket.data.role !== 'player') return {};
    return { room: r, p: r.players.get(socket.data.pid) };
  };

  socket.on('host:create', async (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const old = data && rooms.get(String(data.code || '').toUpperCase());
    if (old && old.hostToken === data.token) {
      await attachHost(socket, old);
      return reply({ ok: true, code: old.code, token: old.hostToken });
    }
    const room = {
      code: newCode(), hostToken: token(), hostSocket: null,
      settings: { rounds: 5, memoTime: 15 },
      players: new Map(), phase: 'lobby', round: 0, cur: null,
      used: new Set(), timer: null, touched: Date.now(), joinUrl: '', qr: '',
    };
    rooms.set(room.code, room);
    await attachHost(socket, room);
    reply({ ok: true, code: room.code, token: room.hostToken });
  });

  socket.on('host:settings', s => {
    const room = hostRoom();
    if (!room || room.phase !== 'lobby' || !s) return;
    const rounds = Math.max(1, Math.min(10, parseInt(s.rounds, 10) || 5));
    const memoTime = s.memoTime === 10 ? 10 : 15;
    room.settings = { rounds, memoTime };
    broadcast(room);
  });

  socket.on('host:start', () => {
    const room = hostRoom();
    if (!room || room.phase !== 'lobby') return;
    if (![...room.players.values()].some(p => p.connected)) return;
    startRound(room);
  });

  socket.on('host:preloaded', () => {
    const room = hostRoom();
    if (!room || room.phase !== 'preload' || room.cur.hostReady) return;
    room.cur.hostReady = true;
    clearTimers(room);
    room.timer = setTimeout(() => beginMemo(room), 700);
  });

  socket.on('host:next', () => {
    const room = hostRoom();
    if (!room || room.phase !== 'reveal') return;
    if (room.round >= room.settings.rounds) { room.phase = 'final'; broadcast(room); }
    else startRound(room);
  });

  socket.on('host:again', () => {
    const room = hostRoom();
    if (room && room.phase === 'final') resetToLobby(room);
  });

  socket.on('host:kick', id => {
    const room = hostRoom();
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(id);
    if (!p) return;
    if (p.socketId) io.to(p.socketId).emit('kicked');
    room.players.delete(id);
    broadcast(room);
  });

  socket.on('player:join', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(String((data && data.code) || '').toUpperCase().trim());
    if (!room) return reply({ ok: false, erro: 'Sala não encontrada.' });
    if (room.phase !== 'lobby') return reply({ ok: false, erro: 'O jogo já começou.' });
    if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, erro: 'A sala está cheia (máximo 8 jogadores).' });
    let name = String((data && data.name) || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!name) return reply({ ok: false, erro: 'Escreve o teu nome.' });
    const names = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
    if (names.has(name.toLowerCase())) {
      let n = 2;
      while (names.has(`${name} ${n}`.toLowerCase())) n++;
      name = `${name} ${n}`;
    }
    const p = {
      id: crypto.randomBytes(4).toString('hex'), token: token(), name,
      socketId: socket.id, connected: true,
      total: 0, totalTime: 0, sel: [], submitted: false, subTime: 0, roundScore: 0,
    };
    room.players.set(p.id, p);
    socket.data = { room: room.code, role: 'player', pid: p.id };
    reply({ ok: true, code: room.code, token: p.token, name: p.name });
    broadcast(room);
  });

  socket.on('player:rejoin', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(String((data && data.code) || '').toUpperCase());
    const p = room && [...room.players.values()].find(x => x.token === data.token);
    if (!room || !p) return reply({ ok: false });
    p.socketId = socket.id;
    p.connected = true;
    socket.data = { room: room.code, role: 'player', pid: p.id };
    reply({ ok: true, name: p.name });
    broadcast(room);
  });

  socket.on('player:select', sel => {
    const { room, p } = playerOf();
    if (!room || !p || room.phase !== 'identify' || p.submitted) return;
    const grid = new Set(room.cur.grid);
    p.sel = [...new Set(Array.isArray(sel) ? sel : [])].filter(c => grid.has(c)).slice(0, MAX_PICKS);
  });

  socket.on('player:submit', sel => {
    const { room, p } = playerOf();
    if (!room || !p || room.phase !== 'identify' || p.submitted) return;
    submitPlayer(room, p, Array.isArray(sel) ? sel : p.sel, Math.min(IDENTIFY_MS, Date.now() - room.cur.idStart));
    broadcast(room);
    checkAllSubmitted(room);
  });

  socket.on('disconnect', () => {
    const r = rooms.get(socket.data && socket.data.room);
    if (!r) return;
    if (socket.data.role === 'host' && r.hostSocket === socket.id) { r.hostSocket = null; return; }
    if (socket.data.role === 'player') {
      const p = r.players.get(socket.data.pid);
      if (!p || p.socketId !== socket.id) return;
      p.connected = false;
      p.socketId = null;
      broadcast(r);
      checkAllSubmitted(r);
    }
  });
});

// limpeza de salas abandonadas
setInterval(() => {
  const limit = Date.now() - 6 * 3600 * 1000;
  for (const [code, r] of rooms) if (r.touched < limit) { clearTimers(r); rooms.delete(code); }
}, 15 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MemoFlag a correr na porta ${PORT}`));
