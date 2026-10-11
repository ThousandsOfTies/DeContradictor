import './live-page.css';
import { initGeminiLive } from './gemini-live.js';
import { LiveFlowCanvas } from './live-flow.js';
import { LiveChat } from './live-chat.js';
import { EMOTIONS, profileAvatar, normalizeEmotion } from './live-emotions.js';
import { LiveSessionStore, validateSession } from './live-session-store.js';
import { LiveGoogleAccount, validateDriveSettings } from './live-google-account.js';

const $ = id => document.getElementById(id);
const prefix = 'decontradictor.live.';
const GOOGLE_OAUTH_CLIENT_ID = '171114049080-c880d878cqorg8ghs5qid5v2vmi1gvuc.apps.googleusercontent.com';
const tell = message => { $('live-save-status').textContent = message; };
function setting(name, fallback = '') {
  try { return localStorage.getItem(prefix + name) ?? fallback; } catch (_) { return fallback; }
}
function remember(name, value) {
  try {
    if (value === null) localStorage.removeItem(prefix + name);
    else localStorage.setItem(prefix + name, value);
    return true;
  } catch (_) { tell('ブラウザ保存が利用できません。設定を記憶できませんでした。'); return false; }
}
const llm = { apiKey: '' };
const store = new LiveSessionStore();
let ready = false, restoring = false, timer, logs = [], probe, account;
let issueId = crypto.randomUUID(), cloudSession = null, cloudTimer, cloudQueue = Promise.resolve(), editVersion = 0;
const flowCanvas = new LiveFlowCanvas($('live-flow-svg'), {
  emptyElement: $('live-flow-empty'), onChange: scheduleDraft,
});
const chat = new LiveChat($('live-chat-list'), scheduleDraft);

$('live-open-settings-btn').addEventListener('click', () => {
  const details = $('live-storage-settings');
  details.open = true;
  details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function snapshot() {
  const key = $('live-api-key').value.trim();
  const safeLogs = logs.map(l => ({ ...l, text: key ? l.text.split(key).join('[APIキー非表示]') : l.text }));
  return validateSession({ app: 'decontradictor-live', version: 1,
    issueId, title: $('live-session-title').value, savedAt: new Date().toISOString(),
    messages: chat.messages, logs: safeLogs, graph: flowCanvas.getState() });
}
function scheduleDraft() {
  if (!ready || restoring) return;
  editVersion++;
  clearTimeout(timer);
  timer = setTimeout(() => saveDraft().catch(() => tell('自動保存に失敗しました。JSON出力で退避してください。')), 600);
}
async function saveDraft() {
  clearTimeout(timer);
  if (ready && !restoring) {
    await store.save('draft', snapshot());
    scheduleCloudSync();
  }
}
function clearCloudSession() {
  clearTimeout(cloudTimer);
  cloudSession = null;
  $('live-drive-sync-state').textContent = 'Drive未同期';
}
function setCloudSession(sync) {
  cloudSession = { id: sync.id, modifiedTime: sync.modifiedTime || '' };
  if (account?.profile?.id) remember('cloudLink', JSON.stringify({ ...cloudSession, issueId, profileId: account.profile.id }));
  $('live-drive-sync-state').textContent = 'Drive自動同期中';
}
function restoreCloudLink(profile) {
  if (!profile || !account?.hasDrive) return;
  try {
    const saved = JSON.parse(setting('cloudLink') || 'null');
    if (saved?.profileId === profile.id && saved.issueId === issueId && saved.id) setCloudSession(saved);
  } catch (_) {}
}
function scheduleCloudSync() {
  if (!cloudSession || !account?.signedIn || !account.hasDrive) return;
  clearTimeout(cloudTimer);
  $('live-drive-sync-state').textContent = 'Drive更新待ち';
  cloudTimer = setTimeout(() => {
    cloudQueue = cloudQueue.catch(() => {}).then(async () => {
      if (!cloudSession || !account?.signedIn || !account.hasDrive) return;
      const activeIssue = issueId, activeAccount = account, currentVersion = editVersion;
      const saved = await activeAccount.save(snapshot(), cloudSession);
      if (account !== activeAccount || issueId !== activeIssue || !cloudSession) return;
      setCloudSession(saved);
      $('live-drive-sync-state').textContent = 'Drive同期済み';
      if (editVersion > currentVersion) scheduleCloudSync();
    }).catch(error => {
      if (error.message.includes('別の端末')) clearCloudSession();
      $('live-drive-sync-state').textContent = 'Drive同期エラー';
      tell(error.message || 'Drive同期に失敗しました。ブラウザの下書きは残っています。');
    });
  }, 3000);
}
window.addEventListener('gemini-live-log', ({ detail }) => {
  logs.push(detail); logs = logs.slice(-300); scheduleDraft();
});
window.addEventListener('gemini-live-clear', () => { logs = []; scheduleDraft(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveDraft().catch(() => tell('自動保存に失敗しました。'));
});

function restore(session) {
  restoring = true;
  try {
    issueId = session.issueId || crypto.randomUUID();
    $('live-session-title').value = session.title;
    chat.restore(session.messages);
    chat.emotion = 'neutral';
    logs = session.logs;
    $('live-test-log-list').replaceChildren(...logs.map(log => {
      const li = document.createElement('li');
      li.className = `live-log-${log.kind}`;
      li.textContent = `${new Date(log.time).toLocaleTimeString('ja-JP')}  ${log.text}`;
      return li;
    }));
    flowCanvas.restoreState(session.graph);
  } finally { restoring = false; }
}
function requireStopped() {
  if (probe?.socket || probe?.mediaStream || probe?.starting) throw new Error('読込の前にLive接続を停止してください。');
}
async function replaceSession(input, sync = null) {
  requireStopped();
  const session = validateSession(input);
  if (ready) await store.save(`backup-${crypto.randomUUID()}`, snapshot());
  requireStopped();
  clearCloudSession();
  restore(session);
  await saveDraft();
  if (sync) setCloudSession(sync);
  if (ready) await refreshLocal();
  tell('会話と図を復元しました。Geminiの会話記憶は次の接続から新規です。');
}
async function refreshLocal() {
  const items = (await store.list()).filter(item => item.id !== 'draft').sort((a, b) => b.session.savedAt.localeCompare(a.session.savedAt));
  $('live-local-list').replaceChildren(new Option('保存した会話を選択', ''), ...items.map(item =>
    new Option(`${item.id.startsWith('backup-') ? '読込前の退避 / ' : ''}${item.session.title} · ${new Date(item.session.savedAt).toLocaleString('ja-JP')}`, item.id)));
}
function action(id, run) {
  $(id).addEventListener('click', async () => {
    const button = $(id); button.disabled = true;
    try { await run(); } catch (error) { tell(error.message || '処理に失敗しました。'); }
    finally { button.disabled = false; }
  });
}
action('live-save-local', async () => {
  if (!ready) throw new Error('ブラウザ保存が利用できません。JSON出力を利用してください。');
  await store.save(crypto.randomUUID(), snapshot()); await refreshLocal(); tell('会話・図をブラウザに保存しました。');
});
action('live-load-local', async () => {
  requireStopped();
  const id = $('live-local-list').value;
  if (!id) throw new Error('保存した会話を選択してください。');
  await replaceSession((await store.load(id))?.session);
});
action('live-export', () => {
  const session = snapshot();
  const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `DeContra-${session.title.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  tell('会話・図をJSON出力しました（APIキー・音声は含みません）。');
});
action('live-import', () => { requireStopped(); $('live-import-file').click(); });
$('live-import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  try {
    if (!file) return;
    if (file.size > 10000000) throw new Error('ファイルは10MB以下にしてください。');
    await replaceSession(JSON.parse(await file.text()));
  } catch (error) { tell(`読込できませんでした: ${error.message}`); }
  finally { event.target.value = ''; }
});
$('live-session-title').addEventListener('input', scheduleDraft);

function accountChanged(profile) {
  chat.setProfile(profile);
  $('live-account-avatar').replaceChildren(profileAvatar(profile));
  $('live-account-name').textContent = profile?.name || '未ログイン';
  $('live-google-logout').hidden = !profile;
  $('live-google-login').textContent = profile ? 'Googleに再接続' : 'Googleでログイン・同期';
  if (profile) restoreCloudLink(profile);
  else clearCloudSession();
}
function persistKey() {
  const key = $('live-api-key'), checkbox = $('live-remember-key');
  remember('rememberKey', String(checkbox.checked));
  const value = checkbox.checked && key.value.trim() ? key.value.trim() : null;
  const stored = remember('apiKey', value);
  $('live-key-memory-status').textContent = !stored ? '記憶できません' : value ? '記憶済み' : '未記憶';
}
function cloudSettings() {
  return validateDriveSettings({ app: 'decontradictor-live-settings', version: 1,
    apiKey: $('live-api-key').value, voice: $('live-voice-select').value,
    avatarColor: $('live-avatar-color').value, direction: $('live-direction-input').value });
}
async function loadCloudSettings() {
  if (!account?.hasDrive) return;
  const activeAccount = account, profileId = account.profile?.id, previousKey = $('live-api-key').value;
  const settings = await activeAccount.loadSettings();
  if (account !== activeAccount || account.profile?.id !== profileId) return;
  if (!settings) { tell('Driveに設定ファイルはまだありません。必要なら現在のAPIキー・設定を保存してください。'); return; }
  if ($('live-api-key').value !== previousKey) {
    tell('Drive設定を取得しましたが、読み込み中にAPIキーが変更されたため反映しませんでした。'); return;
  }
  $('live-api-key').value = settings.apiKey;
  if ([...$('live-voice-select').options].some(option => option.value === settings.voice)) {
    $('live-voice-select').value = settings.voice;
    $('live-voice-select').dispatchEvent(new Event('change'));
  }
  $('live-avatar-color').value = settings.avatarColor;
  $('live-avatar-color').dispatchEvent(new Event('change'));
  $('live-direction-input').value = settings.direction;
  persistKey();
  tell(settings.apiKey ? 'DriveからAPIキー・設定を読み込みました。Liveに接続できます。' : 'Driveから設定を読み込みました。APIキーは空です。');
}
action('live-google-login', async () => {
  requireAccount();
  await account.login({ drive: true });
  await loadCloudSettings();
});
action('live-google-logout', () => { account.signOut(); tell('Googleからログアウトしました。保存済みの会話とAPIキーは残ります。'); });
function requireAccount() {
  if (!account?.client) throw new Error('Googleログインを準備できませんでした。画面を再読み込みしてください。');
}
action('live-save-drive', async () => {
  requireAccount();
  await cloudQueue.catch(() => {});
  // ユーザー操作中に認証を開始し、ポップアップブロックを避ける。
  const saved = await account.save(snapshot(), cloudSession);
  setCloudSession(saved);
  tell(`Drive同期を開始しました: ${saved.name}。以後の変更は自動保存します。`);
});
action('live-list-drive', async () => {
  requireAccount(); const files = await account.list();
  $('live-drive-list').replaceChildren(new Option('Driveの会話を選択', ''), ...files.map(f => new Option(f.name, f.id)));
  tell(`Driveの保存済み会話 ${files.length}件を表示しました（最新100件まで）。`);
});
action('live-load-drive', async () => {
  requireAccount(); requireStopped(); const id = $('live-drive-list').value;
  if (!id) throw new Error('Drive一覧から会話を選択してください。');
  const remote = await account.load(id);
  await replaceSession(remote.session, remote.sync);
  tell('Driveから会話・図を読み込みました。以後の変更は同じファイルへ自動保存します。Geminiの会話記憶は新規です。');
});
action('live-save-settings-drive', async () => {
  requireAccount();
  await account.saveSettings(cloudSettings());
  tell('APIキー・設定をDriveのアプリ専用領域に保存しました（暗号化なし）。');
});
action('live-load-settings-drive', async () => { requireAccount(); await account.authorizeDrive(); await loadCloudSettings(); });
action('live-delete-settings-drive', async () => {
  requireAccount();
  if (!window.confirm('Drive上のAPIキー・設定ファイルを削除しますか？ブラウザ内の設定は残ります。')) return;
  const removed = await account.deleteSettings();
  tell(removed ? 'Drive上の設定ファイルを削除しました。ブラウザ内の設定は残ります。' : 'Drive上に設定ファイルはありません。');
});

async function boot() {
  probe = initGeminiLive({ llm,
    onEmotionDetected: emotion => {
      const safe = normalizeEmotion(emotion);
      $('live-current-emotion').dataset.emotion = safe;
      $('live-current-emotion').textContent = `感情: ${EMOTIONS[safe]}`;
    },
    onReactFlowUpdate: update => flowCanvas.applyUpdate(update),
  });
  const key = $('live-api-key'), checkbox = $('live-remember-key');
  checkbox.checked = setting('rememberKey', 'true') === 'true';
  key.value = checkbox.checked ? setting('apiKey') : '';
  key.addEventListener('input', persistKey); checkbox.addEventListener('change', persistKey);
  $('live-forget-key').addEventListener('click', () => {
    checkbox.checked = false; key.value = ''; persistKey();
    tell('ブラウザ内のAPIキーを削除しました。Drive上の設定は別の削除ボタンで管理します。');
  });
  persistKey();
  const color = $('live-avatar-color'); color.value = setting('avatarColor', 'auto');
  if (!color.value) color.value = 'auto';
  const syncColor = () => {
    chat.color = color.value === 'auto' ? ($('live-voice-select').selectedOptions[0]?.parentElement.label?.startsWith('女性') ? 'pink' : 'blue') : color.value;
    remember('avatarColor', color.value);
  };
  color.addEventListener('change', syncColor); $('live-voice-select').addEventListener('change', syncColor); syncColor();
  try {
    await store.init();
    const saved = await store.load('draft');
    if (saved) restore(validateSession(saved.session));
    ready = true; await refreshLocal();
    tell(saved ? '前回の会話・図を復元しました。接続は新しいセッションで開始します。' : '会話・図はこのブラウザに自動保存します。');
  } catch (_) { tell('前回の会話を読み込めませんでした。JSON出力での保存をご利用ください。'); }
  accountChanged(null);
  $('live-google-origin').textContent = location.origin;
  // クライアントIDは公開識別子なので、ビルド時設定や画面からの入力を不要にする。
  account = new LiveGoogleAccount(accountChanged, tell);
  try {
    await account.init(GOOGLE_OAUTH_CLIENT_ID);
    $('live-google-login').disabled = false;
    if (account.signedIn && account.hasDrive) await loadCloudSettings();
  }
  catch (error) { tell(error.message); }
}

boot().catch(() => tell('画面の初期化に失敗しました。再読み込みしてください。'));
