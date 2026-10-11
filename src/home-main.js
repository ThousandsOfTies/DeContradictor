import './home-page.css';
import { LiveSessionStore, sessionContent } from './live-session-store.js';
import { LiveGoogleAccount } from './live-google-account.js';
import { LiveIssueSync, issueDeleteBlockReason } from './live-issue-sync.js';
import { issueCard } from './home-issue-card.js';
import { profileAvatar } from './live-emotions.js';
import { GOOGLE_OAUTH_CLIENT_ID } from './live-config.js';
import { LiveAccountRestart } from './live-account-restart.js';
import { CommonSettings } from './common-settings.js';

const store = new LiveSessionStore();
const $ = id => document.getElementById(id);
const accountRestart = new LiveAccountRestart(() => {
  location.replace(new URL('./', location.href).href);
}, error => { $('home-drive-status').textContent = error.message; });
let account, synchronizer, renderTimer, refreshPromise, conflictIssueId = '', resolving = false;
let deleteTarget = null, deleting = false;
let pollTimer;
const preferences = new CommonSettings({ account: () => account, blocked: () => !!accountRestart.pending,
  onSyncChange: () => { synchronizer?.accountChanged(); updateAutoSync(); scheduleRender(); if (canAutoSync()) refreshDrive(); } });
const canAutoSync = () => account?.signedIn && account.hasDrive && preferences.autoSyncEnabled && navigator.onLine !== false && !accountRestart.pending;
function updateAutoSync() {
  clearInterval(pollTimer);
  const enabled = !!canAutoSync();
  $('home-drive-refresh').disabled = !enabled;
  if (account?.signedIn && !preferences.autoSyncEnabled) $('home-drive-status').textContent = '自動同期を停止しています。ローカル保存は継続します。TOPの「共通設定」で再開できます。';
  if (enabled) pollTimer = setInterval(() => { if (document.visibilityState === 'visible' && !deleting && !resolving) refreshDrive(); }, 30000);
}
const issueUrl = id => {
  const url = new URL('live.html', location.href);
  url.searchParams.set('issue', id);
  return url.href;
};
const dateLabel = value => new Date(value).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
const scheduleRender = () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderIssues().catch(error => { $('home-status').textContent = error.message; }), 30);
};


let renderGeneration = 0;
async function renderIssues() {
  const generation = ++renderGeneration;
  const issues = await store.listIssues();
  if (generation !== renderGeneration) return;
  const profileId = account?.profile?.id;
  const visible = issues.filter(issue => {
    const owner = synchronizer?.ownerOf(issue.issueId);
    return !profileId || !owner || owner === profileId;
  });
  $('home-count').textContent = visible.length + '件';
  $('home-issues').replaceChildren(...visible.map(issue => issueCard(issue, {
    status: synchronizer.status(issue.issueId), href: issueUrl(issue.issueId),
    onConflict: id => showConflict(id).catch(error => { $('home-status').textContent = error.message; }),
    onRetry: canAutoSync() ? () => { refreshDrive(); } : null,
    onDelete: id => showDelete(id).catch(error => { $('home-status').textContent = error.message; }),
    deleteBlocked: deleting ? '課題を削除しています。' : issueDeleteBlockReason(synchronizer.registrations.get(issue.issueId), account),
  })));
  if (!visible.length && !$('home-status').textContent) $('home-status').textContent = 'まだ課題がありません。上の欄から新しい課題を作成してください。';
}

function accountChanged(profile) {
  if (preferences.profileId !== (profile?.id || null)) preferences.settingsStore.clearTemporary();
  synchronizer?.accountChanged();
  if (accountRestart.observe(profile)) return;
  preferences.setProfile(profile);
  $('home-account-avatar').replaceChildren(profileAvatar(profile));
  $('home-account-name').textContent = profile?.name || '未ログイン';
  $('home-google-login').textContent = profile ? 'Googleアカウントを切替' : 'Googleでログイン';
  $('home-google-logout').hidden = !profile;
  $('home-drive-refresh').hidden = !profile;
  if ($('home-conflict-dialog').open) $('home-conflict-dialog').close();
  if ($('home-delete-dialog').open && !deleting) $('home-delete-dialog').close();
  if (!profile) $('home-drive-status').textContent = 'Googleにログインすると、Drive登録済みの課題を照合します。未接続時はキャッシュを削除しません。';
  updateAutoSync();
  scheduleRender();
}

function refreshDrive() {
  if (!canAutoSync()) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const button = $('home-drive-refresh'); button.disabled = true;
    $('home-drive-status').textContent = 'Driveの課題を取得して、ローカルと照合しています…';
    try {
      const result = await synchronizer.refreshAll({ registerLocal: true, automatic: true });
      await renderIssues();
      const notices = ['Driveとの照合が完了しました。'];
      if (result.registered) notices.push('未登録の課題 ' + result.registered + '件をDriveへ登録しました。');
      if (result.conflicts) notices.push('競合 ' + result.conflicts + '件は版を確認してください。');
      if (result.errors) notices.push('同期エラー ' + result.errors + '件。キャッシュの削除は保留しました。');
      if (result.pending) notices.push('照合中に編集された課題 ' + result.pending + '件は次回の照合で同期します。');
      if (result.removed) notices.push('Drive一覧にない登録済みキャッシュ ' + result.removed + '件を削除しました。');
      if (result.backups) notices.push('未送信の内容 ' + result.backups + '件は退避コピーに残しました。');
      $('home-drive-status').textContent = notices.join(' ');
      if (result.removed || result.backups) $('home-status').textContent = notices.slice(1).join(' ');
    } catch (error) {
      if (!error.cancelled) $('home-drive-status').textContent = error.message || 'Driveに接続できませんでした。ローカルの課題は残っています。';
    } finally { refreshPromise = null; updateAutoSync(); }
  })();
  return refreshPromise;
}

async function showConflict(issueId) {
  const [local, conflict] = await Promise.all([store.loadIssue(issueId), store.loadConflict(issueId)]);
  if (!local || !conflict || conflict.profileId !== account?.profile?.id) throw new Error('Googleに接続して課題一覧を更新してください。');
  conflictIssueId = issueId;
  $('home-conflict-description').textContent = local.title;
  const describe = (name, session) => name + '：' + session.title + '\n更新 ' + dateLabel(session.updatedAt) + '\n会話 ' + session.messages.length + '件 / ノード ' + session.graph.nodes.length + '個';
  $('home-conflict-local').textContent = describe('ローカル版', local);
  $('home-conflict-drive').textContent = describe('Drive版', conflict.session);
  $('home-conflict-status').textContent = '';
  $('home-conflict-dialog').showModal();
}

async function chooseVersion(choice) {
  if (resolving) return;
  resolving = true;
  for (const id of ['home-use-local', 'home-use-drive', 'home-conflict-close']) $(id).disabled = true;
  $('home-conflict-status').textContent = '最新のDrive版を確認して、選択した版を反映しています…';
  try {
    await synchronizer.resolve(conflictIssueId, choice);
    $('home-conflict-dialog').close();
    $('home-drive-status').textContent = '選択した版を採用しました。もう一方はローカルの退避コピーに残しています。';
    await renderIssues();
  } catch (error) { $('home-conflict-status').textContent = error.message; }
  finally {
    resolving = false;
    for (const id of ['home-use-local', 'home-use-drive', 'home-conflict-close']) $(id).disabled = false;
  }
}

async function showDelete(issueId) {
  if (deleting) return;
  const [issue, registration] = await Promise.all([store.loadIssue(issueId), store.loadSync(issueId)]);
  if (!issue) { await renderIssues(); throw new Error('この課題はすでに削除されています。'); }
  const blocked = issueDeleteBlockReason(registration, account);
  if (blocked) throw new Error(blocked);
  deleteTarget = { issueId, title: issue.title, content: sessionContent(issue), registration };
  $('home-delete-name').textContent = issue.title;
  $('home-delete-description').textContent = registration
    ? 'この課題のDriveファイルをゴミ箱へ移し、このブラウザの会話・図・同期情報も削除します。'
    : 'このブラウザに保存した、この課題の会話・図・通信ログを削除します。';
  $('home-delete-warning').textContent = registration
    ? 'Driveへ送信済みの内容はDriveのゴミ箱から復元できます。未送信の編集は元に戻せません。APIキーなどの設定や他の課題は消しません。'
    : '元に戻せません。必要な内容は先に課題を開いてJSON出力してください。APIキーなどの設定や他の課題は消しません。';
  $('home-delete-status').textContent = '';
  $('home-delete-dialog').showModal();
}

async function confirmDelete() {
  if (deleting || !deleteTarget) return;
  deleting = true;
  const target = deleteTarget;
  for (const id of ['home-delete-confirm', 'home-delete-cancel']) $(id).disabled = true;
  $('home-delete-status').textContent = target.registration ? 'Driveのゴミ箱へ移してから、ローカルの課題を削除しています…' : '課題を削除しています…';
  try {
    const result = await synchronizer.deleteIssue(target.issueId, target.content, target.registration);
    $('home-delete-dialog').close();
    deleteTarget = null;
    $('home-status').textContent = `「${target.title}」を削除しました。` + (result.driveTrashed ? 'Drive側はゴミ箱へ移しました。' : '');
  } catch (error) { $('home-delete-status').textContent = error.message; }
  finally {
    deleting = false;
    for (const id of ['home-delete-confirm', 'home-delete-cancel']) $(id).disabled = false;
    await renderIssues();
  }
}

async function boot() {
  await store.init();
  await store.migrateLegacy();
  account = new LiveGoogleAccount(accountChanged, message => { $('home-drive-status').textContent = message; });
  synchronizer = new LiveIssueSync(store, account, { onChange: scheduleRender, onIssueChanged: scheduleRender, autoSyncEnabled: () => preferences.autoSyncEnabled });
  let storage;
  try { storage = localStorage; } catch (_) {}
  await synchronizer.init(storage);
  let notice = '';
  try {
    notice = sessionStorage.getItem('decontradictor.live.handoffNotice') || '';
    if (notice) sessionStorage.removeItem('decontradictor.live.handoffNotice');
  } catch (_) {}
  $('home-status').textContent = notice;
  await renderIssues();
  $('home-open-settings').addEventListener('click', () => preferences.show());
  if (location.hash === '#settings') preferences.show();
  $('home-create-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const title = $('home-title').value.trim();
      if (!title) throw new Error('課題名を入力してください。');
      const issueId = crypto.randomUUID();
      await store.saveIssue({ app: 'decontradictor-live', version: 1, issueId, title,
        savedAt: new Date().toISOString(), messages: [], logs: [], graph: { nodes: [], edges: [] } });
      if (account.signedIn) await store.claimIssue(issueId, account.profile.id);
      location.assign(issueUrl(issueId));
    } catch (error) { $('home-status').textContent = error.message; button.disabled = false; }
  });
  $('home-google-login').addEventListener('click', async () => {
    const button = $('home-google-login'); button.disabled = true;
    try {
      await account.login({ drive: true, selectAccount: true });
      if (accountRestart.pending) await accountRestart.pending;
      else await refreshDrive();
    }
    catch (error) { $('home-drive-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('home-google-logout').addEventListener('click', () => account.signOut());
  $('home-drive-refresh').addEventListener('click', () => { refreshDrive(); });
  $('home-use-local').addEventListener('click', () => { chooseVersion('local'); });
  $('home-use-drive').addEventListener('click', () => { chooseVersion('drive'); });
  $('home-conflict-close').addEventListener('click', () => $('home-conflict-dialog').close());
  $('home-conflict-dialog').addEventListener('cancel', event => { if (resolving) event.preventDefault(); });
  $('home-delete-confirm').addEventListener('click', () => { confirmDelete().catch(error => { $('home-status').textContent = error.message; }); });
  $('home-delete-cancel').addEventListener('click', () => $('home-delete-dialog').close());
  $('home-delete-dialog').addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  $('home-delete-dialog').addEventListener('close', () => { deleteTarget = null; });
  window.addEventListener('offline', () => {
    synchronizer.accountChanged();
    updateAutoSync(); scheduleRender();
    $('home-drive-status').textContent = 'ネットワークの接続待ちです。ローカルの課題は残っています。';
  });
  window.addEventListener('online', () => { updateAutoSync(); if (canAutoSync()) refreshDrive(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && canAutoSync()) refreshDrive();
  });
  try {
    await account.init(GOOGLE_OAUTH_CLIENT_ID);
    accountRestart.enable();
    $('home-google-login').disabled = false;
    if (account.signedIn && account.hasDrive) {
      await preferences.loadCloudSettings({ onlyIfMissing: true }).catch(error => preferences.tell(error.message));
      await refreshDrive();
    }
    else { synchronizer.accountChanged(); scheduleRender(); }
  } catch (error) {
    synchronizer.accountChanged(); scheduleRender();
    $('home-drive-status').textContent = error.message || 'Googleログインを準備できませんでした。';
  } finally { accountRestart.enable(); updateAutoSync(); }
}

boot().catch(error => { $('home-status').textContent = '課題一覧を読み込めませんでした: ' + error.message; });
