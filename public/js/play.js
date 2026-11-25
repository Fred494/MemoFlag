(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const screens = ['join', 'wait', 'look', 'identify', 'result', 'final'];
  const MAX = 5;
  let creds = null, state = null, sel = [], deadline = 0, timerId = null, builtKey = '';

  const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const flagHtml = c => `<div class="flag"><img src="/flags/${c}.svg" alt=""></div>`;
  const show = name => screens.forEach(s => $('s-' + s).classList.toggle('hidden', s !== name));
  const save = () => { try { localStorage.setItem('mf_player', JSON.stringify(creds)); } catch {} };
  const clear = () => { creds = null; try { localStorage.removeItem('mf_player'); } catch {} };

  try { creds = JSON.parse(localStorage.getItem('mf_player')); } catch {}
  const q = new URLSearchParams(location.search).get('sala');
  if (q) $('in-code').value = q.toUpperCase().slice(0, 4);
  try { const n = localStorage.getItem('mf_name'); if (n) $('in-name').value = n; } catch {}

  function tryRejoin() {
    if (!creds) { show('join'); return; }
    socket.emit('player:rejoin', creds, res => {
      if (!res || !res.ok) { clear(); show('join'); }
    });
  }
  socket.on('connect', tryRejoin);

  $('join-form').onsubmit = e => {
    e.preventDefault();
    const code = $('in-code').value.trim().toUpperCase();
    const name = $('in-name').value.trim();
    $('join-err').textContent = '';
    socket.emit('player:join', { code, name }, res => {
      if (!res || !res.ok) { $('join-err').textContent = (res && res.erro) || 'Não foi possível entrar.'; return; }
      creds = { code: res.code, token: res.token };
      save();
      try { localStorage.setItem('mf_name', res.name); } catch {}
    });
  };

  socket.on('kicked', () => { clear(); location.reload(); });

  function preload(codes) { codes.forEach(c => { const i = new Image(); i.src = `/flags/${c}.svg`; }); }

  socket.on('state', s => {
    state = s;
    switch (s.phase) {
      case 'lobby':
        show('wait');
        $('wait-title').textContent = `Olá, ${s.myName}!`;
        $('wait-sub').textContent = 'Estás dentro. À espera que o jogo comece…';
        break;
      case 'preload':
        show('look');
        $('look-round').textContent = `Ronda ${s.round}/${s.rounds}`;
        if (builtKey !== 'p' + s.round) { builtKey = 'p' + s.round; preload(s.preload); }
        break;
      case 'memorize':
        show('look');
        $('look-round').textContent = `Ronda ${s.round}/${s.rounds}`;
        break;
      case 'identify': renderIdentify(s); break;
      case 'reveal': renderResult(s); break;
      case 'final': renderFinal(s); break;
    }
  });

  /* identificação */
  function renderIdentify(s) {
    show('identify');
    const key = 'i' + s.round;
    if (builtKey !== key) {
      builtKey = key;
      sel = (s.mySel || []).slice();
      $('grid').innerHTML = s.grid.map(c => `<button class="cell" data-c="${c}">${flagHtml(c)}</button>`).join('');
    }
    if (s.submitted) sel = (s.mySel || sel).slice();
    deadline = Date.now() + s.remaining;
    clearInterval(timerId); timerId = setInterval(tick, 200); tick();
    paint(s.submitted);
  }

  function paint(locked) {
    document.querySelectorAll('#grid .cell').forEach(b => b.classList.toggle('sel', sel.includes(b.dataset.c)));
    $('picked').textContent = `${sel.length}/${MAX} selecionadas`;
    $('picked').classList.toggle('full', sel.length === MAX);
    $('s-identify').classList.toggle('locked', !!locked);
    $('confirm').disabled = !!locked;
    $('confirm').textContent = locked ? 'Enviado ✓ — à espera dos outros' : 'Confirmar';
  }

  function tick() {
    $('timer').textContent = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  }

  $('grid').onclick = e => {
    const b = e.target.closest('.cell');
    if (!b || !state || state.phase !== 'identify' || state.submitted) return;
    const c = b.dataset.c;
    if (sel.includes(c)) sel = sel.filter(x => x !== c);
    else if (sel.length < MAX) sel.push(c);
    else {
      b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
      if (navigator.vibrate) navigator.vibrate(60);
      return;
    }
    socket.emit('player:select', sel);
    paint(false);
  };

  $('confirm').onclick = () => {
    if (!state || state.submitted) return;
    state.submitted = true;
    socket.emit('player:submit', sel);
    paint(true);
  };

  /* resultado da ronda */
  function renderResult(s) {
    clearInterval(timerId);
    show('result');
    const ok = new Set(s.correct), mine = new Set(s.mySel || []);
    $('res-title').textContent = `Acertaste ${s.roundScore} de 5`;
    const me = s.players.find(p => p.id === s.me);
    $('res-rank').textContent = me ? `${me.rank}º · ${me.total} pts` : '';
    $('res-grid').innerHTML = s.grid.map(c => {
      let cls = 'neutral';
      if (ok.has(c) && mine.has(c)) cls = 'ok';
      else if (mine.has(c)) cls = 'wrong';
      else if (ok.has(c)) cls = 'missed';
      return `<div class="cell ${cls}">${flagHtml(c)}</div>`;
    }).join('');
    $('res-sub').textContent = s.last ? 'À espera do pódio final…' : 'À espera da próxima ronda…';
  }

  /* final */
  function renderFinal(s) {
    show('final');
    const me = s.players.find(p => p.id === s.me);
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    $('fin-medal').textContent = me ? (medals[me.rank] || '🏁') : '🏁';
    $('fin-title').textContent = me ? `${me.rank}º lugar` : 'Fim do jogo';
    $('fin-sub').textContent = me ? `${me.total} pontos` : '';
    $('fin-board').innerHTML = s.players.map(p => `<li class="${p.id === s.me ? 'me' : ''}">
      <span class="pos">${p.rank}</span><span class="nm">${esc(p.name)}</span><span class="pts">${p.total}</span></li>`).join('');
  }
})();
