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

// ── IPC: Discord webhook (stub — filled in later) ──────────
ipcMain.handle('notify-discord', async (_, { message }) => {
  // TODO: configure webhook URL in settings
  const webhookUrl = store.get('discord.webhookUrl');
  if (!webhookUrl) return { ok: false, reason: 'not_configured' };

  const axios = require('axios');
  try {
    await axios.post(webhookUrl, { content: message });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Supabase scores (stub — filled in later) ──────────
ipcMain.handle('submit-score', async (_, { game, playerUuid, playerName, score, metadata }) => {
  // TODO: configure Supabase URL + anon key
  const supabaseUrl  = store.get('supabase.url');
  const supabaseKey  = store.get('supabase.anonKey');
  if (!supabaseUrl || !supabaseKey) return { ok: false, reason: 'not_configured' };

  const axios = require('axios');
  try {
    const res = await axios.post(
      `${supabaseUrl}/rest/v1/scores`,
      { game, player_uuid: playerUuid, player_name: playerName, score, metadata },
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-leaderboard', async (_, { game, limit = 10 }) => {
  const supabaseUrl = store.get('supabase.url');
  const supabaseKey = store.get('supabase.anonKey');
  if (!supabaseUrl || !supabaseKey) return { ok: false, reason: 'not_configured', data: [] };

  const axios = require('axios');
  try {
    const res = await axios.get(
      `${supabaseUrl}/rest/v1/scores?game=eq.${game}&order=score.desc&limit=${limit}`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    return { ok: true, data: res.data };
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
