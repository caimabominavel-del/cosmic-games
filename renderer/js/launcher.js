/* ── Launcher script ──────────────────────────────────────────── */

const EMOJIS = ['🚀','⭐','🌙','💫','🪐','☄️','👾','🎮','💥','🌌','🔥','❄️','🦄','🐉','💎','⚡'];

let profile = null;
let selectedEmoji = '🚀';
let pendingAvatarBase64 = null;
let onlineInterval = null;

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  buildEmojiGrid();
  await loadProfile();
  startWordlistDownload();
  startOnlinePolling();
  bindEvents();
  setupUpdater();
});

// ── Profile ───────────────────────────────────────────────────
async function loadProfile() {
  profile = await window.cosmic.getProfile();

  if (!profile.configured) {
    showProfileOverlay();
    return;
  }

  applyProfileToUI();
}

function applyProfileToUI() {
  if (!profile) return;

  // Sidebar
  setAvatarEl(document.getElementById('my-avatar'), profile);
  document.getElementById('my-name').textContent = profile.username;

  // Hide overlay
  document.getElementById('profile-overlay').classList.add('hidden');
}

function showProfileOverlay(prefill = false) {
  document.getElementById('profile-overlay').classList.remove('hidden');

  if (prefill && profile) {
    document.getElementById('username-input').value = profile.username || '';
    selectedEmoji = profile.icon || '🚀';
    pendingAvatarBase64 = profile.avatarBase64 || null;
    updateEmojiSelection();

    const preview = document.getElementById('avatar-preview');
    if (pendingAvatarBase64) {
      preview.innerHTML = `<img src="${pendingAvatarBase64}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      preview.textContent = selectedEmoji;
    }
  }
}

async function saveProfile() {
  const name = document.getElementById('username-input').value.trim();
  if (!name) {
    document.getElementById('username-input').focus();
    document.getElementById('username-input').style.borderColor = '#ef4444';
    setTimeout(() => document.getElementById('username-input').style.borderColor = '', 1500);
    return;
  }

  const updated = {
    ...profile,
    username: name,
    icon: selectedEmoji,
    avatarBase64: pendingAvatarBase64 || null,
    configured: true
  };

  profile = await window.cosmic.saveProfile(updated);
  applyProfileToUI();
}

// ── Avatar / emoji ────────────────────────────────────────────
function buildEmojiGrid() {
  const grid = document.getElementById('emoji-grid');
  EMOJIS.forEach(em => {
    const span = document.createElement('span');
    span.className = 'emoji-opt' + (em === selectedEmoji ? ' active' : '');
    span.textContent = em;
    span.dataset.emoji = em;
    span.addEventListener('click', () => {
      selectedEmoji = em;
      pendingAvatarBase64 = null;
      document.getElementById('avatar-preview').textContent = em;
      updateEmojiSelection();
    });
    grid.appendChild(span);
  });
}

function updateEmojiSelection() {
  document.querySelectorAll('.emoji-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.emoji === selectedEmoji);
  });
}

function handleAvatarUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Resize to 80x80 thumbnail via canvas
      const canvas = document.createElement('canvas');
      canvas.width = 80; canvas.height = 80;
      const ctx = canvas.getContext('2d');
      // Center-crop
      const size = Math.min(img.width, img.height);
      const sx = (img.width  - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 80, 80);
      pendingAvatarBase64 = canvas.toDataURL('image/jpeg', 0.8);
      document.getElementById('avatar-preview').innerHTML =
        `<img src="${pendingAvatarBase64}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function setAvatarEl(el, p) {
  if (!el) return;
  if (p.avatarBase64) {
    el.innerHTML = `<img src="${p.avatarBase64}">`;
  } else {
    el.textContent = p.icon || '🚀';
  }
}

// ── Online players ────────────────────────────────────────────
function startOnlinePolling() {
  refreshOnline();
  onlineInterval = setInterval(refreshOnline, 5000);
}

async function refreshOnline() {
  const players = await window.cosmic.getOnlinePlayers();
  const list    = document.getElementById('online-list');
  const count   = document.getElementById('online-count');

  count.textContent = players.length;

  if (players.length === 0) {
    list.innerHTML = '<div class="online-empty">Ninguém online por aqui ainda...</div>';
    return;
  }

  list.innerHTML = '';
  players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'online-player';

    const avatar = document.createElement('div');
    avatar.className = 'avatar sm';
    if (p.avatarBase64) {
      avatar.innerHTML = `<img src="${p.avatarBase64}">`;
    } else {
      avatar.textContent = p.icon || '👾';
    }

    const name = document.createElement('div');
    name.className = 'online-player-name';
    name.textContent = p.username;

    div.appendChild(avatar);
    div.appendChild(name);
    list.appendChild(div);
  });
}

// ── Wordlist ──────────────────────────────────────────────────
async function startWordlistDownload() {
  const badge = document.getElementById('wordlist-badge');

  const status = await window.cosmic.wordlistStatus();
  if (status.loaded) {
    badge.className = 'wordlist-badge ready';
    badge.textContent = `✅ ${(status.wordCount / 1000).toFixed(0)}k palavras`;
    return;
  }

  badge.className = 'wordlist-badge loading';
  badge.textContent = '⏳ Baixando dicionário...';

  const result = await window.cosmic.downloadWordlist();
  if (result.ok) {
    badge.className = 'wordlist-badge ready';
    badge.textContent = `✅ ${(result.count / 1000).toFixed(0)}k palavras`;
  } else {
    badge.className = 'wordlist-badge error';
    badge.textContent = '⚠️ Modo offline (sem dicionário)';
  }
}

// ── Game navigation ───────────────────────────────────────────
async function openGame(game) {
  if (!profile || !profile.configured) {
    showProfileOverlay();
    return;
  }

  const btn = document.getElementById('play-cosmic-bomb');
  btn.disabled = true;
  btn.textContent = '🔍 Procurando sala...';

  try {
    // 1) Já estou hosting?
    const serverStatus = await window.cosmic.getServerStatus();
    if (serverStatus.hosting) {
      navigate(game, { automode: 'host', port: serverStatus.port });
      return;
    }

    // 2) Algum player online está hosting?
    const players = await window.cosmic.getOnlinePlayers();
    const host = players.find(p => p.hostingPort);

    if (host) {
      navigate(game, { automode: 'join', ip: host.ip, port: host.hostingPort });
      return;
    }

    // 3) Ninguém hosting → cria sala
    btn.textContent = '🚀 Criando sala...';
    const result = await window.cosmic.startGameServer({ port: 7777 });
    navigate(game, { automode: 'host', port: result.port });

  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Jogar';
    console.error('openGame error:', err);
  }
}

function navigate(game, params) {
  const qs = new URLSearchParams(params).toString();
  window.location.href = `games/${game}/index.html?${qs}`;
}

// ── Bind events ───────────────────────────────────────────────
function bindEvents() {
  // Play buttons
  document.getElementById('play-cosmic-bomb').addEventListener('click', () => openGame('cosmic-bomb'));

  // Profile save
  document.getElementById('save-profile-btn').addEventListener('click', saveProfile);
  document.getElementById('username-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveProfile();
  });

  // Edit profile
  document.getElementById('edit-profile-btn').addEventListener('click', () => showProfileOverlay(true));
  document.getElementById('open-profile-btn').addEventListener('click', () => showProfileOverlay(true));

  // Avatar upload
  document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('avatar-file').click();
  });
  document.getElementById('avatar-file').addEventListener('change', e => {
    handleAvatarUpload(e.target.files[0]);
  });
}

// ── Auto-updater ──────────────────────────────────────────────
function setupUpdater() {
  window.cosmic.onUpdateAvailable(() => {
    document.getElementById('update-banner').classList.remove('hidden');
  });
  window.cosmic.onUpdateDownloaded(() => {
    const btn = document.getElementById('install-update-btn');
    btn.textContent = '✅ Pronto! Clique para reiniciar';
    btn.onclick = () => window.cosmic.installUpdate();
  });
}
