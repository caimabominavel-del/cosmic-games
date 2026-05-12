const { Server } = require('socket.io');
const http = require('http');

// ── Game config ──────────────────────────────────────────────
const INITIAL_BOMB_TIME = 12000; // ms
const MIN_BOMB_TIME = 2500;
const TIME_REDUCTION = 0.92;     // -8% per full rotation
const INITIAL_LIVES = 3;
const TURN_PAUSE = 1200;         // ms between turns after valid word
const EXPLODE_PAUSE = 2500;      // ms after explosion before next turn

// PT-BR common syllable keys
const KEYS = [
  'SS', 'NH', 'LH', 'AM', 'EM', 'IM', 'OM', 'UM',
  'AO', 'OU', 'AI', 'EI', 'AR', 'ER', 'IR', 'OR',
  'AL', 'EL', 'AN', 'EN', 'IN', 'ON', 'CA', 'CO',
  'QU', 'PR', 'BR', 'TR', 'FR', 'GR', 'FL', 'PL',
  'NT', 'ND', 'MP', 'RA', 'RE', 'RO', 'LA', 'LE',
  'LO', 'MA', 'ME', 'MI', 'MO', 'NA', 'NE', 'NO',
  'PA', 'PE', 'PI', 'SA', 'SE', 'SO', 'TA', 'TE',
  'TO', 'VA', 'VE', 'VI', 'VO', 'BA', 'BE', 'BO',
  'DA', 'DE', 'DO', 'FA', 'FE', 'FO', 'GA', 'GO',
  'JA', 'JO', 'RU', 'LU', 'MU', 'NU', 'PU', 'SU',
  'TU', 'VU', 'BU', 'DU', 'FU', 'GU'
];

// ── Server class ─────────────────────────────────────────────
class CosmicBombServer {
  constructor(port = 7777) {
    this.port = port;
    this.httpServer = null;
    this.io = null;
    this.state = this._freshState();
    this._usedKeyHistory = [];
  }

  // ── Lifecycle ────────────────────────────────────────────
  start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer();
      this.io = new Server(this.httpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
        pingTimeout: 10000,
        pingInterval: 5000
      });

      this._setupHandlers();

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[CosmicBomb] Server listening on port ${this.port}`);
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  stop() {
    this._clearBombTimer();
    if (this.io) this.io.close();
    if (this.httpServer) this.httpServer.close();
    console.log('[CosmicBomb] Server stopped');
  }

  // ── State ────────────────────────────────────────────────
  _freshState() {
    return {
      players: [],
      phase: 'lobby',
      currentPlayerIndex: 0,
      currentKey: '',
      currentBombTime: INITIAL_BOMB_TIME,
      roundNumber: 0,
      usedWords: new Set(),
      bombTimer: null,
      bombStartedAt: null
    };
  }

  _publicPlayers() {
    return this.state.players.map(({ id, name, icon, avatarBase64, lives, ready, score, streak }) =>
      ({ id, name, icon, avatarBase64, lives, ready, score: score || 0, streak: streak || 0 }));
  }

  // ── Scoring ──────────────────────────────────────────────
  _calcWordScore(word, responseTimeMs, streak, playerCount) {
    // Comprimento: +10 por letra acima de 2
    const lengthPts = Math.max(0, word.length - 2) * 10;
    // Velocidade: máx 60pts (janela de 5s)
    const speedPts  = Math.max(0, Math.floor((5000 - responseTimeMs) / 83));
    // Sequência: +20 por acerto consecutivo, máx 100
    const streakPts = Math.min(streak * 20, 100);
    // Multiplicador: 2 jogadores = 1x, cada extra +25%
    const mult = 1 + Math.max(0, playerCount - 2) * 0.25;
    return Math.round((lengthPts + speedPts + streakPts) * mult);
  }

  _calcWinBonus(playerCount) {
    const mult = 1 + Math.max(0, playerCount - 2) * 0.25;
    return Math.round(300 * mult);
  }

  _alivePlayers() {
    return this.state.players.filter(p => p.lives > 0);
  }

  _currentPlayer() {
    return this.state.players[this.state.currentPlayerIndex] || null;
  }

  _clearBombTimer() {
    if (this.state.bombTimer) {
      clearTimeout(this.state.bombTimer);
      this.state.bombTimer = null;
    }
  }

  // ── Socket handlers ──────────────────────────────────────
  _setupHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[CosmicBomb] Connected: ${socket.id}`);

      socket.on('join', ({ name, icon, avatarBase64 }) => {
        if (this.state.phase !== 'lobby') {
          socket.emit('join_error', { message: 'Partida já em andamento' });
          return;
        }
        if (this.state.players.length >= 8) {
          socket.emit('join_error', { message: 'Sala cheia (máx 8 jogadores)' });
          return;
        }

        const player = {
          id: socket.id,
          name: String(name).slice(0, 20),
          icon: icon || '🚀',
          avatarBase64: avatarBase64 || null,
          lives: INITIAL_LIVES,
          ready: false,
          score: 0,
          streak: 0
        };

        this.state.players.push(player);
        const isHost = this.state.players.length === 1;
        socket.emit('joined', { playerId: socket.id, isHost });
        this.io.emit('lobby_update', { players: this._publicPlayers() });
      });

      socket.on('set_ready', () => {
        const player = this.state.players.find(p => p.id === socket.id);
        if (player && this.state.phase === 'lobby') {
          player.ready = !player.ready;
          this.io.emit('lobby_update', { players: this._publicPlayers() });
        }
      });

      socket.on('start_game', () => {
        const host = this.state.players[0];
        if (!host || host.id !== socket.id) return;
        if (this.state.players.length < 2) {
          socket.emit('game_error', { message: 'Precisa de pelo menos 2 jogadores' });
          return;
        }
        this._startGame();
      });

      socket.on('submit_word', ({ word }) => {
        if (this.state.phase !== 'playing') return;
        const current = this._currentPlayer();
        if (!current || current.id !== socket.id) return;
        this._handleWord(socket, word);
      });

      socket.on('disconnect', () => {
        console.log(`[CosmicBomb] Disconnected: ${socket.id}`);
        const idx = this.state.players.findIndex(p => p.id === socket.id);
        if (idx === -1) return;

        this.state.players.splice(idx, 1);

        if (this.state.phase === 'lobby') {
          this.io.emit('lobby_update', { players: this._publicPlayers() });
          return;
        }

        if (this.state.phase === 'playing') {
          const alive = this._alivePlayers();
          if (alive.length < 2) {
            this._endGame();
          } else {
            if (idx <= this.state.currentPlayerIndex) {
              this.state.currentPlayerIndex = Math.max(0, this.state.currentPlayerIndex - 1);
            }
            this._nextTurn();
          }
        }
      });
    });
  }

  // ── Game logic ───────────────────────────────────────────
  _startGame() {
    this.state.phase = 'playing';
    this.state.currentPlayerIndex = 0;
    this.state.currentBombTime = INITIAL_BOMB_TIME;
    this.state.roundNumber = 0;
    this.state.usedWords = new Set();
    this.state.players.forEach(p => { p.lives = INITIAL_LIVES; p.score = 0; p.streak = 0; });

    this.io.emit('game_start', {
      players: this._publicPlayers(),
      bombTime: this.state.currentBombTime
    });

    setTimeout(() => this._nextTurn(), 1500);
  }

  _nextTurn() {
    if (this.state.phase !== 'playing') return;
    this._clearBombTimer();

    const alive = this._alivePlayers();
    if (alive.length < 2) { this._endGame(); return; }

    // Advance to next alive player
    let attempts = 0;
    do {
      this.state.currentPlayerIndex =
        (this.state.currentPlayerIndex + 1) % this.state.players.length;
      attempts++;
    } while (
      this.state.players[this.state.currentPlayerIndex].lives <= 0 &&
      attempts <= this.state.players.length
    );

    this.state.roundNumber++;

    // Reduce bomb time every full rotation of alive players
    if (this.state.roundNumber > 1 && this.state.roundNumber % alive.length === 0) {
      this.state.currentBombTime = Math.max(
        MIN_BOMB_TIME,
        Math.floor(this.state.currentBombTime * TIME_REDUCTION)
      );
    }

    this.state.currentKey = this._pickKey();
    this.state.bombStartedAt = Date.now();

    const current = this._currentPlayer();

    this.io.emit('turn_start', {
      currentPlayerId: current.id,
      key: this.state.currentKey,
      bombTime: this.state.currentBombTime,
      roundNumber: this.state.roundNumber
    });

    this.state.bombTimer = setTimeout(() => this._bombExplode(), this.state.currentBombTime);
  }

  _handleWord(socket, word) {
    if (!word || typeof word !== 'string') return;

    const normWord = word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const normKey  = this.state.currentKey.toLowerCase();

    // Key check (server-side)
    if (!normWord.includes(normKey)) {
      socket.emit('word_result', { valid: false, reason: 'no_key', word });
      return;
    }

    // Already used this round
    if (this.state.usedWords.has(normWord)) {
      socket.emit('word_result', { valid: false, reason: 'already_used', word });
      return;
    }

    // Accept word
    this.state.usedWords.add(normWord);
    this._clearBombTimer();

    const responseTime = Date.now() - this.state.bombStartedAt;
    const player = this.state.players.find(p => p.id === socket.id);

    if (player) {
      player.streak++;
      const pts = this._calcWordScore(normWord, responseTime, player.streak, this.state.players.length);
      player.score += pts;

      this.io.emit('word_result', {
        valid: true,
        word,
        playerId: socket.id,
        responseTime,
        pts,
        streak:  player.streak,
        scores:  this._publicPlayers().map(p => ({ id: p.id, score: p.score, streak: p.streak }))
      });
    }

    setTimeout(() => this._nextTurn(), TURN_PAUSE);
  }

  _bombExplode() {
    const current = this._currentPlayer();
    if (!current) return;

    current.lives  = Math.max(0, current.lives - 1);
    current.streak = 0; // reset streak on explosion

    this.io.emit('bomb_explode', {
      playerId: current.id,
      livesLeft: current.lives,
      players: this._publicPlayers()
    });

    const alive = this._alivePlayers();
    if (alive.length < 2) {
      setTimeout(() => this._endGame(), 2000);
    } else {
      setTimeout(() => this._nextTurn(), EXPLODE_PAUSE);
    }
  }

  _endGame() {
    this._clearBombTimer();
    this.state.phase = 'ended';

    const winner = this.state.players.find(p => p.lives > 0) || null;

    // Add win bonus to winner's score
    if (winner) {
      winner.score += this._calcWinBonus(this.state.players.length);
    }

    this.io.emit('game_over', {
      winner: winner
        ? { id: winner.id, name: winner.name, icon: winner.icon, score: winner.score }
        : null,
      players: this._publicPlayers(),
      totalRounds: this.state.roundNumber
    });

    // Auto-reset lobby after 12 seconds
    setTimeout(() => {
      this.state = this._freshState();
      this.io.emit('lobby_reset', { players: [] });
    }, 12000);
  }

  _pickKey() {
    // Avoid repeating recent keys
    const candidates = KEYS.filter(k => !this._usedKeyHistory.includes(k));
    const pool = candidates.length > 0 ? candidates : KEYS;
    const key = pool[Math.floor(Math.random() * pool.length)];
    this._usedKeyHistory.push(key);
    if (this._usedKeyHistory.length > 10) this._usedKeyHistory.shift();
    return key;
  }
}

module.exports = CosmicBombServer;
