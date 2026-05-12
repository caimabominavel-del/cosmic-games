const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');

// Dynamically import electron-updater to avoid crash if not configured
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
} catch {}

const Store = require('electron-store');
const ProfileStore = require('./src/profile-store');
const NetworkDiscovery = require('./src/network-discovery');
const CosmicBombServer = require('./src/cosmic-bomb-server');
const WordValidator = require('./src/word-validator');

const store = new Store();
let mainWindow;
let discovery;
let activeGameServer = null;

// ── Window ─────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0a0a1a',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // allow loading local socket.io from node_modules
    }
  });

  mainWindow.loadFile('renderer/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// ── App lifecycle ──────────────────────────────────────────
app.whenReady().then(async () => {
  // Init word validator path
  WordValidator.setUserDataPath(app.getPath('userData'));

  createWindow();

  // Start LAN discovery
  discovery = new NetworkDiscovery(store);
  discovery.start();

  // Check for updates after startup
  if (autoUpdater) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 5000);
  }
});

app.on('window-all-closed', () => {
  if (discovery) discovery.stop();
  if (activeGameServer) activeGameServer.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: Window controls ───────────────────────────────────
ipcMain.handle('win-minimize', () => mainWindow.minimize());
ipcMain.handle('win-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('win-close', () => mainWindow.close());

// ── IPC: Profile ───────────────────────────────────────────
ipcMain.handle('get-profile', () => ProfileStore.get(store));
ipcMain.handle('save-profile', (_, profile) => ProfileStore.save(store, profile));

// ── IPC: Network ───────────────────────────────────────────
ipcMain.handle('get-local-ips', () => {
  const nets = os.networkInterfaces();
  const results = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        results.push({ name, address: addr.address });
      }
    }
  }
  return results;
});

ipcMain.handle('get-online-players', () => {
  return discovery ? discovery.getPlayers() : [];
});

// ── IPC: Game server ───────────────────────────────────────
ipcMain.handle('get-server-status', () => ({
  hosting: !!activeGameServer,
  port: activeGameServer ? activeGameServer.port : null
}));

ipcMain.handle('start-game-server', async (_, { port = 7777 } = {}) => {
  if (activeGameServer) {
    activeGameServer.stop();
    activeGameServer = null;
  }
  activeGameServer = new CosmicBombServer(port);
  await activeGameServer.start();
  if (discovery) discovery.setHosting(port);
  return { ok: true, port };
});

ipcMain.handle('stop-game-server', () => {
  if (activeGameServer) {
    activeGameServer.stop();
    activeGameServer = null;
  }
  if (discovery) discovery.setHosting(null);
  return { ok: true };
});

// ── IPC: Word validation ───────────────────────────────────
ipcMain.handle('validate-word', (_, { word, key }) => {
  return WordValidator.validate(word, key);
});

ipcMain.handle('download-wordlist', async () => {
  try {
    const result = await WordValidator.downloadWordlist();
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wordlist-status', () => WordValidator.getStatus());

// ── IPC: Discord webhook ────────────────────────────────────
ipcMain.handle('notify-discord', async (_, { winnerName, winnerIcon, gameName, totalPlayers, totalRounds }) => {
  const webhookUrl = cfg.discordWebhook;
  if (!webhookUrl) return { ok: false, reason: 'not_configured' };

  const axios = require('axios');
  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title: `${winnerIcon || '🏆'} ${winnerName} venceu uma partida!`,
        description: `**${gameName}** · ${totalPlayers} jogadores · ${totalRounds} rodadas`,
        color: 0x8b5cf6,
        footer: { text: 'Cosmic Games' },
        timestamp: new Date().toISOString()
      }]
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Supabase scores ────────────────────────────────────
const cfg = (() => { try { return require('./src/config'); } catch { return {}; } })();
const SUPA_URL = cfg.supabaseUrl;
const SUPA_KEY = cfg.supabaseKey;
const supaHeaders = SUPA_KEY ? {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
} : null;

ipcMain.handle('submit-score', async (_, { game, playerUuid, playerName, score, metadata }) => {
  if (!supaHeaders) return { ok: false, reason: 'not_configured' };
  const axios = require('axios');
  try {
    await axios.post(
      `${SUPA_URL}/rest/v1/scores`,
      { game, player_uuid: playerUuid, player_name: playerName, score: score || 1, metadata: metadata || null },
      { headers: supaHeaders }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-leaderboard', async (_, { game, limit = 10 }) => {
  if (!supaHeaders) return { ok: false, reason: 'not_configured', data: [] };
  const axios = require('axios');
  try {
    // Busca até 1000 registros e agrupa por player no JS (suficiente para grupo de amigos)
    const res = await axios.get(
      `${SUPA_URL}/rest/v1/scores?game=eq.${game}&select=player_uuid,player_name,score&limit=1000`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );

    const grouped = {};
    for (const row of res.data) {
      if (!grouped[row.player_uuid]) {
        grouped[row.player_uuid] = { name: row.player_name, wins: 0 };
      }
      grouped[row.player_uuid].wins += row.score;
    }

    const data = Object.values(grouped)
      .sort((a, b) => b.wins - a.wins)
      .slice(0, limit)
      .map((p, i) => ({ rank: i + 1, name: p.name, wins: p.wins }));

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message, data: [] };
  }
});

// ── Auto-updater events ─────────────────────────────────────
if (autoUpdater) {
  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info);
  });
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update-downloaded');
  });
  ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
}
