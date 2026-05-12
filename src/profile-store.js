const { v4: uuidv4 } = require('uuid');

const DEFAULT_ICONS = ['🚀', '⭐', '🌙', '💫', '🪐', '☄️', '👾', '🎮', '💥', '🌌', '🔥', '❄️'];

module.exports = {
  DEFAULT_ICONS,

  get(store) {
    const profile = store.get('profile');
    if (!profile) {
      return {
        uuid: uuidv4(),
        username: '',
        icon: '🚀',
        avatarBase64: null,
        configured: false
      };
    }
    return profile;
  },

  save(store, profile) {
    if (!profile.uuid) profile.uuid = uuidv4();
    profile.configured = true;
    store.set('profile', profile);
    return profile;
  }
};
