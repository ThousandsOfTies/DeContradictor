import './common-settings.css';
import { LiveAccountSettings, DEFAULT_SETTINGS } from './live-account-settings.js';
import { validateDriveSettings } from './live-google-account.js';
import { DriveSyncPreference } from './drive-sync-preference.js';

const voices = [
  ['女性系（声質の目安）', '♀', [
    ['Zephyr', '明るい (Bright)'], ['Kore', 'しっかり (Firm)'], ['Leda', '若々しい (Youthful)'],
    ['Aoede', '軽やか (Breezy)'], ['Callirrhoe', '穏やか (Easy-going)'], ['Autonoe', '明るい (Bright)'],
    ['Despina', 'なめらか (Smooth)'], ['Erinome', 'クリア (Clear)'], ['Laomedeia', '快活 (Upbeat)'],
    ['Achernar', 'やわらかい (Soft)'], ['Achird', '親しみやすい (Friendly)'], ['Vindemiatrix', 'やさしい (Gentle)'],
    ['Sadachbia', '活発 (Lively)'], ['Sulafat', 'あたたかい (Warm)'],
  ]],
  ['男性系（声質の目安）', '♂', [
    ['Puck', '明るく元気 (Upbeat)'], ['Charon', '情報的 (Informative)'], ['Fenrir', 'エネルギッシュ (Excitable)'],
    ['Orus', 'しっかり (Firm)'], ['Enceladus', '息づかい (Breathy)'], ['Iapetus', 'クリア (Clear)'],
    ['Umbriel', '落ち着いた (Easy-going)'], ['Algieba', 'なめらか (Smooth)'], ['Algenib', '低くざらついた (Gravelly)'],
    ['Rasalgethi', '情報的 (Informative)'], ['Alnilam', 'しっかり (Firm)'], ['Gacrux', '大人っぽい (Mature)'],
    ['Sadaltager', '知的 (Knowledgeable)'],
  ]],
  ['中性的・個人差あり', '◐', [['Schedar', '均一 (Even)'], ['Zubenelgenubi', 'カジュアル (Casual)'], ['Pulcherrima', '前向き (Forward)']]],
];

export function robotColorForVoice(voice) {
  return voices[0][2].some(([name]) => name === voice) ? 'pink' : 'blue';
}

export class CommonSettings {
  constructor({ account, onChange = () => {}, onSyncChange = () => {}, blocked = () => false, settingsStorage, temporaryStorage }) {
    this.account = account; this.onChange = onChange; this.onSyncChange = onSyncChange; this.blocked = blocked;
    let storage = settingsStorage, temporary = temporaryStorage;
    try { if (storage === undefined) storage = localStorage; if (temporary === undefined) temporary = sessionStorage; } catch (_) {}
    this.settingsStore = new LiveAccountSettings(storage, temporary);
    this.syncPreference = new DriveSyncPreference(storage);
    this.profileId = undefined;
    const root = document.getElementById('common-settings-root');
    root.innerHTML = `<dialog id="common-settings-dialog" aria-labelledby="common-settings-title">
      <header class="common-heading"><div><p>ALL ISSUES / PREFERENCES</p><h2 id="common-settings-title">共通設定</h2></div><button id="common-settings-close" type="button" aria-label="共通設定を閉じる">×</button></header>
      <p class="common-note">APIキー・声・会話の基本方針は、すべての課題で共通に使います。変更した声と基本方針は次のLive接続から適用します。</p>
      <section class="common-field"><label for="live-api-key">Google AI Studio APIキー</label><input id="live-api-key" type="password" placeholder="AIza..." autocomplete="off" spellcheck="false">
        <div class="common-key-memory"><label><input id="live-remember-key" type="checkbox" checked> このアカウントでブラウザに記憶</label><button id="live-forget-key" type="button">このアカウントのキーを削除</button></div>
        <p id="live-key-memory-status" class="common-note"></p>
      </section>
      <section class="common-field"><label for="live-voice-select">応答音声</label><select id="live-voice-select">${voices.map(([label, icon, items]) => `<optgroup label="${label}">${items.map(([name, tone]) => `<option value="${name}">${icon} ${name} — ${tone}</option>`).join('')}</optgroup>`).join('')}</select>
        <p class="common-note">男女の分類は声質の印象による目安で、公式の性別属性ではありません。ロボアイコンは声に合わせて自動で切り替わります。</p>
      </section>
      <section class="common-field"><label for="live-direction-input">会話の基本方針（全課題共通）</label><textarea id="live-direction-input" rows="3" maxlength="1000" placeholder="例：結論と理由を短く伝え、不明なことは不明と伝えてください。"></textarea></section>
      <section class="common-field"><label class="common-toggle"><input id="common-auto-sync" type="checkbox" checked> Google Driveの自動同期</label>
        <p class="common-note">通常はON。ログイン中の課題は自動でDriveへ登録し、変更を同期します。OFFにすると、このブラウザのこのアカウントだけ同期を停止します。ローカル保存は続け、Driveの課題は消しません。再開すると未送信分も同期します。開始済みの通信は完了する場合があります。</p>
        <p id="common-sync-status" role="status"></p>
      </section>
      <details class="common-field"><summary>共通設定のDrive保存・読込</summary>
        <div class="common-actions"><button id="live-save-settings-drive" type="button">共通設定をDriveへ保存</button><button id="live-load-settings-drive" type="button">Driveの共通設定を読込</button><button id="live-delete-settings-drive" type="button">Driveの共通設定を削除</button></div>
        <p class="common-note">課題の自動同期とは別の操作です。APIキーも含めてDriveのアプリ専用領域へJSONで保存します（暗号化なし）。共有PCではブラウザへのキーの記憶をOFFにしてください。自動同期の停止設定はDriveには保存しません。</p>
        <p class="common-note">OAuthクライアントIDは設定済みです。Google Drive APIの有効化が必要です。承認済みJavaScript生成元：<code id="live-google-origin"></code></p>
      </details>
      <p id="common-settings-status" role="status"></p>
    </dialog>`;
    this.$ = id => root.querySelector('#' + id);
    this.dialog = this.$('common-settings-dialog');
    this.$('live-google-origin').textContent = location.origin;
    this.$('common-settings-close').addEventListener('click', () => this.dialog.close());
    for (const [id, event] of [['live-api-key', 'input'], ['live-remember-key', 'change'], ['live-voice-select', 'change'], ['live-direction-input', 'input']]) {
      this.$(id).addEventListener(event, () => this.persist());
    }
    this.$('live-forget-key').addEventListener('click', () => {
      this.$('live-api-key').value = ''; this.$('live-remember-key').checked = false; this.persist();
      this.tell('このアカウントのブラウザ内APIキーを削除しました。Driveの設定は残しています。');
    });
    this.$('common-auto-sync').addEventListener('change', () => {
      try { this.syncPreference.setEnabled(this.profileId, this.$('common-auto-sync').checked); this.updateControls(); this.onSyncChange(); }
      catch (error) { this.updateControls(); this.tell(error.message); }
    });
    this.action('live-save-settings-drive', async () => {
      const active = this.requireDrive(), generation = active.generation;
      await active.saveSettings(this.values());
      if (this.account() === active && active.generation === generation) this.tell('共通設定をDriveへ保存しました。APIキーも設定ファイルに含まれます。');
    });
    this.action('live-load-settings-drive', () => this.loadCloudSettings());
    this.action('live-delete-settings-drive', async () => {
      const active = this.requireDrive();
      if (!window.confirm('Drive上の共通設定（APIキーなど）を削除しますか？課題とブラウザ内の設定は残ります。')) return;
      await active.deleteSettings(); this.tell('Driveの共通設定を削除しました。課題とブラウザ内の設定は残っています。');
    });
    window.addEventListener('storage', event => {
      if (this.profileId && (event.key === this.syncPreference.key(this.profileId) || event.key === null)) {
        this.updateControls(); this.onSyncChange();
      }
      if (this.profileId && event.key === this.settingsStore.key(this.profileId)) this.apply(this.settingsStore.load(this.profileId));
    });
    this.setProfile(null);
  }

  get autoSyncEnabled() { return this.syncPreference.enabled(this.account()?.profile?.id); }
  tell(message) { this.$('common-settings-status').textContent = message; }
  show() { this.updateControls(); this.dialog.showModal(); }
  values() {
    return validateDriveSettings({ app: 'decontradictor-live-settings', version: 1,
      apiKey: this.$('live-api-key').value, voice: this.$('live-voice-select').value,
      direction: this.$('live-direction-input').value });
  }
  setProfile(profile) {
    const next = profile?.id || null;
    if (next !== this.profileId) {
      if (this.profileId !== undefined && next !== this.profileId) this.settingsStore.clearTemporary();
      this.profileId = next; this.apply(this.settingsStore.load(next));
    }
    this.updateControls();
  }
  apply(settings) {
    this.$('live-api-key').value = settings.apiKey;
    this.$('live-remember-key').checked = settings.rememberKey !== false;
    this.$('live-voice-select').value = voices.some(([, , items]) => items.some(([name]) => name === settings.voice)) ? settings.voice : DEFAULT_SETTINGS.voice;
    this.$('live-direction-input').value = settings.direction;
    this.onChange(this.values()); this.updateControls();
  }
  persist() {
    if (this.blocked()) return;
    try {
      this.settingsStore.save(this.profileId, { ...this.values(), rememberKey: this.$('live-remember-key').checked });
      this.onChange(this.values()); this.updateControls();
    } catch (error) { this.tell(error.message); }
  }
  updateControls() {
    const active = this.account(), signedIn = !!active?.signedIn;
    this.$('live-remember-key').disabled = !signedIn;
    this.$('live-forget-key').disabled = !signedIn;
    this.$('live-key-memory-status').textContent = !signedIn ? '未ログイン時はこのタブの間だけ共有します。ログイン・ログアウトでリセットします。'
      : this.$('live-remember-key').checked && this.$('live-api-key').value.trim() ? 'このアカウントでブラウザに記憶済み' : 'APIキーはブラウザに記憶しません。';
    this.$('common-auto-sync').checked = this.autoSyncEnabled;
    this.$('common-auto-sync').disabled = !signedIn;
    this.$('common-sync-status').textContent = !signedIn ? 'Googleログイン後に自動同期します。'
      : this.autoSyncEnabled ? '自動同期：ON' : '自動同期：停止中（ローカル保存は継続）';
    for (const id of ['live-save-settings-drive', 'live-load-settings-drive', 'live-delete-settings-drive']) this.$(id).disabled = !signedIn || !active.hasDrive;
  }
  requireDrive() {
    const active = this.account();
    if (this.blocked() || !active?.signedIn || !active.hasDrive) throw new Error('TOPからGoogleへログインしてDriveへのアクセスを許可してください。');
    return active;
  }
  async loadCloudSettings({ onlyIfMissing = false } = {}) {
    const active = this.requireDrive(), profileId = active.profile.id, generation = active.generation;
    if (onlyIfMissing && (!this.autoSyncEnabled || this.settingsStore.hasSaved(profileId))) return;
    const before = JSON.stringify(this.values());
    const settings = await active.loadSettings();
    if (this.blocked() || !active.signedIn || this.account() !== active || active.profile?.id !== profileId || active.generation !== generation) return;
    if (onlyIfMissing && (!this.autoSyncEnabled || this.settingsStore.hasSaved(profileId))) return;
    if (!settings) { this.tell('Driveの共通設定はまだありません。必要なら「共通設定をDriveへ保存」を押してください。'); return; }
    if (JSON.stringify(this.values()) !== before) { this.tell('読込中に設定が変更されたため、手元の設定を残しました。'); return; }
    this.apply({ ...settings, rememberKey: this.$('live-remember-key').checked });
    this.persist(); this.tell('このアカウントの共通設定をDriveから読み込みました。');
  }
  action(id, action) {
    this.$(id).addEventListener('click', async () => {
      this.$(id).disabled = true;
      try { await action(); } catch (error) { this.tell(error.message); }
      finally { this.updateControls(); }
    });
  }
}
