const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cosmic', {
  // Window
  minimize:  () => ipcRenderer.invoke('win-minimize'),
  maximize:  () => ipcRenderer.invoke('win-maximize'),
  close:     () => ipcRenderer.invoke('win-close'),

  // Profile
  getProfile:  ()      => ipcRenderer.invoke('get-profile'),
  saveProfile: (p)     => ipcRenderer.invoke('save-profile', p),

  // Network
  getLocalIps:      () => ipcRenderer.invoke('get-local-ips'),
  getOnlinePlayers: () => ipcRenderer.invoke('get-online-players'),

  // Game server
  getServerStatus: ()     => ipcRenderer.invoke('get-server-status'),
  startGameServer: (opts) => ipcRenderer.invoke('start-game-server', opts),
  stopGameServer:  ()     => ipcRenderer.invoke('stop-game-server'),

  // Word validation
  validateWord:    (opts) => ipcRenderer.invoke('validate-word', opts),
  downloadWordlist: ()    => ipcRenderer.invoke('download-wordlist'),
  wordlistStatus:  ()     => ipcRenderer.invoke('wordlist-status'),

  // Scores (Supabase — stubs)
  submitScore:    (opts) => ipcRenderer.invoke('submit-score', opts),
  getLeaderboard: (opts) => ipcRenderer.invoke('get-leaderboard', opts),

  // Discord
  notifyDiscord: (opts) => ipcRenderer.invoke('notify-discord', opts),

  // Updates
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  installUpdate: () => ipcRenderer.invoke('install-update'),
});
