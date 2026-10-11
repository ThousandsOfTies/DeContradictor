import './live-page.css';
import { initGeminiLive } from './gemini-live.js';
import { LiveFlowCanvas } from './live-flow.js';
import { applyValidatedFlowUpdate } from './live-flow-update.js';
import { LiveChat } from './live-chat.js';
import { EMOTIONS, profileAvatar, normalizeEmotion } from './live-emotions.js';
import { LiveSessionStore, validateSession, sessionContent } from './live-session-store.js';
import { LiveGoogleAccount } from './live-google-account.js';
import { LiveIssueSync, SYNC_LABELS } from './live-issue-sync.js';
import { GOOGLE_OAUTH_CLIENT_ID } from './live-config.js';
import { LiveAccountRestart } from './live-account-restart.js';
import { CommonSettings, robotColorForVoice } from './common-settings.js';

const $ = id => document.getElementById(id);
const tell = message => { $('live-save-status').textContent = message; };
const accountRestart = new LiveAccountRestart(restartAtHome, error => tell(`再読み込みできませんでした: ${error.message}。課題は画面に残っています。JSON出力で退避してから再読み込みしてください。`));
let restarting = false, driveReady = false;
const llm = { apiKey: '' };
const store = new LiveSessionStore();
let ready = false, restoring = false, timer, logs = [], probe, account, saveQueue = Promise.resolve();
let issueId = new URLSearchParams(location.search).get('issue') || '', synchronizer, cloudTimer, cloudQueue = Promise.resolve();
let editVersion = 0, savedEditVersion = 0, issueUpdatedAt = '', editorBaseContent = '', reconciling = false, reconciliationPromise;
const flowCanvas = new LiveFlowCanvas($('live-flow-svg'), {
  emptyElement: $('live-flow-empty'), onChange: scheduleDraft,
});
const chat = new LiveChat($('live-chat-list'), scheduleDraft);
const preferences = new CommonSettings({ account: () => account, blocked: () => !!accountRestart.pending,
  onChange: settings => {
    llm.apiKey = settings.apiKey;
    chat.color = robotColorForVoice(settings.voice);
  },
  onSyncChange: () => {
    clearTimeout(cloudTimer); synchronizer?.accountChanged(); renderSyncStatus();
    if (canAutoSync()) {
      reconcileDrive({ allowLive: true }).catch(error => { if (!error.cancelled) tell(error.message); });
    }
  },
});
const canAutoSync = () => account?.signedIn && account.hasDrive && preferences.autoSyncEnabled && navigator.onLine !== false && !restarting && !accountRestart.pending;

const settingsButton = $('live-open-settings-btn');
const settingsDialog = $('live-settings-dialog');
settingsButton.addEventListener('click', () => settingsDialog.showModal());
$('live-close-settings-btn').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', event => {
  if (event.target === settingsDialog) settingsDialog.close();
});
$('live-back-to-issues').addEventListener('click', async event => {
  event.preventDefault();
  const link = event.currentTarget;
  try {
    await probe?.stop({ silent: true });
    await saveDraft();
    try { await flushCloudSync(); }
    catch (error) {
      try { sessionStorage.setItem('decontradictor.live.handoffNotice', `ブラウザには保存しましたが、Drive同期に失敗しました: ${error.message}`); } catch (_) {}
    }
    location.assign(link.href);
  } catch (error) { tell(`課題の保存に失敗しました: ${error.message}`); settingsDialog.showModal(); }
});

function snapshot() {
  const key = $('live-api-key').value.trim();
  const safeLogs = logs.map(l => ({ ...l, text: key ? l.text.split(key).join('[APIキー非表示]') : l.text }));
  return validateSession({ app: 'decontradictor-live', version: 1,
    issueId, title: $('live-session-title').value.trim() || '無題の課題', savedAt: new Date().toISOString(), updatedAt: issueUpdatedAt,
    messages: chat.messages, logs: safeLogs, graph: flowCanvas.getState() });
}
function scheduleDraft() {
  if (!ready || restoring) return;
  editVersion++;
  synchronizer?.markDirty(issueId);
  renderSyncStatus();
  clearTimeout(timer);
  timer = setTimeout(() => saveDraft().catch(() => tell('自動保存に失敗しました。JSON出力で退避してください。')), 600);
}
async function saveDraft() {
  clearTimeout(timer);
  timer = null;
  if (ready && !restoring) {
    const session = snapshot();
    const version = editVersion;
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      let saved = await store.saveEditedIssue({ ...session, issueId }, editorBaseContent);
      if (!saved) {
        // 他の画面が同じ課題を更新・削除した場合、編集内容を新しいUUIDへ退避する。
        saved = await store.saveIssue({ ...session, issueId: crypto.randomUUID(), title: `${session.title.slice(0, 75)}（別画面との競合退避）`,
          savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const owner = synchronizer?.ownerOf(issueId) || account?.profile?.id;
        if (owner) await store.claimIssue(saved.issueId, owner);
        issueId = saved.issueId;
        $('live-session-title').value = saved.title; $('live-issue-name').textContent = saved.title;
        document.title = `${saved.title} | DeContradictor`;
        const url = new URL(location.href); url.searchParams.set('issue', issueId); history.replaceState(null, '', url);
        tell('別の画面で元の課題が更新されたため、こちらの編集を別課題として退避しました。課題一覧で確認できます。');
      }
      editorBaseContent = sessionContent(saved);
      issueUpdatedAt = saved.updatedAt;
      savedEditVersion = version;
    });
    await saveQueue;
    renderSyncStatus();
    scheduleCloudSync();
  }
}
function liveRunning() { return !!(probe?.socket || probe?.mediaStream || probe?.starting); }
function renderSyncStatus() {
  let { state, detail } = synchronizer?.status(issueId) || { state: 'local', detail: '' };
  if (state === 'synced' && editVersion !== savedEditVersion) state = 'syncing';
  for (const id of ['live-drive-sync-state', 'live-issue-sync']) {
    $(id).textContent = SYNC_LABELS[state];
    $(id).dataset.state = state;
    $(id).title = detail;
  }
  $('live-sync-retry').hidden = !['error', 'offline'].includes(state);
  $('live-sync-conflict').hidden = state !== 'conflict';
  $('live-save-drive').textContent = '今すぐ同期';
  $('live-save-drive').disabled = !canAutoSync();
}
function scheduleCloudSync() {
  clearTimeout(cloudTimer);
  if (!canAutoSync() || !driveReady) return;
  const owner = synchronizer?.ownerOf(issueId);
  if ((owner && owner !== account.profile.id)
    || ['connecting', 'conflict', 'error', 'foreign', 'offline'].includes(synchronizer.status(issueId).state)) return;
  cloudTimer = setTimeout(() => {
    cloudQueue = cloudQueue.catch(() => {}).then(async () => {
      await synchronizer.register(issueId, { automatic: true });
      renderSyncStatus();
      if (synchronizer.status(issueId).state === 'syncing') scheduleCloudSync();
    }).catch(error => { if (!error.cancelled) tell(error.message); renderSyncStatus(); });
  }, 3000);
}
async function flushCloudSync() {
  clearTimeout(cloudTimer);
  await cloudQueue.catch(() => {});
  if (!canAutoSync() || !driveReady) return;
  await synchronizer.register(issueId, { automatic: true });
  if (synchronizer.status(issueId).state === 'conflict') throw new Error('内容が競合しています。課題一覧で採用する版を確認してください。');
}
function reconcileDrive({ allowLive = false } = {}) {
  if (!canAutoSync()) return Promise.resolve();
  if (reconciliationPromise) return reconciliationPromise;
  if (liveRunning() && !allowLive) return Promise.reject(new Error('Driveの照合はLive接続を停止してから行ってください。'));
  reconciling = true;
  driveReady = false;
  // 自動同期の再開時はLiveを止めない。canApplyRemoteで会話中の置換・削除は保留する。
  $('live-page').inert = !liveRunning();
  clearTimeout(cloudTimer);
  reconciliationPromise = (async () => {
    try {
      await saveDraft();
      clearTimeout(cloudTimer);
      const result = await synchronizer.refreshAll({ registerLocal: true, automatic: true });
      driveReady = !result.errors;
      renderSyncStatus();
      scheduleCloudSync();
      if (result.conflicts) tell('内容が競合しています。課題一覧で採用する版を確認できます。');
      else if (result.errors) tell('Drive同期に失敗した課題があります。ローカルの内容は残しています。');
      else if (result.removed || result.backups) tell('Drive一覧にないキャッシュを整理しました。未送信の内容は退避コピーに残しています。');
      else tell('Driveとの照合が完了しました。');
      return result;
    } finally {
      reconciling = false;
      $('live-page').inert = !!(restarting || accountRestart.pending);
      reconciliationPromise = null;
      renderSyncStatus();
    }
  })();
  return reconciliationPromise;
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
    issueId = session.issueId;
    issueUpdatedAt = session.updatedAt;
    editorBaseContent = sessionContent(session);
    $('live-session-title').value = session.title;
    $('live-issue-name').textContent = session.title;
    document.title = `${session.title} | DeContradictor`;
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
async function openImportedIssue(input) {
  requireStopped();
  if (!ready) throw new Error('ブラウザ保存が利用できません。');
  const session = validateSession(input);
  await saveDraft();
  const nextId = (await store.saveIssue({ ...session, issueId: crypto.randomUUID(), savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString() })).issueId;
  if (account?.signedIn) await store.claimIssue(nextId, account.profile.id);
  const url = new URL('live.html', location.href);
  url.searchParams.set('issue', nextId);
  location.assign(url.href);
}
function action(id, run) {
  $(id).addEventListener('click', async () => {
    const button = $(id); button.disabled = true;
    try { await run(); } catch (error) { tell(error.message || '処理に失敗しました。'); }
    finally { button.disabled = false; renderSyncStatus(); }
  });
}
action('live-save-local', async () => {
  if (!ready) throw new Error('ブラウザ保存が利用できません。JSON出力を利用してください。');
  await saveDraft(); tell('この課題をブラウザに保存しました。');
});
action('live-export', async () => {
  if (ready) await saveDraft();
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
    await openImportedIssue(JSON.parse(await file.text()));
  } catch (error) { tell(`読込できませんでした: ${error.message}`); }
  finally { event.target.value = ''; }
});
$('live-session-title').addEventListener('input', () => {
  $('live-issue-name').textContent = $('live-session-title').value.trim() || '無題の課題';
  scheduleDraft();
});

function accountChanged(profile) {
  clearTimeout(cloudTimer);
  driveReady = false;
  if (preferences.profileId !== (profile?.id || null)) preferences.settingsStore.clearTemporary();
  synchronizer?.accountChanged();
  if (accountRestart.observe(profile)) return;
  preferences.setProfile(profile);
  chat.setProfile(profile);
  $('live-account-avatar').replaceChildren(profileAvatar(profile));
  $('live-account-name').textContent = profile?.name || '未ログイン';
  renderSyncStatus();
}
async function restartAtHome() {
  restarting = true;
  clearTimeout(cloudTimer);
  $('live-page').inert = true;
  settingsDialog.inert = true;
  preferences.dialog.inert = true;
  tell('課題をブラウザに保存して、課題一覧を再読み込みしています…');
  try {
    await probe?.stop({ silent: true });
    await saveDraft();
    ready = false;
    location.replace(new URL('./', location.href).href);
  } catch (error) {
    $('live-page').inert = false;
    settingsDialog.inert = false;
    preferences.dialog.inert = false;
    settingsDialog.showModal();
    throw error;
  }
}
function requireAccount() {
  if (!account?.signedIn || !account.hasDrive) throw new Error('TOPからGoogleにログインしてDriveへのアクセスを許可してください。');
  if (!preferences.autoSyncEnabled) throw new Error('TOPの「共通設定」でGoogle Driveの自動同期を再開してください。');
}
action('live-save-drive', async () => {
  requireAccount();
  await cloudQueue.catch(() => {});
  await saveDraft();
  clearTimeout(cloudTimer);
  if (!liveRunning()) await reconcileDrive();
  else if (driveReady) await synchronizer.register(issueId, { automatic: true });
  else throw new Error('Liveを停止してから同期を再試行してください。');
  renderSyncStatus();
  if (synchronizer.status(issueId).state === 'conflict') tell('ローカルとDriveの内容が異なります。課題一覧で採用する版を確認してください。');
  else { tell('Driveへ同期しました。以後の変更も自動保存します。'); scheduleCloudSync(); }
});
action('live-sync-retry', async () => {
  requireAccount(); requireStopped();
  await reconcileDrive();
});
$('live-sync-conflict').addEventListener('click', event => {
  event.preventDefault(); $('live-back-to-issues').click();
});
$('live-account-top').addEventListener('click', event => { event.preventDefault(); $('live-back-to-issues').click(); });

async function boot() {
  $('live-page').inert = true;
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(issueId)) {
    location.replace(new URL('./', location.href).href);
    return;
  }
  try {
    await store.init();
    await store.migrateLegacy();
    const saved = await store.loadIssue(issueId);
    if (!saved) {
      location.replace(new URL('./', location.href).href);
      return;
    }
    restore(saved);
    ready = true;
    tell('課題を読み込みました。接続すると、初回は趣旨説明、再開は図・直近の会話の振り返りから始まります。');
  } catch (error) {
    tell(`課題を読み込めませんでした: ${error.message}`);
    $('live-page').inert = false;
    return;
  }
  probe = initGeminiLive({ llm,
    onEmotionDetected: emotion => {
      const safe = normalizeEmotion(emotion);
      $('live-current-emotion').dataset.emotion = safe;
      $('live-current-emotion').textContent = `感情: ${EMOTIONS[safe]}`;
    },
    getIssueContext: () => ({
      title: $('live-session-title').value,
      messages: chat.messages,
      graph: flowCanvas.getState(),
    }),
    onReactFlowUpdate: update => applyValidatedFlowUpdate(flowCanvas, update),
  });
  preferences.apply(preferences.settingsStore.load(null));
  accountChanged(null);
  // クライアントIDは公開識別子なので、ビルド時設定や画面からの入力を不要にする。
  account = new LiveGoogleAccount(accountChanged, tell);
  synchronizer = new LiveIssueSync(store, account, {
    onChange: renderSyncStatus,
    autoSyncEnabled: () => preferences.autoSyncEnabled,
    canApplyRemote: id => id !== issueId || (reconciling && !liveRunning()),
    onIssueChanged: event => {
      if (event.issueId !== issueId) return;
      if (event.session) restore(event.session);
      if (event.removed) {
        ready = false;
        try { sessionStorage.setItem('decontradictor.live.handoffNotice', event.backupId
          ? 'Drive一覧にない登録済みキャッシュを整理し、未送信の内容を退避コピーに残しました。'
          : 'Drive一覧にない登録済みキャッシュを削除しました。'); } catch (_) {}
        location.replace(new URL('./', location.href).href);
      }
    },
  });
  let storage;
  try { storage = localStorage; } catch (_) {}
  await synchronizer.init(storage);
  renderSyncStatus();
  window.addEventListener('offline', () => { clearTimeout(cloudTimer); synchronizer.accountChanged(); renderSyncStatus(); });
  window.addEventListener('online', () => {
    if (!canAutoSync()) return;
    const reconnect = liveRunning() && driveReady
      ? saveDraft().then(() => synchronizer.register(issueId, { automatic: true })).then(() => { renderSyncStatus(); scheduleCloudSync(); })
      : reconcileDrive({ allowLive: true });
    reconnect.catch(error => { tell(error.message); });
  });
  try {
    await account.init(GOOGLE_OAUTH_CLIENT_ID);
    accountRestart.enable();
    if (account.signedIn && account.hasDrive) {
      await preferences.loadCloudSettings({ onlyIfMissing: true }).catch(error => preferences.tell(error.message));
      await reconcileDrive();
    }
    else { synchronizer.accountChanged(); renderSyncStatus(); }
  }
  catch (error) { if (!account.signedIn) synchronizer.accountChanged(); renderSyncStatus(); tell(error.message); }
  finally { accountRestart.enable(); if (!accountRestart.pending) $('live-page').inert = false; }
  setInterval(() => {
    if (document.visibilityState === 'visible' && !liveRunning() && canAutoSync()) reconcileDrive().catch(error => { if (!error.cancelled) tell(error.message); });
  }, 30000);
}

boot().catch(() => tell('画面の初期化に失敗しました。再読み込みしてください。'));
