(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const screens = ['lobby', 'preload', 'memo', 'identify', 'reveal', 'final'];
  let state = null, deadline = 0, timerId = null, shownPhase = null, shownRound = -1;

  const flagHtml = c => `<div class="flag"><img src="/flags/${c}.svg" alt=""></div>`;
  const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  function show(name) {
    screens.forEach(s => $('s-' + s).classList.toggle('hidden', s !== name));
  }

  function connect() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('mf_host')); } catch {}
    socket.emit('host:create', saved || {}, res => {
      if (res && res.ok) { try { localStorage.setItem('mf_host', JSON.stringify({ code: res.code, token: res.token })); } catch {} }
    });
  }
  socket.on('connect', connect);

  function preload(codes) {
    return Promise.all(codes.map(c => new Promise(r => {
      const i = new Image(); i.onload = i.onerror = r; i.src = `/flags/${c}.svg`;
    })));
  }

  function board(list, opts = {}) {
    return list.map(p => `<li class="${p.connected ? '' : 'off'} ${opts.done && p.submitted ? 'done' : ''}">
      <span class="pos">${opts.noRank ? '•' : p.rank}</span><span class="nm">${esc(p.name)}</span>
      ${opts.gain ? `<span class="gain">${p.roundScore ? '+' + p.roundScore : ''}</span>` : ''}
      ${opts.noPts ? '' : `<span class="pts">${p.total}</span>`}</li>`).join('');
  }

  function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $('id-timer').textContent = left;
  }

  socket.on('state', s => {
    const prev = state;
    state = s;
    switch (s.phase) {
      case 'lobby': renderLobby(s); break;
      case 'preload': renderPreload(s); break;
      case 'memorize': renderMemo(s); break;
      case 'identify': renderIdentify(s, prev); break;
      case 'reveal': renderReveal(s); break;
      case 'final': renderFinal(s); break;
    }
    shownPhase = s.phase; shownRound = s.round;
  });

  /* lobby */
  function renderLobby(s) {
    show('lobby');
    $('code').textContent = s.code;
    try { $('join-host').textContent = new URL(s.joinUrl).host + '/jogar'; } catch {}
    if (s.qr && $('qr').dataset.url !== s.joinUrl) { $('qr').innerHTML = s.qr; $('qr').dataset.url = s.joinUrl; }
    $('count').textContent = `${s.players.length}/${s.max}`;
    $('lobby-players').innerHTML = s.players.map(p =>
      `<li class="${p.connected ? '' : 'off'}">${esc(p.name)}<button data-k="${p.id}" title="Remover">✕</button></li>`).join('');
    $('r-val').textContent = s.settings.rounds;
    $('t10').classList.toggle('on', s.settings.memoTime === 10);
    $('t15').classList.toggle('on', s.settings.memoTime === 15);
    $('start').disabled = !s.players.some(p => p.connected);
  }
  const setSettings = patch => socket.emit('host:settings', { ...state.settings, ...patch });
  $('r-minus').onclick = () => setSettings({ rounds: state.settings.rounds - 1 });
  $('r-plus').onclick = () => setSettings({ rounds: state.settings.rounds + 1 });
  $('t10').onclick = () => setSettings({ memoTime: 10 });
  $('t15').onclick = () => setSettings({ memoTime: 15 });
  $('start').onclick = () => socket.emit('host:start');
  $('lobby-players').onclick = e => { const k = e.target.dataset && e.target.dataset.k; if (k) socket.emit('host:kick', k); };

  /* pré-carregamento */
  function renderPreload(s) {
    show('preload');
    $('pre-round').textContent = `${s.round}/${s.rounds}`;
    if (shownPhase !== 'preload' || shownRound !== s.round) {
      const round = s.round;
      preload(s.preload).then(() => { if (state && state.phase === 'preload' && state.round === round) socket.emit('host:preloaded'); });
    }
  }

  /* memorização */
  function renderMemo(s) {
    show('memo');
    const m = s.memo;
    $('memo-round').textContent = `Ronda ${s.round}/${s.rounds}`;
    $('memo-count').textContent = `${m.index + 1} de ${m.total}`;
    $('memo-flag').innerHTML = `<img src="/flags/${m.code}.svg" alt="">`;
    const bar = $('memo-bar');
    const start = (m.index + (m.flagMs - m.remaining) / m.flagMs) / m.total;
    bar.style.transition = 'none';
    bar.style.width = (start * 100) + '%';
    void bar.offsetWidth;
    bar.style.transition = `width ${m.remaining}ms linear`;
    bar.style.width = ((m.index + 1) / m.total * 100) + '%';
  }

  /* identificação */
  function gridHtml(grid) { return grid.map(c => `<div class="cell" data-c="${c}">${flagHtml(c)}</div>`).join(''); }

  function renderIdentify(s, prev) {
    show('identify');
    $('id-round').textContent = `Ronda ${s.round}/${s.rounds}`;
    if (shownPhase !== 'identify' || shownRound !== s.round) $('id-grid').innerHTML = gridHtml(s.grid);
    deadline = Date.now() + s.remaining;
    clearInterval(timerId); timerId = setInterval(tick, 200); tick();
    $('id-status').innerHTML = board(s.players, { done: true, noPts: true, noRank: true });
  }

  /* revelação */
  function renderReveal(s) {
    clearInterval(timerId);
    show('reveal');
    const ok = new Set(s.correct);
    $('rv-round').textContent = `Ronda ${s.round}/${s.rounds}`;
    $('rv-grid').innerHTML = s.grid.map(c => `<div class="cell ${ok.has(c) ? 'ok' : 'dim'}">${flagHtml(c)}</div>`).join('');
    $('rv-memo').innerHTML = s.memoList.map(c => `<div class="cell ${ok.has(c) ? 'ok' : 'dim'}">${flagHtml(c)}</div>`).join('');
    $('rv-board').innerHTML = board(s.players, { gain: true });
    $('next').textContent = s.last ? 'Ver pódio' : 'Próxima ronda';
  }
  $('next').onclick = () => socket.emit('host:next');

  /* final */
  function renderFinal(s) {
    show('final');
    const top = s.players.slice(0, 3);
    const order = [1, 0, 2].filter(i => top[i]);
    const medals = ['🥇', '🥈', '🥉'];
    $('podium').innerHTML = order.map(i => `<div class="step p${i + 1}" style="animation-delay:${(2 - i) * .4}s">
      <span class="medal">${medals[i]}</span><span class="nm">${esc(top[i].name)}</span><b>${top[i].total} pts</b></div>`).join('');
    $('final-board').innerHTML = board(s.players);
  }
  $('again').onclick = () => socket.emit('host:again');
})();
