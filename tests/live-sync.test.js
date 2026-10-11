import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveSessionStore, validateSession, sessionContent, sessionFingerprint } from '../src/live-session-store.js';
import { LiveIssueSync, issueDeleteBlockReason } from '../src/live-issue-sync.js';
import { LiveGoogleAccount } from '../src/live-google-account.js';

const fixture = (issueId = 'issue-a', title = '課題A') => validateSession({
  app: 'decontradictor-live', version: 1, issueId, title, savedAt: '2026-10-11T00:00:00Z',
  messages: [{ role: 'user', text: 'テスト', time: '2026-10-11T00:00:00Z' }], logs: [],
  graph: { nodes: [{ id: 'a', type: 'default', position: { x: 0, y: 0 }, data: { label: '開始' } },
    { id: 'b', type: 'default', position: { x: 300, y: 0 }, data: { label: '終了' } }],
    edges: [{ id: 'ab', source: 'a', target: 'b' }] },
});

function memoryStore() {
  const store = new LiveSessionStore('sync-tests');
  const records = new Map();
  store.save = async (id, session) => { records.set(id, { id, session: structuredClone(session) }); };
  store.load = async id => structuredClone(records.get(id));
  store.list = async () => structuredClone([...records.values()]);
  store.remove = async id => { records.delete(id); };
  store.commitIssue = async (issueId, expected, { session, sync, conflict, backup, backupProfileId, owner, remove = false } = {}) => {
    const current = await store.loadIssue(issueId);
    if ((current ? sessionContent(current) : null) !== expected) return false;
    if (backup) await store.save(`issue:${backup.issueId}`, validateSession(backup));
    if (backup && backupProfileId) await store.save(`owner:${backup.issueId}`, { issueId: backup.issueId, profileId: backupProfileId });
    if (remove) {
      for (const prefix of ['issue:', 'sync:', 'conflict:', 'owner:']) await store.remove(prefix + issueId);
      await store.save(`meta:removed-issue:${issueId}`, { issueId });
    } else {
      if (session) await store.save(`issue:${issueId}`, validateSession(session));
      if (sync) await store.saveSync(sync);
      if (owner) await store.save(`owner:${issueId}`, { issueId, profileId: owner });
      if (conflict) await store.save(`conflict:${issueId}`, conflict);
      else if (conflict === null) await store.remove(`conflict:${issueId}`);
    }
    return true;
  };
  return store;
}

function mockDrive(sessions = []) {
  const files = new Map(sessions.map((session, index) => ['file-' + index, { session: structuredClone(session), modifiedTime: 'v0' }]));
  const account = { profile: { id: 'account-a' }, generation: 0, hasDrive: true, writes: [], trashes: [],
    get signedIn() { return !!this.profile; },
    async list() { return [...files].map(([id, file]) => ({ id, name: file.session.title,
      appProperties: file.session.issueId ? { issueId: file.session.issueId } : {} })); },
    async load(id) {
      if (!files.has(id)) throw new Error('not found');
      const file = files.get(id);
      return structuredClone({ session: file.session, sync: { id, modifiedTime: file.modifiedTime } });
    },
    async findSessionFile(issueId) { return (await this.list()).find(file => file.appProperties.issueId === issueId) || null; },
    async save(session, sync) {
      const id = sync?.id || (this.writes.length ? 'new-file-' + this.writes.length : 'new-file');
      if (sync?.id && files.get(id).modifiedTime !== sync.modifiedTime) throw new Error('別の端末で更新');
      this.writes.push({ id, session: structuredClone(session) });
      const modifiedTime = 'v' + this.writes.length;
      files.set(id, { session: structuredClone(session), modifiedTime });
      return { id, modifiedTime };
    },
    async trashIssue(issueId, sync) {
      const file = files.get(sync.id);
      if (!file || file.session.issueId !== issueId) throw new Error('削除対象が不正');
      if (file.modifiedTime !== sync.modifiedTime) throw new Error('Drive上の課題が更新されています');
      this.trashes.push(sync.id);
      files.delete(sync.id);
      return { id: sync.id, trashed: true };
    },
  };
  return { account, files };
}

async function setup(local = fixture(), remote = fixture(), { baseline = true, options = {} } = {}) {
  const store = memoryStore();
  if (local) await store.saveIssue(local);
  const { account, files } = mockDrive(remote ? [remote] : []);
  if (local) await store.saveSync({ issueId: local.issueId, profileId: account.profile.id, id: 'file-0',
    modifiedTime: 'v0', lastSyncedHash: baseline ? await sessionFingerprint(fixture(local.issueId)) : '' });
  const sync = new LiveIssueSync(store, account, options);
  await sync.init();
  return { store, account, files, sync };
}

test('automatic refresh registers pre-existing local tasks without a per-task opt-in', async () => {
  const { store, account, sync } = await setup(null, null);
  await store.saveIssue(fixture());
  const result = await sync.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(result.registered, 1);
  assert.equal(account.writes.length, 1);
  assert.equal(sync.status('issue-a').state, 'synced');
  assert.equal((await store.loadOwner('issue-a')).profileId, 'account-a');
  assert.ok(await store.loadSync('issue-a'));
  await sync.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(account.writes.length, 1, 'unchanged content never creates a duplicate upload');
});

test('failed automatic registration reports an error and preserves its account owner across restart', async () => {
  const { store, account, sync } = await setup(null, null);
  await store.saveIssue(fixture());
  account.save = async () => { throw new Error('送信失敗'); };
  const result = await sync.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(result.errors, 1);
  assert.equal(sync.status('issue-a').state, 'error');
  assert.equal((await store.loadOwner('issue-a')).profileId, 'account-a');
  assert.equal(await store.loadSync('issue-a'), null);
  account.profile = { id: 'account-b' }; account.generation++;
  const restarted = new LiveIssueSync(store, account); await restarted.init(); restarted.accountChanged();
  assert.equal(restarted.ownerOf('issue-a'), 'account-a');
  assert.equal(restarted.status('issue-a').state, 'foreign');
  await restarted.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(account.writes.length, 0);
  assert.ok(await store.loadIssue('issue-a'));
});

test('automatic registration waits for a complete Drive listing and every body to validate', async () => {
  const { store, account, sync } = await setup(null);
  await store.saveIssue(fixture('new-local', '未送信'));
  account.load = async () => { throw new Error('本文取得失敗'); };
  await assert.rejects(sync.refreshAll({ registerLocal: true, automatic: true }), /本文取得失敗/);
  assert.equal(account.writes.length, 0);
  assert.equal(await store.loadSync('new-local'), null);
  assert.ok(await store.loadIssue('new-local'));
});

test('a failed initial Drive lookup reports an error for an owned task that is not uploaded yet', async () => {
  const { store, account, sync } = await setup(null, null);
  await store.saveIssue(fixture());
  await store.claimIssue('issue-a', 'account-a');
  await sync.reloadRegistrations();
  const list = account.list;
  account.list = async () => { throw new Error('Driveの取得失敗'); };
  await assert.rejects(sync.refreshAll({ registerLocal: true, automatic: true }), /Driveの取得失敗/);
  assert.equal(sync.status('issue-a').state, 'error');
  assert.equal(sync.ownerOf('issue-a'), 'account-a');
  assert.ok(await store.loadIssue('issue-a'));
  assert.equal(account.writes.length, 0);
  account.list = list;
  await sync.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(sync.status('issue-a').state, 'synced');
});

test('pausing automatic synchronization skips Drive reads/writes/deletions and resumes normally', async () => {
  let enabled = false;
  const { store, account, sync } = await setup(fixture(), fixture(), { options: { autoSyncEnabled: () => enabled } });
  let reads = 0;
  const list = account.list.bind(account); account.list = async () => { reads++; return list(); };
  assert.equal(sync.status('issue-a').state, 'paused');
  await assert.rejects(async () => sync.refreshAll({ registerLocal: true, automatic: true }), /停止/);
  await assert.rejects(async () => sync.register('issue-a', { automatic: true }), /停止/);
  await assert.rejects(async () => sync.syncIssue('issue-a', { automatic: true }), /停止/);
  assert.equal(reads, 0); assert.equal(account.writes.length, 0);
  assert.ok(await store.loadIssue('issue-a'));
  enabled = true; sync.accountChanged();
  await sync.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(sync.status('issue-a').state, 'synced');
});

test('pausing while the Drive listing is pending cancels automatic reconciliation before uploads', async () => {
  let enabled = true;
  const { store, account, sync } = await setup(null, null, { options: { autoSyncEnabled: () => enabled } });
  await store.saveIssue(fixture());
  account.list = async () => { enabled = false; return []; };
  await assert.rejects(sync.refreshAll({ registerLocal: true, automatic: true }), /接続が変わりました/);
  assert.equal(account.writes.length, 0);
  assert.ok(await store.loadIssue('issue-a'));
});

test('local-only tasks owned by another account are never uploaded or overwritten', async () => {
  const { store, account, sync } = await setup(null, null);
  await store.saveIssue(fixture());
  await store.claimIssue('issue-a', 'account-b');
  await sync.refreshAll({ registerLocal: true, automatic: true });
  assert.equal(account.writes.length, 0);
  await assert.rejects(sync.register('issue-a', { automatic: true }), /別のGoogleアカウント/);
  const remote = { session: fixture('issue-a', '上書きしない'), sync: { id: 'file-0', modifiedTime: 'v0' }, hash: await sessionFingerprint(fixture()) };
  await assert.rejects(sync.reconcile(remote, sync.capture()), /別アカウントのローカル課題/);
  assert.equal((await store.loadIssue('issue-a')).title, '課題A');
});

test('deletion also removes local ownership but keeps the migration tombstone', async () => {
  const { store, sync } = await setup(null, null);
  const local = await store.saveIssue(fixture()); await store.claimIssue(local.issueId, 'account-a');
  await sync.reloadRegistrations();
  await sync.deleteIssue(local.issueId, sessionContent(local));
  assert.equal(await store.loadOwner(local.issueId), null);
  assert.equal(sync.ownerOf(local.issueId), undefined);
  assert.ok(await store.load('meta:removed-issue:' + local.issueId));
});

test('confirmed local-only deletion works without Google and leaves other issues/settings untouched', async () => {
  const store = memoryStore(), { account } = mockDrive();
  account.profile = null; account.hasDrive = false;
  const local = await store.saveIssue(fixture());
  await store.saveIssue(fixture('other-issue', '残す課題'));
  await store.save('settings:test', { apiKey: 'not-an-issue' });
  const sync = new LiveIssueSync(store, account); await sync.init();
  assert.equal(issueDeleteBlockReason(null, account), '');
  assert.deepEqual(await sync.deleteIssue(local.issueId, sessionContent(local)), { removed: true, driveTrashed: false });
  assert.equal(await store.loadIssue(local.issueId), null);
  assert.ok(await store.load(`meta:removed-issue:${local.issueId}`));
  assert.equal((await store.listIssues()).length, 1);
  assert.ok(await store.load('settings:test'));
});

test('Drive deletion trashes the registered file and atomically removes local issue/sync/conflict', async () => {
  const { store, account, files, sync } = await setup();
  await store.save('conflict:issue-a', { profileId: 'account-a', session: fixture() });
  files.set('other-file', { session: fixture('other', '別課題'), modifiedTime: 'v0' });
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  assert.deepEqual(await sync.deleteIssue('issue-a', sessionContent(local), registration), { removed: true, driveTrashed: true });
  assert.deepEqual(account.trashes, ['file-0']);
  assert.ok(files.has('other-file'));
  assert.equal(await store.loadIssue('issue-a'), null);
  assert.equal(await store.loadSync('issue-a'), null);
  assert.equal(await store.loadConflict('issue-a'), null);
  assert.equal(sync.registrations.has('issue-a'), false);
  await sync.refreshAll();
  assert.equal(await store.loadIssue('issue-a'), null, 'deleted task is not downloaded again');
});

test('Drive failure never deletes the local task or its registration', async () => {
  const { store, account, sync } = await setup();
  account.trashIssue = async () => { throw new Error('通信失敗'); };
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(local), registration), /通信失敗/);
  assert.deepEqual(await store.loadIssue('issue-a'), local);
  assert.deepEqual(await store.loadSync('issue-a'), registration);
  assert.equal(await store.load('meta:removed-issue:issue-a'), undefined);
});

test('Drive task deletion is blocked when logged out or signed into a different account', async () => {
  const { store, account, sync } = await setup();
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  account.profile = null;
  assert.match(issueDeleteBlockReason(registration, account), /ログイン/);
  await assert.rejects(async () => sync.deleteIssue('issue-a', sessionContent(local), registration), /ログイン/);
  account.profile = { id: 'account-b' };
  assert.match(issueDeleteBlockReason(registration, account), /切り替えて/);
  await assert.rejects(async () => sync.deleteIssue('issue-a', sessionContent(local), registration), /切り替えて/);
  assert.deepEqual(account.trashes, []);
  assert.ok(await store.loadIssue('issue-a'));
});

test('offline Drive deletion is blocked, while local-only deletion is still available', async () => {
  const { store, account, sync } = await setup();
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    assert.match(issueDeleteBlockReason(registration, account), /ネットワーク/);
    await assert.rejects(async () => sync.deleteIssue('issue-a', sessionContent(local), registration), /ネットワーク/);
    const unregistered = await store.saveIssue(fixture('offline-local', 'ローカル課題'));
    assert.equal((await sync.deleteIssue(unregistered.issueId, sessionContent(unregistered))).removed, true);
    assert.ok(await store.loadIssue('issue-a'));
    assert.deepEqual(account.trashes, []);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('active Live editor cannot delete a task', async () => {
  const { store, account, sync } = await setup(fixture(), fixture(), { options: { canApplyRemote: () => false } });
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(await store.loadIssue('issue-a')), await store.loadSync('issue-a')), /Liveを停止/);
  assert.deepEqual(account.trashes, []);
  assert.ok(await store.loadIssue('issue-a'));
});

test('changes after deletion confirmation are refused before any Drive write', async () => {
  const { store, account, sync } = await setup();
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  await store.saveIssue(fixture('issue-a', '確認後の変更'));
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(local), registration), /変更された/);
  assert.deepEqual(account.trashes, []);
  assert.equal((await store.loadIssue('issue-a')).title, '確認後の変更');
});

test('new Drive registration after local-only confirmation cannot silently broaden deletion scope', async () => {
  const { store, account, sync } = await setup();
  const local = await store.loadIssue('issue-a');
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(local)), /登録先が変わりました/);
  assert.deepEqual(account.trashes, []);
  assert.ok(await store.loadIssue('issue-a'));
});

test('remote version changed after confirmation prevents deletion', async () => {
  const { store, account, files, sync } = await setup();
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  files.get('file-0').modifiedTime = 'changed-on-another-device';
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(local), registration), /更新されています/);
  assert.deepEqual(account.trashes, []);
  assert.ok(await store.loadIssue('issue-a'));
});

test('account change during trashing preserves the local cache', async () => {
  const { store, account, sync } = await setup();
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  const trash = account.trashIssue.bind(account);
  account.trashIssue = async (...args) => {
    const result = await trash(...args); account.profile = { id: 'account-b' }; account.generation++;
    sync.accountChanged(); return result;
  };
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(local), registration), /接続が変わりました/);
  assert.ok(await store.loadIssue('issue-a'));
  assert.deepEqual(await store.loadSync('issue-a'), registration);
});

test('another editor changing the task during trashing retains its new local content', async () => {
  const { store, account, sync } = await setup();
  const local = await store.loadIssue('issue-a'), registration = await store.loadSync('issue-a');
  const trash = account.trashIssue.bind(account);
  account.trashIssue = async (...args) => { const result = await trash(...args); await store.saveIssue(fixture('issue-a', '別画面の変更')); return result; };
  await assert.rejects(sync.deleteIssue('issue-a', sessionContent(local), registration), /ローカル版は残しています/);
  assert.equal((await store.loadIssue('issue-a')).title, '別画面の変更');
  const result = await sync.refreshAll();
  assert.equal(result.backups, 1, 'normal reconciliation preserves late edits as a local-only copy');
  assert.equal((await store.listIssues())[0].title, '別画面の変更（Drive未送信の退避）');
});

test('deleted task tombstone prevents the legacy draft from recreating it', async () => {
  const store = memoryStore(), { account } = mockDrive();
  const local = await store.saveIssue(fixture());
  await store.save('draft', local);
  const sync = new LiveIssueSync(store, account); await sync.init();
  await sync.deleteIssue(local.issueId, sessionContent(local));
  await store.migrateLegacy();
  assert.equal(await store.loadIssue(local.issueId), null);
});

test('content hash ignores save timestamps and graph array order but detects edge edits', async () => {
  const original = fixture();
  const copy = { ...structuredClone(original), savedAt: '2035-01-01T00:00:00Z', updatedAt: '1999-01-01T00:00:00Z' };
  copy.graph.nodes.reverse();
  assert.equal(await sessionFingerprint(original), await sessionFingerprint(copy));
  copy.graph.edges = [];
  assert.notEqual(await sessionFingerprint(original), await sessionFingerprint(copy));
});

test('last update advances for diagram/title edits, not save-only or diagnostic log updates', async () => {
  const store = memoryStore();
  const initial = await store.saveIssue(fixture());
  const saveOnly = await store.saveIssue({ ...initial, savedAt: new Date().toISOString(), logs: [{ kind: 'info', text: 'log', time: initial.savedAt }] });
  assert.equal(saveOnly.updatedAt, initial.updatedAt);
  saveOnly.graph.edges = [];
  const edited = await store.saveIssue(saveOnly);
  assert.notEqual(edited.updatedAt, initial.updatedAt);
});

test('editor autosave detects a cache changed by another tab instead of overwriting it', async () => {
  const store = memoryStore();
  const original = await store.saveIssue(fixture());
  await store.saveIssue(fixture('issue-a', '別画面の更新'));
  assert.equal(await store.saveEditedIssue(fixture('issue-a', '手元の更新'), sessionContent(original)), null);
  assert.equal((await store.loadIssue('issue-a')).title, '別画面の更新');
});

test('Google token expiry switches account status instead of leaving synchronization pending', async () => {
  const account = new LiveGoogleAccount(() => {}, () => {});
  account.profile = { id: 'account-a' }; account.token = 'token'; account.hasDrive = true;
  account.expiresAt = Date.now() - 1;
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { removeItem() {} };
  try {
    account.scheduleExpiry();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(account.profile, null);
    assert.equal(account.token, null);
  } finally { clearTimeout(account.expiryTimer); globalThis.sessionStorage = previousStorage; }
});

test('equal UUID/content shares one issue and creates a baseline, not a duplicate', async () => {
  const { store, sync } = await setup(fixture(), { ...fixture(), savedAt: '2099-01-01T00:00:00Z' });
  assert.equal(sync.status('issue-a').state, 'connecting');
  await sync.refreshAll();
  assert.equal(sync.status('issue-a').state, 'synced');
  assert.equal((await store.listIssues()).length, 1);
  assert.equal((await store.loadSync('issue-a')).lastSyncedHash, await sessionFingerprint(fixture()));
  assert.ok(!JSON.stringify(await store.loadIssue('issue-a')).includes('profileId'));
});

test('Drive-only issue is downloaded with a separate registration', async () => {
  const { store, sync } = await setup(null);
  const result = await sync.refreshAll();
  assert.equal(result.downloaded, 1);
  assert.equal((await store.loadIssue('issue-a')).title, '課題A');
  assert.equal((await store.loadSync('issue-a')).id, 'file-0');
});

test('local-only change updates the same Drive file', async () => {
  const local = fixture(); local.graph.edges = [];
  const { store, account, files, sync } = await setup(local);
  await sync.refreshAll();
  assert.equal(account.writes.length, 1);
  assert.equal(account.writes[0].id, 'file-0');
  assert.equal(files.size, 1);
  assert.equal(files.get('file-0').session.graph.edges.length, 0);
  assert.equal((await store.loadSync('issue-a')).lastSyncedHash, await sessionFingerprint(local));
  assert.equal(sync.status('issue-a').state, 'synced');
});

test('Drive-only change replaces an unchanged local snapshot', async () => {
  const remote = fixture('issue-a', 'Driveで変更');
  const { store, account, sync } = await setup(fixture(), remote);
  await sync.refreshAll();
  assert.equal((await store.loadIssue('issue-a')).title, remote.title);
  assert.equal((await store.listIssues()).length, 1);
  assert.equal(account.writes.length, 0);
});

test('divergent local and Drive changes preserve both as a conflict', async () => {
  const { store, account, sync } = await setup(fixture('issue-a', 'ローカル'), fixture('issue-a', 'Drive'));
  const result = await sync.refreshAll();
  assert.equal(result.conflicts, 1);
  assert.equal(sync.status('issue-a').state, 'conflict');
  assert.equal((await store.loadIssue('issue-a')).title, 'ローカル');
  assert.equal((await store.loadConflict('issue-a')).session.title, 'Drive');
  assert.equal(account.writes.length, 0);
});

test('without a known baseline, differing snapshots conflict instead of using timestamps', async () => {
  const local = { ...fixture('issue-a', 'ローカル'), updatedAt: '2099-01-01T00:00:00Z' };
  const { store, account, sync } = await setup(local, fixture(), { baseline: false });
  await sync.refreshAll();
  assert.equal(sync.status('issue-a').state, 'conflict');
  assert.equal(account.writes.length, 0);
  assert.equal((await store.loadIssue('issue-a')).title, 'ローカル');
});

test('missing clean cache is removed; local-only and other-account issues remain', async () => {
  const { store, sync } = await setup(fixture(), null);
  await store.saveIssue(fixture('local-only'));
  await store.saveIssue(fixture('other-account'));
  await store.saveSync({ issueId: 'other-account', id: 'other-file', profileId: 'account-b', lastSyncedHash: '' });
  await sync.reloadRegistrations();
  const result = await sync.refreshAll();
  assert.equal(result.removed, 1);
  assert.equal(await store.loadIssue('issue-a'), null);
  assert.equal(await store.loadSync('issue-a'), null);
  assert.deepEqual((await store.listIssues()).map(s => s.issueId).sort(), ['local-only', 'other-account']);
});

test('missing cache with unsent changes is copied to a new local-only UUID before removal', async () => {
  const local = fixture('issue-a', '未送信');
  const { store, sync } = await setup(local, null);
  const result = await sync.refreshAll();
  assert.equal(result.removed, 1); assert.equal(result.backups, 1);
  assert.equal(await store.loadIssue('issue-a'), null);
  const [backup] = await store.listIssues();
  assert.notEqual(backup.issueId, 'issue-a');
  assert.ok(backup.title.includes('Drive未送信の退避'));
  assert.deepEqual(backup.messages, local.messages);
  assert.equal(await store.loadSync(backup.issueId), null);
});

test('cache removal does not get resurrected by the preserved legacy draft', async () => {
  const { store, sync } = await setup(fixture(), null);
  await store.save('draft', fixture());
  await sync.refreshAll();
  await store.migrateLegacy();
  assert.equal(await store.loadIssue('issue-a'), null);
  assert.ok(await store.load('draft'));
});

test('failed list or failed body download cannot remove any cache', async () => {
  for (const method of ['list', 'load']) {
    const { store, account, sync } = await setup();
    account[method] = async () => { throw new Error('network failed'); };
    await assert.rejects(sync.refreshAll(), /network failed/);
    assert.ok(await store.loadIssue('issue-a'));
    assert.ok(await store.loadSync('issue-a'));
    assert.equal(sync.status('issue-a').state, 'error');
    assert.equal(account.writes.length, 0);
  }
});

test('duplicate UUIDs or mismatched metadata/body fail closed without overwrites or cleanup', async () => {
  for (const kind of ['duplicate', 'mismatch']) {
    const { store, account, files, sync } = await setup();
    if (kind === 'duplicate') files.set('file-1', { session: fixture(), modifiedTime: 'v0' });
    else account.list = async () => [{ id: 'file-0', appProperties: { issueId: 'different-id' } }];
    await assert.rejects(sync.refreshAll(), /UUID/);
    assert.equal((await store.listIssues()).length, 1);
    assert.equal(account.writes.length, 0);
  }
});

test('account change during download cancels reconciliation and deletion', async () => {
  const { store, account, sync } = await setup();
  const load = account.load.bind(account);
  account.load = async id => {
    const remote = await load(id);
    account.profile = { id: 'account-b' }; account.generation++;
    sync.accountChanged();
    return remote;
  };
  await assert.rejects(sync.refreshAll(), error => error.cancelled === true);
  assert.equal((await store.loadSync('issue-a')).profileId, 'account-a');
  assert.ok(await store.loadIssue('issue-a'));
  assert.equal(account.writes.length, 0);
  assert.equal(sync.status('issue-a').state, 'foreign');
});

test('local edit during a remote fetch is detected before replacement', async () => {
  const { store, account, sync } = await setup(fixture(), fixture('issue-a', 'Drive編集'));
  const load = account.load.bind(account);
  account.load = async id => { await store.saveIssue(fixture('issue-a', '取得中の編集')); return load(id); };
  await sync.refreshAll();
  assert.equal((await store.loadIssue('issue-a')).title, '取得中の編集');
  assert.equal(sync.status('issue-a').state, 'conflict');
});

test('compare-and-swap failure retains an edit made just before the replacement', async () => {
  const { store, sync } = await setup(fixture(), fixture('issue-a', 'Drive編集'));
  const commit = store.commitIssue;
  store.commitIssue = async (...args) => { await store.saveIssue(fixture('issue-a', '別タブの編集')); return commit(...args); };
  await sync.refreshAll();
  assert.equal((await store.loadIssue('issue-a')).title, '別タブの編集');
  assert.equal(sync.status('issue-a').state, 'syncing');
  assert.equal((await store.loadSync('issue-a')).lastSyncedHash, await sessionFingerprint(fixture()));
});

test('an edit during upload is not acknowledged as synced and is sent next time', async () => {
  const local = fixture('issue-a', '送信開始時');
  const { store, account, sync } = await setup(local);
  const save = account.save.bind(account);
  account.save = async (...args) => { await store.saveIssue(fixture('issue-a', '送信中の追加編集')); return save(...args); };
  await sync.refreshAll();
  assert.equal(sync.status('issue-a').state, 'syncing');
  assert.equal((await store.loadSync('issue-a')).lastSyncedHash, await sessionFingerprint(local));
  account.save = save;
  await sync.syncIssue('issue-a');
  assert.equal(account.writes.length, 2);
  assert.equal(account.writes[1].session.title, '送信中の追加編集');
  assert.equal(sync.status('issue-a').state, 'synced');
});

test('upload failure retains the old baseline and skips missing-cache cleanup', async () => {
  const { store, account, sync } = await setup(fixture('issue-a', '未送信'));
  await store.saveIssue(fixture('missing'));
  await store.saveSync({ issueId: 'missing', id: 'gone', profileId: 'account-a', lastSyncedHash: await sessionFingerprint(fixture('missing')) });
  await sync.reloadRegistrations();
  account.save = async () => { throw new Error('upload failed'); };
  const result = await sync.refreshAll();
  assert.equal(result.errors, 1);
  assert.ok(await store.loadIssue('missing'));
  assert.equal((await store.loadSync('issue-a')).lastSyncedHash, await sessionFingerprint(fixture()));
  assert.equal(sync.status('issue-a').state, 'error');
});

for (const choice of ['local', 'drive']) test(`conflict resolution adopts ${choice} and backs up the other version`, async () => {
  const { store, account, files, sync } = await setup(fixture('issue-a', 'ローカル編集'), fixture('issue-a', 'Drive編集'));
  await sync.refreshAll();
  files.set('file-0', { session: fixture('issue-a', 'さらに新しいDrive版'), modifiedTime: 'newer' });
  const result = await sync.resolve('issue-a', choice);
  const backup = await store.loadIssue(result.backupId);
  assert.ok(backup);
  assert.equal((await store.listIssues()).length, 2);
  assert.equal(await store.loadSync(result.backupId), null);
  assert.equal(await store.loadConflict('issue-a'), null);
  if (choice === 'local') {
    assert.equal(account.writes[0].session.title, 'ローカル編集');
    assert.ok(backup.title.startsWith('さらに新しいDrive版'));
  } else {
    assert.equal((await store.loadIssue('issue-a')).title, 'さらに新しいDrive版');
    assert.ok(backup.title.startsWith('ローカル編集'));
    assert.equal(account.writes.length, 0);
  }
  assert.equal(sync.status('issue-a').state, 'synced');
});

test('registering a local-only issue creates one file and persists registration separately', async () => {
  const store = memoryStore(); await store.saveIssue(fixture());
  const { account, files } = mockDrive();
  const sync = new LiveIssueSync(store, account); await sync.init();
  await sync.register('issue-a');
  assert.equal(files.size, 1);
  assert.equal((await store.loadSync('issue-a')).id, 'new-file');
  assert.equal(sync.status('issue-a').state, 'synced');
  assert.ok(!JSON.stringify(await store.loadIssue('issue-a')).includes('lastSyncedHash'));
});

test('old Drive documents without a UUID get a stable ID on different clients', async () => {
  const remote = fixture(); remote.issueId = '';
  const first = await setup(null, remote), second = await setup(null, remote);
  await first.sync.refreshAll(); await second.sync.refreshAll();
  const [a] = await first.store.listIssues(), [b] = await second.store.listIssues();
  assert.ok(a.issueId.startsWith('drive-'));
  assert.equal(a.issueId, b.issueId);
});

test('cloud link migration retains account/file but never invents a content baseline', async () => {
  const store = memoryStore();
  const data = new Map([['decontradictor.live.cloudLink.issue-a', JSON.stringify({ issueId: 'issue-a', profileId: 'account-a', id: 'file-0', modifiedTime: 'v0' })]]);
  const storage = { get length() { return data.size; }, key: index => [...data.keys()][index],
    getItem: key => data.get(key), removeItem: key => data.delete(key) };
  await store.migrateCloudLinks(storage);
  assert.equal((await store.loadSync('issue-a')).lastSyncedHash, '');
  assert.equal(data.size, 0);
});

test('offline login state cannot trigger any cleanup', async () => {
  const { store, account, sync } = await setup(fixture(), null);
  account.profile = null; sync.accountChanged();
  assert.equal(sync.status('issue-a').state, 'offline');
  await assert.rejects(sync.refreshAll(), /接続/);
  assert.ok(await store.loadIssue('issue-a'));
});

test('active Live editor defers remote replacement and missing-cache deletion', async () => {
  for (const remote of [fixture('issue-a', 'Drive編集'), null]) {
    const { store, sync } = await setup(fixture(), remote, { options: { canApplyRemote: () => false } });
    await sync.refreshAll();
    assert.equal((await store.loadIssue('issue-a')).title, '課題A');
    assert.ok(['conflict', 'error'].includes(sync.status('issue-a').state));
  }
});

test('Drive list refuses incomplete searches and missing pagination pages', async () => {
  for (const body of [{ incompleteSearch: true, files: [] }, {}]) {
    const account = new LiveGoogleAccount(() => {}, () => {});
    account.profile = { id: 'user' }; account.token = 'token'; account.expiresAt = Date.now() + 60000; account.hasDrive = true;
    account.request = async () => new Response(JSON.stringify(body));
    await assert.rejects(account.list(), /完全に取得/);
  }
});

test('Drive download rejects a document updated while its body was being fetched', async () => {
  const account = new LiveGoogleAccount(() => {}, () => {});
  account.profile = { id: 'user' }; account.token = 'token'; account.expiresAt = Date.now() + 60000; account.hasDrive = true;
  let metadataReads = 0;
  account.request = async url => new Response(JSON.stringify(url.includes('alt=media') ? fixture()
    : { id: 'file', modifiedTime: 'v' + metadataReads++ }));
  await assert.rejects(account.load('file'), /取得中に更新/);
});
