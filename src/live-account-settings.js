import { validateDriveSettings } from './live-google-account.js';

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: '', voice: 'Puck', direction: '', rememberKey: true,
});

// 記憶する設定はGoogleの利用者IDごとに保存する。匿名時は同じタブ内だけで一時共有する。
export class LiveAccountSettings {
  constructor(storage, temporaryStorage) { this.storage = storage; this.temporaryStorage = temporaryStorage; }

  load(profileId) {
    try {
      const storage = profileId ? this.storage : this.temporaryStorage;
      const saved = JSON.parse(storage?.getItem(this.key(profileId)) || 'null');
      if (!saved || saved.profileId !== profileId) return { ...DEFAULT_SETTINGS };
      const settings = validateDriveSettings(saved);
      const rememberKey = saved.rememberKey !== false;
      return { ...settings, apiKey: rememberKey ? settings.apiKey : '', rememberKey };
    } catch (_) { return { ...DEFAULT_SETTINGS }; }
  }

  hasSaved(profileId) {
    try {
      const storage = profileId ? this.storage : this.temporaryStorage;
      const saved = JSON.parse(storage?.getItem(this.key(profileId)) || 'null');
      if (!saved || saved.profileId !== profileId) return false;
      validateDriveSettings(saved);
      return true;
    } catch (_) { return false; }
  }

  save(profileId, input) {
    const storage = profileId ? this.storage : this.temporaryStorage;
    if (!storage) { if (!profileId) return; throw new Error('ブラウザ保存が利用できません。設定を記憶できませんでした。'); }
    const settings = validateDriveSettings({ ...input, app: 'decontradictor-live-settings', version: 1 });
    const rememberKey = input.rememberKey !== false;
    storage.setItem(this.key(profileId), JSON.stringify({ ...settings, profileId, rememberKey,
      apiKey: rememberKey ? settings.apiKey : '' }));
  }

  clearTemporary() { this.temporaryStorage?.removeItem(this.key(null)); }
  key(profileId) { return profileId ? 'decontradictor.live.settings.' + encodeURIComponent(profileId) : 'decontradictor.live.temporarySettings'; }
}
