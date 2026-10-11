// 起動時の認証復元はその画面で行い、起動後に利用者が変わった場合だけ再起動する。
export class LiveAccountRestart {
  constructor(restart, onError) {
    this.restart = restart;
    this.onError = onError;
    this.profileId = null;
    this.enabled = false;
    this.pending = null;
  }

  observe(profile) {
    if (this.pending) return true;
    const nextId = profile?.id || null;
    if (this.enabled && nextId !== this.profileId) {
      this.pending = Promise.resolve().then(() => this.restart()).catch(error => this.onError(error));
      return true;
    }
    this.profileId = nextId;
    return false;
  }

  enable() { this.enabled = true; }
}
