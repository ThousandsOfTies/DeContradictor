// 停止はこのブラウザ・このGoogleアカウントだけ。別アカウントへ引き継がない。
export class DriveSyncPreference {
  constructor(storage) { this.storage = storage; }
  key(profileId) { return 'decontradictor.live.autoSync.' + encodeURIComponent(profileId); }
  enabled(profileId) {
    if (!profileId) return true;
    try { return this.storage?.getItem(this.key(profileId)) !== 'paused'; } catch (_) { return true; }
  }
  setEnabled(profileId, enabled) {
    if (!profileId || !this.storage) throw new Error('Googleログインとブラウザ保存を確認してください。');
    if (enabled) this.storage.removeItem(this.key(profileId));
    else this.storage.setItem(this.key(profileId), 'paused');
  }
}
