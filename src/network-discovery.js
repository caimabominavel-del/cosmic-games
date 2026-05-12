const dgram = require('dgram');

const DISCOVERY_PORT = 47777;
const BROADCAST_INTERVAL = 5000;
const PLAYER_TIMEOUT = 15000;

class NetworkDiscovery {
  constructor(store) {
    this.store = store;
    this.players = new Map(); // uuid -> playerInfo
    this.socket = null;
    this.broadcastTimer = null;
    this.hostingPort = null; // null = não está hosting
  }

  setHosting(port) {
    this.hostingPort = port || null;
    // Broadcast imediatamente para os outros saberem
    this._broadcast();
  }

  start() {
    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        console.warn('Discovery socket error:', err.message);
      });

      this.socket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type !== 'cosmic_presence') return;
          const myUuid = this.store.get('profile.uuid');
          if (data.uuid === myUuid) return;

          this.players.set(data.uuid, {
            uuid: data.uuid,
            username: data.username,
            icon: data.icon,
            avatarBase64: data.avatarBase64 || null,
            ip: rinfo.address,
            hostingPort: data.hostingPort || null,
            lastSeen: Date.now()
          });
        } catch {}
      });

      this.socket.bind(DISCOVERY_PORT, () => {
        try { this.socket.setBroadcast(true); } catch {}
      });

      this.broadcastTimer = setInterval(() => {
        this._broadcast();
        this._pruneStale();
      }, BROADCAST_INTERVAL);

      setTimeout(() => this._broadcast(), 1500);
    } catch (err) {
      console.warn('Network discovery failed to start:', err.message);
    }
  }

  stop() {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.socket) {
      try { this.socket.close(); } catch {}
    }
  }

  getPlayers() {
    return Array.from(this.players.values());
  }

  _broadcast() {
    const profile = this.store.get('profile');
    if (!profile || !profile.username) return;

    const payload = {
      type: 'cosmic_presence',
      uuid: profile.uuid,
      username: profile.username,
      icon: profile.icon,
      avatarBase64: profile.avatarBase64 || null,
      hostingPort: this.hostingPort // null = não hosting; número = porta do servidor ativo
    };

    try {
      const buf = Buffer.from(JSON.stringify(payload));
      this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255');
    } catch {}
  }

  _pruneStale() {
    const now = Date.now();
    for (const [uuid, player] of this.players.entries()) {
      if (now - player.lastSeen > PLAYER_TIMEOUT) {
        this.players.delete(uuid);
      }
    }
  }
}

module.exports = NetworkDiscovery;
