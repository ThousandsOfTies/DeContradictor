const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const PROFILE_SCOPE = 'openid email profile';
const SETTINGS_FILE = 'decontradictor-settings.json';

export function validateDriveSettings(input) {
  if (input?.app !== 'decontradictor-live-settings' || input.version !== 1 || typeof input.apiKey !== 'string') {
    throw new Error('Drive設定ファイルの形式が不正です。');
  }
  return {
    app: 'decontradictor-live-settings', version: 1,
    apiKey: input.apiKey.trim().slice(0, 500),
    voice: typeof input.voice === 'string' ? input.voice.slice(0, 50) : '',
    avatarColor: ['auto', 'blue', 'pink'].includes(input.avatarColor) ? input.avatarColor : 'auto',
    direction: typeof input.direction === 'string' ? input.direction.slice(0, 1000) : '',
  };
}

function multipartJson(metadata, data) {
  const boundary = `decontra_${crypto.randomUUID()}`;
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`, JSON.stringify(data),
    `\r\n--${boundary}--\r\n`,
  ], { type: `multipart/related; boundary=${boundary}` });
}

export class LiveGoogleAccount {
  constructor(onChange, onError) {
    this.onChange = onChange;
    this.onError = onError;
    this.profile = null;
    this.token = null;
    this.expiresAt = 0;
    this.hasDrive = false;
    this.generation = 0;
  }

  async init(clientId) {
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      throw new Error('Googleログイン用のOAuthクライアントIDを設定してください。');
    }
    if (!window.google?.accounts?.oauth2) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = setTimeout(() => { script.remove(); reject(new Error('Googleログインの読み込みがタイムアウトしました。')); }, 15000);
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Googleログインを読み込めませんでした。')); };
        document.head.append(script);
      });
    }
    this.client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: PROFILE_SCOPE,
      callback: response => this.receive(response),
      error_callback: () => this.fail(new Error('ログイン画面が閉じられたか、ポップアップがブロックされました。')),
    });
    this.clientId = clientId;
    // ページを開いたままの再読み込みに限って復元。期限切れ時はボタンから再認証する。
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('decontradictor.live.google') || 'null'); } catch (_) {}
    if (saved?.clientId === clientId && saved.expiresAt > Date.now()) {
      this.token = saved.token; this.expiresAt = saved.expiresAt; this.hasDrive = saved.hasDrive === true;
      try { await this.fetchProfile(); } catch (_) { this.signOut(); }
    }
  }

  login({ drive = false } = {}) {
    if (!this.client) return Promise.reject(new Error('先にGoogleログイン設定を保存してください。'));
    if (this.pending) return Promise.reject(new Error('Googleの認証画面を確認してください。'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.client.requestAccessToken({
        scope: drive ? `${PROFILE_SCOPE} ${DRIVE_SCOPE} ${APPDATA_SCOPE}` : PROFILE_SCOPE,
        prompt: this.profile ? '' : 'select_account',
        ...(this.profile?.email ? { hint: this.profile.email } : {}),
      }); } catch (_) { this.fail(new Error('Googleの認証画面を開けませんでした。')); }
    });
  }

  fail(error) {
    const pending = this.pending; this.pending = null;
    if (pending) pending.reject(error);
    else this.onError(error.message);
  }

  async receive(response) {
    const attempt = this.pending;
    if (!attempt) return;
    if (response.error || !response.access_token) { this.fail(new Error('Googleログインが許可されませんでした。')); return; }
    this.token = response.access_token;
    this.expiresAt = Date.now() + Math.max(0, Number(response.expires_in) - 60) * 1000;
    this.hasDrive = window.google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE, APPDATA_SCOPE);
    try {
      await this.fetchProfile();
      if (this.pending !== attempt) return;
      sessionStorage.setItem('decontradictor.live.google', JSON.stringify({
        clientId: this.clientId, token: this.token, expiresAt: this.expiresAt, hasDrive: this.hasDrive,
      }));
      const pending = this.pending; this.pending = null; pending?.resolve(this.profile);
    } catch (error) {
      if (this.pending === attempt) { this.fail(error); this.signOut(); }
    }
  }

  get signedIn() { return !!this.token && this.expiresAt > Date.now() && !!this.profile; }

  async fetchProfile() {
    const generation = this.generation;
    const response = await this.request('https://www.googleapis.com/oauth2/v3/userinfo');
    const info = await response.json();
    if (generation !== this.generation) throw new Error('アカウントが変更されました。');
    if (!info.sub) throw new Error('Googleアカウント情報を取得できませんでした。');
    this.profile = { id: info.sub, name: info.name || '自分', picture: info.picture || '', email: info.email || '' };
    this.onChange(this.profile);
  }

  signOut() {
    if (this.pending) this.fail(new Error('Googleログインを中止しました。'));
    this.generation++;
    this.token = null; this.expiresAt = 0; this.profile = null; this.hasDrive = false;
    try { sessionStorage.removeItem('decontradictor.live.google'); } catch (_) {}
    this.onChange(null);
  }

  async request(url, options = {}) {
    if (!this.token || Date.now() >= this.expiresAt) throw new Error('Googleの認証期限が切れました。再度ログインしてください。');
    const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${this.token}` } });
    if (response.status === 401) { this.signOut(); throw new Error('Googleへ再度ログインしてください。'); }
    if (!response.ok) throw new Error(`Google APIエラー (${response.status})。Drive APIの有効化・アクセス許可を確認してください。`);
    return response;
  }

  async authorizeDrive() {
    if (!this.signedIn || !this.hasDrive) await this.login({ drive: true });
    if (!this.hasDrive) throw new Error('Google Driveへの保存許可が必要です。');
  }

  async findSettingsFile() {
    const q = `name = '${SETTINGS_FILE}' and trashed = false`;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
    return (await response.json()).files?.[0]?.id || null;
  }

  async loadSettings() {
    await this.authorizeDrive();
    const id = await this.findSettingsFile();
    if (!id) return null;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    return validateDriveSettings(await response.json());
  }

  async saveSettings(input) {
    await this.authorizeDrive();
    const settings = validateDriveSettings(input);
    const id = await this.findSettingsFile();
    if (id) {
      await this.request(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
      });
      return id;
    }
    const body = multipartJson({ name: SETTINGS_FILE, mimeType: 'application/json', parents: ['appDataFolder'] }, settings);
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body });
    return (await response.json()).id;
  }

  async deleteSettings() {
    await this.authorizeDrive();
    const id = await this.findSettingsFile();
    if (id) await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return !!id;
  }

  async findSessionFile(issueId) {
    if (!issueId) return null;
    const q = `trashed=false and appProperties has { key='application' and value='decontradictor-live' } and appProperties has { key='issueId' and value='${issueId.replace(/'/g, "\\'")}' }`;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=10`);
    return (await response.json()).files?.[0] || null;
  }

  async save(session, sync = null) {
    await this.authorizeDrive();
    if (!session.issueId) throw new Error('課題IDがありません。画面を再読み込みしてください。');
    if (sync?.id) {
      const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sync.id)}?fields=id,modifiedTime`);
      const current = await response.json();
      if (sync.modifiedTime && current.modifiedTime !== sync.modifiedTime) {
        throw new Error('Drive上の会話が別の端末で更新されました。自動同期を止めました。Driveから読込んで確認してください。');
      }
    } else if (await this.findSessionFile(session.issueId)) {
      throw new Error('同じ課題がDriveにあります。先にDrive一覧から読込んでください。');
    }
    const metadata = {
      name: `DeContra-${session.title.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      mimeType: 'application/json', appProperties: { application: 'decontradictor-live', issueId: session.issueId },
    };
    const body = multipartJson(metadata, session);
    const endpoint = sync?.id
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(sync.id)}?uploadType=multipart&fields=id,name,modifiedTime`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime';
    const response = await this.request(endpoint, { method: sync?.id ? 'PATCH' : 'POST', body });
    return response.json();
  }

  async list() {
    await this.authorizeDrive();
    const query = "trashed=false and appProperties has { key='application' and value='decontradictor-live' }";
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=100`);
    return (await response.json()).files || [];
  }

  async load(id) {
    if (!this.signedIn || !this.hasDrive) throw new Error('Google Driveへ再接続してください。');
    const metadataResponse = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,modifiedTime`);
    const metadata = await metadataResponse.json();
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const text = await response.text();
    if (text.length > 10000000) throw new Error('ファイルが大きすぎます。');
    return { session: JSON.parse(text), sync: { id, modifiedTime: metadata.modifiedTime } };
  }
}
