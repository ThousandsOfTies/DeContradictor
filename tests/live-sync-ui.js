import '../src/home-page.css';
import { LiveSessionStore, sessionContent, sessionFingerprint, validateSession } from '../src/live-session-store.js';
import { LiveIssueSync } from '../src/live-issue-sync.js';
import { issueCard } from '../src/home-issue-card.js';

const $ = id => document.getElementById(id);
const store = new LiveSessionStore('DeContradictorLiveSyncTests-' + crypto.randomUUID());
const fixture = (id, title) => validateSession({ app: 'decontradictor-live', version: 1, issueId: id, title,
  savedAt: '2026-10-11T00:00:00Z', messages: [], logs: [], graph: { nodes: [], edges: [] } });
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  const li = document.createElement('li'); li.textContent = 'PASS: ' + message; $('test-details').append(li);
};
const files = new Map();
const account = { profile: { id: 'isolated-account' }, generation: 0, signedIn: true, hasDrive: true,
  async list() { return [...files].map(([id, session]) => ({ id, appProperties: { issueId: session.issueId } })); },
  async load(id) { if (!files.has(id)) throw new Error('模擬Driveにファイルがありません'); return { session: structuredClone(files.get(id)), sync: { id, modifiedTime: 'test' } }; },
  async findSessionFile(issueId) { return (await this.list()).find(file => file.appProperties.issueId === issueId) || null; },
  async save(session, sync) { files.set(sync?.id || session.issueId, structuredClone(session)); return { id: sync?.id || session.issueId, modifiedTime: 'test' }; },
  async trashIssue(issueId, sync) {
    if (files.get(sync.id)?.issueId !== issueId) throw new Error('模擬Driveの課題IDが不一致');
    files.delete(sync.id); return { id: sync.id, trashed: true };
  },
};
let synchronizer, conflictId;
async function render() {
  const issues = await store.listIssues();
  $('test-issues').replaceChildren(...issues.map(issue => issueCard(issue, {
    href: '#test-issues', status: synchronizer.status(issue.issueId), onConflict: showConflict,
  })));
}
async function showConflict(id) {
  conflictId = id;
  const local = await store.loadIssue(id), remote = await store.loadConflict(id);
  $('test-conflict-name').textContent = local.title;
  $('test-local').textContent = 'ローカル版：' + local.title;
  $('test-remote').textContent = 'Drive版：' + remote.session.title;
  $('test-conflict-status').textContent = '';
  $('home-conflict-dialog').showModal();
}
async function resolve(choice) {
  for (const id of ['test-use-local', 'test-use-drive']) $(id).disabled = true;
  try {
    await synchronizer.resolve(conflictId, choice); await render(); $('home-conflict-dialog').close();
    $('test-sync-status').textContent = '採用した版は同期済みです。もう一方はローカルのみの退避コピーに残りました。';
  } catch (error) { $('test-conflict-status').textContent = error.message; }
  finally { for (const id of ['test-use-local', 'test-use-drive']) $(id).disabled = false; }
}

async function run() {
  await store.init();
  const original = await store.saveIssue(fixture('cas-test', '置換前'));
  const sync = { issueId: original.issueId, id: 'cas-file', profileId: account.profile.id, lastSyncedHash: await sessionFingerprint(original) };
  const changed = fixture(original.issueId, '置換後');
  check(await store.commitIssue(original.issueId, sessionContent(original), { session: changed, sync }), '内容と同期基準を同一トランザクションで保存');
  check((await store.loadIssue(original.issueId)).title === changed.title, '置換結果をIndexedDBから読込');
  check((await store.loadSync(original.issueId)).id === sync.id, '登録先は課題本文とは別に保持');
  check(!await store.commitIssue(original.issueId, sessionContent(original), { session: original }), '古い照合結果による置換を拒否');
  check((await store.loadIssue(original.issueId)).title === changed.title, '別の編集内容を上書きしない');
  let rejected = false;
  try { await store.commitIssue(original.issueId, sessionContent(changed), { session: { ...changed, graph: null }, sync: { ...sync, id: 'invalid' } }); }
  catch (_) { rejected = true; }
  check(rejected && (await store.loadSync(original.issueId)).id === sync.id, '不正なデータは全変更をロールバック');
  const backup = fixture('cas-backup', '退避');
  check(await store.commitIssue(original.issueId, sessionContent(changed), { remove: true, backup }), 'キャッシュ削除と退避を同一トランザクションで実行');
  check(!await store.loadIssue(original.issueId) && !await store.loadSync(original.issueId) && !!await store.loadIssue(backup.issueId), '削除後も退避コピーが残る');
  await store.remove('issue:cas-backup');

  const deletion = new LiveIssueSync(store, account); await deletion.init();
  const localDelete = await store.saveIssue(fixture('delete-local', 'ローカル削除テスト'));
  const deleted = await deletion.deleteIssue(localDelete.issueId, sessionContent(localDelete));
  check(deleted.removed && !deleted.driveTrashed && !await store.loadIssue(localDelete.issueId), 'ローカル課題を確認時の内容と一致する場合だけ削除');
  check(!!await store.load('meta:removed-issue:' + localDelete.issueId), '削除済みUUIDの移行防止マークを保持');
  const driveDelete = await store.saveIssue(fixture('delete-drive', 'Drive削除テスト'));
  const registration = { issueId: driveDelete.issueId, id: 'delete-file', profileId: account.profile.id, modifiedTime: 'test' };
  await store.saveSync(registration); files.set(registration.id, driveDelete);
  await store.save('conflict:' + driveDelete.issueId, { profileId: account.profile.id, session: driveDelete });
  check((await deletion.deleteIssue(driveDelete.issueId, sessionContent(driveDelete), registration)).driveTrashed && !files.has(registration.id), 'Drive対象ファイルを先にゴミ箱へ移動（模擬Drive）');
  check(!await store.loadIssue(driveDelete.issueId) && !await store.loadSync(driveDelete.issueId) && !await store.loadConflict(driveDelete.issueId), '課題・登録先・競合を実際のIndexedDBでまとめて削除');

  let autoSyncEnabled = true;
  const automatic = new LiveIssueSync(store, account, { autoSyncEnabled: () => autoSyncEnabled }); await automatic.init();
  const newTask = await store.saveIssue(fixture('auto-new', '自動登録テスト'));
  const autoResult = await automatic.refreshAll({ registerLocal: true, automatic: true });
  check(autoResult.registered === 1 && !!await store.loadSync(newTask.issueId) && files.has(newTask.issueId), '課題ごとの開始ボタンなしで自動Drive登録');
  check((await store.loadOwner(newTask.issueId)).profileId === account.profile.id, '未送信でもアカウントの所有情報を別管理');
  autoSyncEnabled = false;
  check(automatic.status(newTask.issueId).state === 'paused', '共通設定の停止を同期状態へ反映');
  let paused = false;
  try { await automatic.refreshAll({ registerLocal: true, automatic: true }); } catch (_) { paused = true; }
  check(paused && !!await store.loadIssue(newTask.issueId), '自動同期を止めてもローカル課題を保持');
  autoSyncEnabled = true;
  await automatic.deleteIssue(newTask.issueId, sessionContent(await store.loadIssue(newTask.issueId)), await store.loadSync(newTask.issueId));

  const specs = [
    ['equal', '開発の手戻りを減らす', 'equal'],
    ['local-edit', 'ローカルで矢印を編集した課題', 'local'],
    ['conflict', 'ローカル版の改善案', 'conflict'],
    ['local-only', 'まだDriveへ登録していない課題', 'none'],
  ];
  for (const [id, title, mode] of specs) {
    const base = fixture(id, mode === 'conflict' ? '元の改善案' : title);
    await store.saveIssue(base);
    if (mode === 'none') continue;
    await store.saveSync({ issueId: id, id, profileId: account.profile.id, modifiedTime: 'test', lastSyncedHash: await sessionFingerprint(base) });
    files.set(id, mode === 'conflict' ? fixture(id, 'Drive版の改善案') : base);
    if (mode === 'local') await store.saveIssue(fixture(id, title + '（編集済み）'));
    if (mode === 'conflict') await store.saveIssue(fixture(id, title));
  }
  files.set('drive-only', fixture('drive-only', '他端末で作成した課題'));
  synchronizer = new LiveIssueSync(store, account, { onChange: () => { render().catch(() => {}); } });
  await synchronizer.init();
  await render();
  const count = $('test-details').children.length;
  $('test-result').textContent = `${count} / ${count} PASS — 実際のIndexedDBで検証済み`;
  $('test-sync-status').textContent = '接続中の表示を確認したら「模擬Driveと照合」を押してください。';
  $('test-refresh').addEventListener('click', async () => {
    $('test-refresh').disabled = true;
    try { const result = await synchronizer.refreshAll({ registerLocal: true, automatic: true }); await render(); $('test-sync-status').textContent = '照合完了：取得 ' + result.downloaded + '件 / 送信 ' + result.uploaded + '件 / 登録 ' + result.registered + '件 / 競合 ' + result.conflicts + '件'; }
    catch (error) { $('test-sync-status').textContent = error.message; }
    finally { $('test-refresh').disabled = false; }
  });
  $('test-use-local').addEventListener('click', () => { resolve('local'); });
  $('test-use-drive').addEventListener('click', () => { resolve('drive'); });
  $('test-close').addEventListener('click', () => $('home-conflict-dialog').close());
}
run().catch(error => { $('test-result').textContent = 'FAIL: ' + error.message; console.error(error); });
