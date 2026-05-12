/* ══ Cosmic Bomb — Game client ═══════════════════════════════ */

// ── State ──────────────────────────────────────────────────────
let socket = null;
let profile = null;
let myPlayerId = null;
let isHost = false;

const state = {
  phase: 'setup',     // setup | lobby | playing | gameover
  players: [],
  currentPlayerId: null,
  currentKey: '',
  bombTime: 12000,
  bombStartedAt: null,
  isMyTurn: false,
  roundNumber: 0
};

let bombInterval = null;
const RING_CIRCUMFERENCE = 2 * Math.PI * 70; // r=70 from SVG

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  profile = await window.cosmic.getProfile();

  if (!profile || !profile.configured) {
    window.location.href = '../../index.html';
    return;
  }

  bindSetupEvents();
  bindGameEvents();

  $('back-btn').addEventListener('click', () => {
    if (socket) socket.disconnect();
    if (isHost) window.cosmic.stopGameServer();
    window.location.href = '../../index.html';
  });

  // ── Auto-mode: veio do launcher com sala já resolvida ──────
  const params = new URLSearchParams(window.location.search);
  const automode = params.get('automode');

  if (automode === 'host') {
    // Servidor já foi iniciado pelo launcher — só conectar
    const port = parseInt(params.get('port')) || 7777;
    isHost = true;
    showToast('🏠 Sala criada! Compartilhe seu IP com os amigos.');
    connectToServer('localhost', port, true);

  } else if (automode === 'join') {
    const ip   = params.get('ip');
    const port = parseInt(params.get('port')) || 7777;
    showToast(`🔗 Entrando na sala de ${ip}...`);
    connectToServer(ip, port, false);

  } else {
    // Fallback: tela de setup manual
    await loadIPs();
    showScreen('setup');
  }
});

// ── IP list ───────────────────────────────────────────────────
async function loadIPs() {
  const ips = await window.cosmic.getLocalIps();
  const el = $('ip-list');

  if (!ips.length) {
    el.innerHTML = '<span style="color:var(--muted)">Nenhum IP encontrado</span>';
    return;
  }

  el.innerHTML = ips.map(ip => `
    <div class="ip-row">
      <span class="ip-label">${ip.name}</span>
      <span class="ip-value">${ip.address}</span>
    </div>
  `).join('');
}

// ── Setup screen ──────────────────────────────────────────────
function bindSetupEvents() {
  $('btn-host').addEventListener('click', async () => {
    const port = parseInt($('host-port').value) || 7777;
    $('btn-host').disabled = true;
    $('btn-host').textContent = '⏳ Iniciando...';

    try {
      await window.cosmic.startGameServer({ port });
      connectToServer('localhost', port, true);
    } catch (err) {
      showToast('❌ Erro ao iniciar servidor: ' + err.message);
      $('btn-host').disabled = false;
      $('btn-host').textContent = '🚀 Criar Sala';
    }
  });

  $('btn-join').addEventListener('click', () => {
    const ip   = $('join-ip').value.trim();
    const port = parseInt($('join-port').value) || 7777;

    if (!ip) {
      $('join-ip').focus();
      $('join-ip').style.borderColor = 'var(--red)';
      setTimeout(() => $('join-ip').style.borderColor = '', 1500);
      return;
    }

    connectToServer(ip, port, false);
  });
}

// ── Socket connection ─────────────────────────────────────────
function connectToServer(host, port, hosting) {
  isHost = hosting;

  // Atualiza loading screen
  const loadingText = $('loading-text');
  if (loadingText) {
    loadingText.textContent = hosting
      ? 'Iniciando sala...'
      : `Entrando na sala de ${host}...`;
  }
  showScreen('loading');

  socket = io(`http://${host}:${port}`, {
    transports: ['websocket'],
    timeout: 8000,
    reconnection: false
  });

  socket.on('connect', () => {
    socket.emit('join', {
      name:         profile.username,
      icon:         profile.icon,
      avatarBase64: profile.avatarBase64 || null
    });
  });

  socket.on('connect_error', () => {
    showToast('❌ Não foi possível conectar. Verifique o IP e a porta.');
    // Volta para setup manual em caso de erro no automode
    showScreen('setup');
    loadIPs();
  });

  socket.on('join_error', ({ message }) => {
    showToast('❌ ' + message);
    socket.disconnect();
    showScreen('setup');
    loadIPs();
  });

  socket.on('joined', ({ playerId, isHost: hosting }) => {
    myPlayerId = playerId;
    isHost = hosting;
    showScreen('lobby');
    updateLobbyHostUI();
    if (hosting) {
      showToast('🏠 Sala criada! Compartilhe seu IP com os amigos.');
    } else {
      showToast('✅ Entrou na sala!');
    }
  });

  setupSocketHandlers();
}

function setupSocketHandlers() {
  socket.on('lobby_update', ({ players }) => {
    state.players = players;
    renderLobby(players);
  });

  socket.on('lobby_reset', () => {
    state.players = [];
    showScreen('lobby');
    renderLobby([]);
  });

  socket.on('game_error', ({ message }) => showToast('❌ ' + message));

  socket.on('game_start', ({ players, bombTime }) => {
    state.players = players;
    state.bombTime = bombTime;
    state.phase = 'playing';
    showScreen('game');
    renderPlayersRow();
    showToast('💣 A partida começou!');
  });

  socket.on('turn_start', ({ currentPlayerId, key, bombTime, roundNumber }) => {
    state.currentPlayerId = currentPlayerId;
    state.currentKey = key;
    state.bombTime = bombTime;
    state.roundNumber = roundNumber;
    state.bombStartedAt = Date.now();
    state.isMyTurn = currentPlayerId === myPlayerId;

    $('key-display').textContent = key;
    updateCurrentPlayerLabel();
    startBombTimer();
    resetInputState();
    clearFeedback();
    $('bomb-emoji').textContent = '💣';
    $('bomb-emoji').className = 'bomb-emoji' + (bombTime < 4000 ? ' fast' : '');
    updatePlayerChips();
  });

  socket.on('word_result', ({ valid, word, reason, playerId, responseTime }) => {
    if (!valid) {
      const msgs = {
        no_key:       `❌ A palavra não contém "${state.currentKey}"`,
        already_used: '❌ Essa palavra já foi usada!',
        not_a_word:   '❌ Palavra não encontrada no dicionário',
        too_short:    '❌ Palavra muito curta'
      };
      if (playerId === myPlayerId || state.isMyTurn) {
        showFeedback(msgs[reason] || '❌ Palavra inválida', 'red');
        flashInput('invalid');
      }
      return;
    }

    // Valid word
    addWordToLog(word, playerId);
    if (playerId === myPlayerId) flashInput('valid-word');
    clearFeedback();
  });

  socket.on('bomb_explode', ({ playerId, livesLeft, players }) => {
    state.players = players;
    stopBombTimer();

    $('bomb-emoji').classList.add('exploding');
    showToast('💥 BOOM! ' + getPlayerName(playerId) + ' perdeu uma vida!');

    updatePlayerChips();

    setTimeout(() => {
      $('bomb-emoji').textContent = '💣';
      $('bomb-emoji').className = 'bomb-emoji';
    }, 800);
  });

  socket.on('game_over', ({ winner, players }) => {
    state.players = players;
    state.phase = 'gameover';
    stopBombTimer();
    showScreen('gameover');
    renderGameOver(winner);
  });

  socket.on('disconnect', () => {
    if (state.phase !== 'gameover') {
      showToast('⚠️ Conexão perdida com o servidor.');
    }
  });
}

// ── Lobby ─────────────────────────────────────────────────────
function renderLobby(players) {
  const grid = $('lobby-players');
  grid.innerHTML = '';

  players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'lobby-player' +
      (p.ready ? ' ready' : '') +
      (i === 0 ? ' is-host' : '');

    const av = document.createElement('div');
    av.className = 'lobby-player-avatar';
    if (p.avatarBase64) {
      av.innerHTML = `<img src="${p.avatarBase64}">`;
    } else {
      av.textContent = p.icon || '🚀';
    }

    const info = document.createElement('div');
    info.className = 'lobby-player-info';
    info.innerHTML = `
      <div class="lobby-player-name">${esc(p.name)}</div>
      <div class="lobby-player-status">
        ${ i === 0 ? '👑 Host' : (p.ready ? '✅ Pronto' : '⏳ Aguardando') }
      </div>
    `;

    div.appendChild(av);
    div.appendChild(info);
    grid.appendChild(div);
  });

  $('lobby-subtitle').textContent =
    `${players.length} jogador(es) na sala · porta ${socket?.io?.opts?.hostname?.includes(':') ? socket.io.opts.hostname.split(':')[1] : '7777'}`;
}

function updateLobbyHostUI() {
  if (isHost) {
    $('btn-start').classList.remove('hidden');
    $('lobby-waiting-msg').textContent = 'Como host, clique em "Iniciar Jogo" quando todos estiverem prontos.';
  }
}

function bindGameEvents() {
  $('btn-ready').addEventListener('click', () => {
    socket?.emit('set_ready');
  });

  $('btn-start').addEventListener('click', () => {
    socket?.emit('start_game');
  });

  $('btn-play-again').addEventListener('click', () => {
    showScreen('lobby');
  });

  $('btn-back-menu').addEventListener('click', () => {
    if (socket) socket.disconnect();
    if (isHost) window.cosmic.stopGameServer();
    window.location.href = '../../index.html';
  });

  const input = $('word-input');
  const sendBtn = $('send-btn');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitWord();
  });

  sendBtn.addEventListener('click', submitWord);
}

// ── Game screen ────────────────────────────────────────────────
function renderPlayersRow() {
  const row = $('players-row');
  row.innerHTML = '';

  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.id = `chip-${p.id}`;

    const av = document.createElement('div');
    av.className = 'player-chip-avatar';
    if (p.avatarBase64) {
      av.innerHTML = `<img src="${p.avatarBase64}">`;
    } else {
      av.textContent = p.icon || '🚀';
    }

    const name = document.createElement('div');
    name.className = 'player-chip-name';
    name.textContent = p.name;

    const lives = document.createElement('div');
    lives.className = 'lives';
    lives.innerHTML = renderLives(p.lives);

    chip.appendChild(av);
    chip.appendChild(name);
    chip.appendChild(lives);
    row.appendChild(chip);
  });
}

function renderLives(lives) {
  let html = '';
  for (let i = 0; i < 3; i++) {
    html += `<span class="life ${i >= lives ? 'lost' : ''}">❤️</span>`;
  }
  return html;
}

function updatePlayerChips() {
  state.players.forEach(p => {
    const chip = $(`chip-${p.id}`);
    if (!chip) return;
    const livesEl = chip.querySelector('.lives');
    if (livesEl) livesEl.innerHTML = renderLives(p.lives);
    chip.classList.toggle('dead', p.lives <= 0);
  });
}

function updateCurrentPlayerLabel() {
  const name = getPlayerName(state.currentPlayerId);
  $('current-player-label').innerHTML = state.isMyTurn
    ? '🎯 Sua vez! Digite uma palavra'
    : `Vez de <span>${esc(name)}</span>`;
}

// ── Bomb timer ─────────────────────────────────────────────────
function startBombTimer() {
  stopBombTimer();
  const ring = $('timer-ring-fill');
  const timerText = $('timer-text');
  const totalTime = state.bombTime;

  const update = () => {
    const elapsed  = Date.now() - state.bombStartedAt;
    const progress = Math.max(0, 1 - elapsed / totalTime);
    const offset   = RING_CIRCUMFERENCE * (1 - progress);

    ring.style.strokeDashoffset = offset;

    // Color shift: green → yellow → red
    if (progress > 0.5) {
      ring.style.stroke = 'var(--green)';
    } else if (progress > 0.25) {
      ring.style.stroke = 'var(--yellow)';
    } else {
      ring.style.stroke = 'var(--red)';
    }

    const secsLeft = Math.ceil((totalTime - elapsed) / 1000);
    timerText.textContent = secsLeft > 0 ? secsLeft : '0';
    timerText.className = 'timer-text' + (secsLeft <= 3 ? ' low' : '');
  };

  update();
  bombInterval = setInterval(update, 50);
}

function stopBombTimer() {
  if (bombInterval) {
    clearInterval(bombInterval);
    bombInterval = null;
  }
}

// ── Word submission ────────────────────────────────────────────
async function submitWord() {
  if (!state.isMyTurn) return;

  const input = $('word-input');
  const word  = input.value.trim();

  if (!word) return;

  // Client-side validation first (faster feedback)
  const result = await window.cosmic.validateWord({ word, key: state.currentKey });

  if (!result.valid) {
    const msgs = {
      no_key:     `A palavra precisa conter "${state.currentKey}"`,
      not_a_word: 'Palavra não encontrada no dicionário',
      too_short:  'Palavra muito curta'
    };
    showFeedback('❌ ' + (msgs[result.reason] || 'Palavra inválida'), 'red');
    flashInput('invalid');
    return;
  }

  // Send to server
  socket.emit('submit_word', { word });

  // Disable input while waiting for server ack
  input.disabled = true;
  $('send-btn').disabled = true;
  state.isMyTurn = false;
}

function resetInputState() {
  const input = $('word-input');
  input.value = '';
  input.className = 'word-input' + (state.isMyTurn ? ' active-turn' : '');
  input.disabled = !state.isMyTurn;
  input.placeholder = state.isMyTurn ? 'Digite uma palavra...' : '(aguardando...)';
  $('send-btn').disabled = !state.isMyTurn;

  if (state.isMyTurn) {
    setTimeout(() => input.focus(), 100);
  }
}

function flashInput(className) {
  const input = $('word-input');
  input.classList.add(className);
  setTimeout(() => {
    input.classList.remove(className);
    if (state.isMyTurn) input.value = '';
  }, 600);
}

// ── Word log ──────────────────────────────────────────────────
function addWordToLog(word, playerId) {
  const log = $('word-log');
  const chip = document.createElement('div');
  chip.className = 'word-chip';
  const name = getPlayerName(playerId);
  chip.textContent = `${word} (${name})`;
  log.insertBefore(chip, log.firstChild);

  // Keep only last 8 words
  while (log.children.length > 8) {
    log.removeChild(log.lastChild);
  }
}

// ── Game over ─────────────────────────────────────────────────
function renderGameOver(winner) {
  $('word-log').innerHTML = '';

  if (winner) {
    $('gameover-title').textContent = '🏆 Temos um vencedor!';

    const winnerP = state.players.find(p => p.id === winner.id);
    const av = winnerP?.avatarBase64
      ? `<img src="${winnerP.avatarBase64}">`
      : (winner.icon || '🚀');

    $('winner-display').innerHTML = `
      <div class="winner-avatar">${typeof av === 'string' && av.startsWith('<') ? av : `<span>${av}</span>`}</div>
      <div class="winner-name">${esc(winner.name)}</div>
      <div style="color:var(--muted);font-size:14px">Sobreviveu até o fim!</div>
    `;
  } else {
    $('gameover-title').textContent = '💥 Todos explodiram!';
    $('winner-display').innerHTML = '<div style="font-size:48px">🤯</div>';
  }
}

// ── Screen management ─────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
  state.phase = name;
}

// ── Feedback ──────────────────────────────────────────────────
function showFeedback(msg, color = 'white') {
  const el = $('feedback-msg');
  el.textContent = msg;
  el.style.color = color === 'red' ? 'var(--red)' : color === 'green' ? 'var(--green)' : 'var(--muted)';
}

function clearFeedback() {
  $('feedback-msg').textContent = '';
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Helpers ───────────────────────────────────────────────────
function getPlayerName(playerId) {
  const p = state.players.find(p => p.id === playerId);
  return p ? p.name : 'Jogador';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
