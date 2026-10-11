import { validateSession } from './live-session-store.js';

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
      try { await this.fetchProfile(); this.onChange(this.profile); } catch (_) { this.signOut(); }
      this.scheduleExpiry();
    }
  }

  login({ drive = false, selectAccount = false } = {}) {
    if (!this.client) return Promise.reject(new Error('先にGoogleログイン設定を保存してください。'));
    if (this.pending) return Promise.reject(new Error('Googleの認証画面を確認してください。'));
    this.generation++;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.client.requestAccessToken({
        scope: drive ? `${PROFILE_SCOPE} ${DRIVE_SCOPE} ${APPDATA_SCOPE}` : PROFILE_SCOPE,
        prompt: selectAccount || !this.profile ? 'select_account' : '',
        ...(!selectAccount && this.profile?.email ? { hint: this.profile.email } : {}),
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
      this.scheduleExpiry();
      const pending = this.pending; this.pending = null;
      // 再起動の通知より先に、新しい認証をタブへ保存しておく。
      this.onChange(this.profile);
      pending?.resolve(this.profile);
    } catch (error) {
      if (this.pending === attempt) { this.fail(error); this.signOut(); }
    }
  }

  get signedIn() { return !this.pending && !!this.token && this.expiresAt > Date.now() && !!this.profile; }

  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.token) return;
    this.expiryTimer = setTimeout(() => this.signOut(), Math.max(0, this.expiresAt - Date.now()));
    this.expiryTimer?.unref?.();
  }

  async fetchProfile() {
    const generation = this.generation;
    const response = await this.request('https://www.googleapis.com/oauth2/v3/userinfo');
    const info = await response.json();
    if (generation !== this.generation) throw new Error('アカウントが変更されました。');
    if (!info.sub) throw new Error('Googleアカウント情報を取得できませんでした。');
    this.profile = { id: info.sub, name: info.name || '自分', picture: info.picture || '', email: info.email || '' };
  }

  signOut() {
    clearTimeout(this.expiryTimer);
    if (this.pending) this.fail(new Error('Googleログインを中止しました。'));
    this.generation++;
    this.token = null; this.expiresAt = 0; this.profile = null; this.hasDrive = false;
    try { sessionStorage.removeItem('decontradictor.live.google'); } catch (_) {}
    this.onChange(null);
  }

  async request(url, options = {}) {
    if (!this.token || Date.now() >= this.expiresAt) throw new Error('Googleの認証期限が切れました。再度ログインしてください。');
    const token = this.token, generation = this.generation;
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000),
      headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      // 旧アカウントの遅い応答で、切替後のログインまで解除しない。
      if (this.token === token && this.generation === generation) this.signOut();
      throw new Error('Googleへ再度ログインしてください。');
    }
    if (!response.ok) {
      const error = new Error(response.status === 412
        ? 'Drive上の課題が照合中に更新されました。もう一度同期してください。'
        : `Google APIエラー (${response.status})。Drive APIの有効化・アクセス許可を確認してください。`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async authorizeDrive() {
    const previousId = this.profile?.id;
    if (!this.signedIn || !this.hasDrive) await this.login({ drive: true });
    if (previousId !== this.profile?.id) throw new Error('Googleアカウントの変更を反映するため、課題一覧を再読み込みします。');
    if (!this.hasDrive) throw new Error('Google Driveへの保存許可が必要です。');
  }

  settingsAccountCheck() {
    const profileId = this.profile?.id, generation = this.generation;
    return () => {
      if (!this.signedIn || this.profile?.id !== profileId || this.generation !== generation) {
        throw new Error('Googleアカウントが変わったため、設定の処理を中止しました。');
      }
    };
  }

  async findSettingsFile() {
    const q = `name = '${SETTINGS_FILE}' and trashed = false`;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
    return (await response.json()).files?.[0]?.id || null;
  }

  async loadSettings() {
    await this.authorizeDrive();
    const check = this.settingsAccountCheck();
    const id = await this.findSettingsFile();
    check();
    if (!id) return null;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const settings = validateDriveSettings(await response.json());
    check();
    return settings;
  }

  async saveSettings(input) {
    await this.authorizeDrive();
    const check = this.settingsAccountCheck();
    const settings = validateDriveSettings(input);
    const id = await this.findSettingsFile();
    check();
    if (id) {
      await this.request(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
      });
      check();
      return id;
    }
    const body = multipartJson({ name: SETTINGS_FILE, mimeType: 'application/json', parents: ['appDataFolder'] }, settings);
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body });
    const saved = await response.json();
    check();
    return saved.id;
  }

  async deleteSettings() {
    await this.authorizeDrive();
    const check = this.settingsAccountCheck();
    const id = await this.findSettingsFile();
    check();
    if (id) await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    check();
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
    const profileId = this.profile.id, generation = this.generation;
    const checkAccount = () => {
      if (this.profile?.id !== profileId || this.generation !== generation || (sync?.profileId && sync.profileId !== profileId)) {
        throw new Error('Googleアカウントが切り替わりました。同期をやり直してください。');
      }
    };
    checkAccount();
    let etag;
    if (!session.issueId) throw new Error('課題IDがありません。画面を再読み込みしてください。');
    if (sync?.id) {
      const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sync.id)}?fields=id,modifiedTime`);
      const current = await response.json();
      checkAccount();
      etag = response.headers.get('etag');
      if (sync.modifiedTime && current.modifiedTime !== sync.modifiedTime) {
        throw new Error('Drive上の会話が別の端末で更新されました。自動同期を止めました。Driveから読込んで確認してください。');
      }
    } else if (await this.findSessionFile(session.issueId)) {
      throw new Error('同じ課題がDriveにあります。先にDrive一覧から読込んでください。');
    }
    checkAccount();
    const metadata = {
      name: `DeContra-${session.title.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      mimeType: 'application/json', appProperties: { application: 'decontradictor-live', issueId: session.issueId },
    };
    const body = multipartJson(metadata, session);
    const endpoint = sync?.id
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(sync.id)}?uploadType=multipart&fields=id,name,modifiedTime`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime';
    const response = await this.request(endpoint, { method: sync?.id ? 'PATCH' : 'POST', body,
      ...(etag ? { headers: { 'If-Match': etag } } : {}) });
    const saved = await response.json();
    checkAccount();
    return saved;
  }

  async list() {
    await this.authorizeDrive();
    const query = "trashed=false and appProperties has { key='application' and value='decontradictor-live' }";
    const files = [];
    const seenPages = new Set();
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: query, fields: 'nextPageToken,incompleteSearch,files(id,name,modifiedTime,appProperties)', orderBy: 'modifiedTime desc', pageSize: '1000', corpora: 'user' });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.request(`https://www.googleapis.com/drive/v3/files?${params}`);
      const page = await response.json();
      if (page.incompleteSearch || !Array.isArray(page.files)) throw new Error('Driveの一覧を完全に取得できませんでした。ローカルの課題は削除していません。');
      files.push(...page.files);
      pageToken = page.nextPageToken || '';
      if (pageToken && seenPages.has(pageToken)) throw new Error('Drive一覧のページ取得が重複しました。再度接続してください。');
      seenPages.add(pageToken);
    } while (pageToken);
    return files;
  }

  async trashIssue(issueId, sync) {
    if (!issueId || !sync?.id || !sync.profileId || !this.signedIn || !this.hasDrive || sync.profileId !== this.profile?.id) {
      throw new Error('この課題を登録したGoogleアカウントへ接続してください。');
    }
    const profileId = this.profile.id, generation = this.generation;
    const check = () => {
      if (!this.signedIn || !this.hasDrive || this.profile?.id !== profileId || this.generation !== generation) {
        throw new Error('Googleアカウントが変わったため、課題の削除を中止しました。');
      }
    };
    const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sync.id)}`;
    const response = await this.request(endpoint + '?fields=id,mimeType,modifiedTime,trashed,appProperties,capabilities(canTrash)');
    const file = await response.json();
    check();
    if (file.id !== sync.id || file.mimeType !== 'application/json' || file.appProperties?.application !== 'decontradictor-live') {
      throw new Error('削除対象がこのアプリの課題ファイルではありません。削除を中止しました。');
    }
    let remoteIssueId = file.appProperties.issueId;
    if (!remoteIssueId) {
      // UUID導入前の課題も、本文または既存の安定IDで対象を確認する。
      const media = await this.request(endpoint + '?alt=media');
      const content = await media.text();
      if (content.length > 10000000) throw new Error('ファイルが大きすぎます。削除を中止しました。');
      remoteIssueId = validateSession(JSON.parse(content)).issueId;
      if (!remoteIssueId) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sync.id));
        remoteIssueId = 'drive-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
      }
    }
    check();
    if (remoteIssueId !== issueId) throw new Error('Driveファイルの課題IDが一致しません。削除を中止しました。');
    if (file.trashed === true) return { id: sync.id, trashed: true };
    if (sync.modifiedTime && file.modifiedTime !== sync.modifiedTime) {
      throw new Error('Drive上の課題が更新されています。「同期・更新」で確認してから削除し直してください。');
    }
    if (file.capabilities?.canTrash === false) throw new Error('このDriveファイルをゴミ箱へ移す権限がありません。');
    const etag = response.headers.get('etag');
    const saved = await this.request(endpoint + '?fields=id,trashed', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
      body: JSON.stringify({ trashed: true }),
    });
    const result = await saved.json();
    check();
    if (result.id !== sync.id || result.trashed !== true) throw new Error('Driveのゴミ箱への移動を確認できませんでした。ローカルの課題は残しています。');
    return result;
  }

  async load(id) {
    if (!this.signedIn || !this.hasDrive) throw new Error('Google Driveへ再接続してください。');
    const profileId = this.profile.id, generation = this.generation;
    const metadataResponse = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,modifiedTime`);
    const metadata = await metadataResponse.json();
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const text = await response.text();
    if (text.length > 10000000) throw new Error('ファイルが大きすぎます。');
    // 本文取得の前後で版が変わっていないことを確認する。
    const afterResponse = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,modifiedTime`);
    const after = await afterResponse.json();
    if (after.modifiedTime !== metadata.modifiedTime) throw new Error('Driveの課題が取得中に更新されました。もう一度同期してください。');
    if (this.profile?.id !== profileId || this.generation !== generation) throw new Error('Googleアカウントが切り替わりました。取得をやり直してください。');
    return { session: JSON.parse(text), sync: { id, modifiedTime: metadata.modifiedTime } };
  }
}
