import '../src/home-page.css';
import { CommonSettings, robotColorForVoice } from '../src/common-settings.js';
import { DEFAULT_SETTINGS, LiveAccountSettings } from '../src/live-account-settings.js';

const memoryStorage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
const $ = id => document.getElementById(id), storage = memoryStorage(), temporary = memoryStorage();
const account = { profile: null, signedIn: false, hasDrive: false, generation: 0, loadSettings: async () => null };
const common = new CommonSettings({ account: () => account, settingsStorage: storage, temporaryStorage: temporary,
  onSyncChange: () => { $('test-sync-status').textContent = common.autoSyncEnabled ? '自動同期ON（模擬アカウント）' : '自動同期停止中（模擬アカウント）'; } });
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  const li = document.createElement('li'); li.textContent = 'PASS: ' + message; $('test-details').append(li);
};
const profile = id => {
  account.profile = id ? { id } : null; account.signedIn = !!id; account.hasDrive = !!id; account.generation++;
  common.setProfile(account.profile);
};
async function run() {
  check(common.$('live-voice-select').options.length === 30, '既存の30種類の声を共通設定に移動');
  check(common.$('live-avatar-color') === null && !('avatarColor' in common.values()), 'ロボアイコンの選択欄と保存設定を削除');
  check([...common.$('live-voice-select').options].every(option =>
    robotColorForVoice(option.value) === (option.parentElement.label.startsWith('女性') ? 'pink' : 'blue')),
    '30種類すべての声に合わせてロボアイコンの色を自動選択');
  common.apply({ ...DEFAULT_SETTINGS, voice: 'Zephyr', avatarColor: 'blue' });
  check(robotColorForVoice(common.values().voice) === 'pink' && !('avatarColor' in common.values()), '古い固定色の設定を読んでも声に合わせる');
  common.$('live-api-key').value = 'test-only-guest-key'; common.$('live-voice-select').value = 'Zephyr'; common.persist();
  const nextPage = new LiveAccountSettings(storage, temporary);
  check(nextPage.load(null).apiKey === 'test-only-guest-key' && nextPage.load(null).voice === 'Zephyr', 'TOPから実行画面へ同じタブ内の設定を引き継ぐ');
  profile('test-a');
  check(common.values().apiKey === '' && common.values().voice === DEFAULT_SETTINGS.voice, 'ログインで匿名の設定をリセット');
  common.$('live-api-key').value = 'test-only-a-key'; common.$('live-voice-select').value = 'Leda'; common.persist();
  profile('test-b');
  check(common.values().apiKey === '' && common.values().voice === DEFAULT_SETTINGS.voice, '別アカウントへキー・声を引き継がない');
  profile('test-a');
  check(common.values().apiKey === 'test-only-a-key' && common.values().voice === 'Leda', '元のアカウントで共通設定を復元');
  common.$('live-remember-key').checked = false; common.persist();
  check(nextPage.load('test-a').apiKey === '' && nextPage.load('test-a').voice === 'Leda', 'キーを記憶しなくても声などの設定は共有');
  check(common.autoSyncEnabled && common.$('common-auto-sync').checked, '自動同期は初期値ON');
  common.$('common-auto-sync').checked = false; common.$('common-auto-sync').dispatchEvent(new Event('change'));
  check(!common.autoSyncEnabled && common.$('common-sync-status').textContent.includes('停止中'), '共通設定から同期を停止できる');
  profile('test-b');
  check(common.autoSyncEnabled && common.$('common-auto-sync').checked, '同期の停止設定もアカウント別');
  profile('test-a'); common.syncPreference.setEnabled('test-a', true);
  let reads = 0;
  account.loadSettings = async () => { reads++; return { app: 'decontradictor-live-settings', version: 1, apiKey: 'test-only-old-key', voice: 'Puck', avatarColor: 'blue', direction: '' }; };
  await common.loadCloudSettings({ onlyIfMissing: true });
  check(reads === 0 && common.values().voice === 'Leda' && common.values().apiKey === '', '起動時にTOPの設定やキー削除を古いDrive設定で戻さない');
  profile('test-paused-new'); common.syncPreference.setEnabled('test-paused-new', false);
  await common.loadCloudSettings({ onlyIfMissing: true });
  check(reads === 0, '同期停止中は共通設定も自動でDriveから読まない');
  profile('test-new');
  await common.loadCloudSettings({ onlyIfMissing: true });
  check(reads === 1 && common.values().apiKey === 'test-only-old-key', '初めてのブラウザではDriveの共通設定から復元');
  profile('test-a');
  let finish;
  account.loadSettings = () => new Promise(resolve => { finish = resolve; });
  const remote = { app: 'decontradictor-live-settings', version: 1, apiKey: 'test-only-remote', voice: 'Puck', avatarColor: 'blue', direction: '' };
  const pending = common.loadCloudSettings();
  common.$('live-api-key').value = 'test-only-local-edit'; common.persist(); finish(remote); await pending;
  check(common.values().apiKey === 'test-only-local-edit', 'Drive読込中の編集を古い設定で上書きしない');
  const switching = common.loadCloudSettings();
  profile('test-b'); finish(remote); await switching;
  check(common.values().apiKey === '', '旧アカウントの遅い設定応答を反映しない');
  profile(null);
  check(common.values().apiKey === '' && common.values().voice === 'Puck', 'ログアウトで共通設定を初期値に戻す');
  profile('test-a'); common.syncPreference.setEnabled('test-a', true); common.$('live-api-key').value = ''; common.persist();
  common.updateControls();
  $('test-sync-status').textContent = '自動同期ON（模擬アカウント）';
  $('test-open-settings').addEventListener('click', () => common.show());
  const count = $('test-details').children.length;
  $('test-result').textContent = `${count} / ${count} PASS — 共通設定・同期設定を隔離して検証`;
}
run().catch(error => { $('test-result').textContent = 'FAIL: ' + error.message; console.error(error); });
