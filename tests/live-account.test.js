import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveSyncPreference } from '../src/drive-sync-preference.js';
import { DEFAULT_SETTINGS, LiveAccountSettings } from '../src/live-account-settings.js';
import { LiveAccountRestart } from '../src/live-account-restart.js';
import { LiveGoogleAccount, validateDriveSettings } from '../src/live-google-account.js';

const memoryStorage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const settingsA = { ...DEFAULT_SETTINGS, apiKey: 'test-key-a', voice: 'Zephyr', direction: '簡潔に' };

test('shared guest settings travel between TOP and issue pages only within the temporary tab storage', () => {
  const storage = memoryStorage(), temporary = memoryStorage();
  const top = new LiveAccountSettings(storage, temporary);
  top.save(null, settingsA);
  const issuePage = new LiveAccountSettings(storage, temporary);
  assert.equal(issuePage.load(null).apiKey, settingsA.apiKey);
  assert.equal(issuePage.load(null).voice, settingsA.voice);
  assert.equal(storage.values.size, 0);
  assert.equal(issuePage.load('new-account').apiKey, '');
  issuePage.clearTemporary();
  assert.deepEqual(top.load(null), DEFAULT_SETTINGS);
});

test('auto sync defaults ON, pause is account/browser specific, and resume clears the pause', () => {
  const storage = memoryStorage(), preference = new DriveSyncPreference(storage);
  assert.equal(preference.enabled('a'), true);
  preference.setEnabled('a', false);
  assert.equal(preference.enabled('a'), false);
  assert.equal(preference.enabled('b'), true);
  assert.equal(preference.enabled(null), true);
  assert.equal(new DriveSyncPreference(storage).enabled('a'), false);
  assert.equal(new DriveSyncPreference(memoryStorage()).enabled('a'), true);
  preference.setEnabled('a', true);
  assert.equal(preference.enabled('a'), true);
  assert.equal(storage.values.size, 0);
  assert.throws(() => preference.setEnabled(null, false), /Googleログイン/);
});

test('startup ignores shared legacy settings and anonymous values', () => {
  const storage = memoryStorage();
  storage.setItem('decontradictor.live.apiKey', 'legacy-key');
  storage.setItem('decontradictor.live.voice', 'Leda');
  storage.setItem('decontradictor.live.avatarColor', 'pink');
  const settings = new LiveAccountSettings(storage);
  assert.deepEqual(settings.load(null), DEFAULT_SETTINGS);
  assert.deepEqual(settings.load('new-account'), DEFAULT_SETTINGS);
  settings.save(null, settingsA);
  assert.equal(storage.values.size, 3);
  assert.equal(storage.getItem('decontradictor.live.apiKey'), 'legacy-key');
});

test('each account restores only its own key, voice and direction', () => {
  const storage = memoryStorage();
  const settings = new LiveAccountSettings(storage);
  settings.save('a', settingsA);
  assert.deepEqual(settings.load('b'), DEFAULT_SETTINGS);
  settings.save('b', { ...DEFAULT_SETTINGS, apiKey: 'test-key-b' });
  const afterRestart = new LiveAccountSettings(storage);
  assert.equal(afterRestart.load('a').apiKey, 'test-key-a');
  assert.equal(afterRestart.load('a').voice, 'Zephyr');
  assert.equal(afterRestart.load('a').direction, '簡潔に');
  assert.equal(afterRestart.load('b').apiKey, 'test-key-b');
  assert.equal(afterRestart.load('b').voice, 'Puck');
  assert.equal(afterRestart.load('b').direction, '');
  assert.deepEqual(afterRestart.load(null), DEFAULT_SETTINGS);
});

test('legacy local and Drive icon colors are ignored without losing other preferences', () => {
  const storage = memoryStorage(), settings = new LiveAccountSettings(storage);
  const expected = { ...validateDriveSettings({ ...settingsA, app: 'decontradictor-live-settings', version: 1 }), rememberKey: true };
  for (const avatarColor of ['auto', 'blue', 'pink']) {
    const legacy = { ...settingsA, app: 'decontradictor-live-settings', version: 1, profileId: 'a', avatarColor };
    storage.setItem(settings.key('a'), JSON.stringify(legacy));
    assert.deepEqual(settings.load('a'), expected);
    assert.ok(!('avatarColor' in validateDriveSettings(legacy)));
    settings.save('a', legacy);
    assert.ok(!('avatarColor' in JSON.parse(storage.getItem(settings.key('a')))));
    assert.equal(settings.load('a').voice, 'Zephyr');
  }
});

test('remember-key opt out removes only that account key, retaining its preferences', () => {
  const storage = memoryStorage();
  const settings = new LiveAccountSettings(storage);
  settings.save('a', settingsA);
  settings.save('b', { ...settingsA, rememberKey: false });
  assert.equal(settings.load('b').apiKey, '');
  assert.equal(settings.load('b').voice, 'Zephyr');
  assert.equal(settings.load('b').rememberKey, false);
  assert.ok(!storage.getItem(settings.key('b')).includes('test-key-a'));
  assert.equal(settings.load('a').apiKey, 'test-key-a');
});

test('corrupt or mismatched-account settings fail back to empty defaults', () => {
  const storage = memoryStorage();
  const settings = new LiveAccountSettings(storage);
  storage.setItem(settings.key('a'), '{invalid');
  assert.deepEqual(settings.load('a'), DEFAULT_SETTINGS);
  settings.save('b', settingsA);
  storage.setItem(settings.key('a'), storage.getItem(settings.key('b')));
  assert.deepEqual(settings.load('a'), DEFAULT_SETTINGS);
  assert.deepEqual(new LiveAccountSettings().load('a'), DEFAULT_SETTINGS);
  assert.throws(() => new LiveAccountSettings().save('a', settingsA), /ブラウザ保存/);
});

test('startup knows whether account preferences exist even if the API key was deliberately forgotten', () => {
  const storage = memoryStorage(), settings = new LiveAccountSettings(storage);
  assert.equal(settings.hasSaved('a'), false);
  settings.save('a', { ...settingsA, rememberKey: false });
  assert.equal(settings.hasSaved('a'), true);
  assert.equal(settings.load('a').apiKey, '');
  assert.equal(settings.hasSaved('b'), false);
  storage.setItem(settings.key('b'), storage.getItem(settings.key('a')));
  assert.equal(settings.hasSaved('b'), false);
  storage.setItem(settings.key('a'), '{broken');
  assert.equal(settings.hasSaved('a'), false);
});

test('initial session restoration and same-account reconnection do not restart', () => {
  const boundary = new LiveAccountRestart(() => assert.fail('unexpected restart'), assert.fail);
  assert.equal(boundary.observe(null), false);
  assert.equal(boundary.observe({ id: 'a' }), false);
  boundary.enable();
  assert.equal(boundary.observe({ id: 'a' }), false);
  assert.equal(boundary.pending, null);
});

test('account change restarts once and waits for local save before navigating', async () => {
  const steps = [];
  let completeSave;
  const saved = new Promise(resolve => { completeSave = resolve; });
  const boundary = new LiveAccountRestart(async () => {
    steps.push('stop');
    steps.push('save');
    await saved;
    steps.push('home');
  }, assert.fail);
  boundary.observe({ id: 'a' }); boundary.enable();
  assert.equal(boundary.observe({ id: 'b' }), true);
  assert.equal(boundary.observe({ id: 'b' }), true);
  await Promise.resolve();
  assert.deepEqual(steps, ['stop', 'save']);
  completeSave(); await boundary.pending;
  assert.deepEqual(steps, ['stop', 'save', 'home']);
});

test('first login and logout also restart; failed save reports error instead of navigating', async () => {
  for (const [before, after] of [[null, { id: 'a' }], [{ id: 'a' }, null]]) {
    let restarts = 0;
    const boundary = new LiveAccountRestart(() => { restarts++; }, assert.fail);
    boundary.observe(before); boundary.enable(); boundary.observe(after);
    await boundary.pending;
    assert.equal(restarts, 1);
  }
  let message;
  const failed = new LiveAccountRestart(() => { throw new Error('保存失敗'); }, error => { message = error.message; });
  failed.enable(); failed.observe({ id: 'a' }); await failed.pending;
  assert.equal(message, '保存失敗');
});

test('Google switch persists the new token before restart notification and restores it after reload', async () => {
  const previous = { window: globalThis.window, fetch: globalThis.fetch, sessionStorage: globalThis.sessionStorage };
  const storage = memoryStorage();
  let config, requested, nextId = 'a';
  globalThis.sessionStorage = storage;
  globalThis.window = { google: { accounts: { oauth2: {
    initTokenClient: options => {
      config = options;
      return { requestAccessToken(options) {
        requested = options;
        queueMicrotask(() => config.callback({ access_token: nextId, expires_in: 3600, scope: options.scope }));
      } };
    },
    hasGrantedAllScopes: (response, ...scopes) => scopes.every(scope => response.scope.includes(scope)),
  } } } };
  globalThis.fetch = async (_, options) => {
    const id = options.headers.Authorization.split(' ')[1];
    return new Response(JSON.stringify({ sub: id, name: id, email: id + '@example.test' }));
  };
  let account, restored;
  try {
    const notifications = [];
    account = new LiveGoogleAccount(profile => {
      if (!profile) return;
      assert.equal(JSON.parse(storage.getItem('decontradictor.live.google')).token, profile.id);
      notifications.push(profile.id);
    }, assert.fail);
    await account.init('test.apps.googleusercontent.com');
    await account.login({ drive: true });
    nextId = 'b';
    const generation = account.generation;
    const login = account.login({ drive: true, selectAccount: true });
    assert.ok(account.generation > generation);
    assert.equal(account.signedIn, false, 'no Drive operations while selecting a new account');
    assert.equal(requested.prompt, 'select_account');
    assert.ok(!('hint' in requested));
    await login;
    assert.deepEqual(notifications, ['a', 'b']);
    assert.equal(account.profile.id, 'b');
    restored = new LiveGoogleAccount(profile => { assert.equal(profile.id, 'b'); }, assert.fail);
    await restored.init('test.apps.googleusercontent.com');
    assert.equal(restored.profile.id, 'b');
    assert.ok(restored.signedIn && restored.hasDrive);
  } finally {
    clearTimeout(account?.expiryTimer); clearTimeout(restored?.expiryTimer);
    Object.assign(globalThis, previous);
  }
});

test('settings read, write and delete stop when the account changes during lookup', async () => {
  for (const operation of ['loadSettings', 'saveSettings', 'deleteSettings']) {
    const account = new LiveGoogleAccount(() => {}, assert.fail);
    account.profile = { id: 'a' }; account.token = 'a'; account.expiresAt = Date.now() + 60000; account.hasDrive = true;
    account.findSettingsFile = async () => {
      account.profile = { id: 'b' }; account.token = 'b'; account.generation++;
      return 'a-settings';
    };
    account.request = async () => assert.fail('must not read or write A settings using B credentials');
    await assert.rejects(account[operation]({ ...settingsA, app: 'decontradictor-live-settings', version: 1 }), /設定の処理を中止/);
  }
});

test('automatic Drive authorization cannot continue an operation after choosing another account', async () => {
  const account = new LiveGoogleAccount(() => {}, assert.fail);
  account.login = async () => {
    account.profile = { id: 'b' }; account.token = 'b'; account.expiresAt = Date.now() + 60000; account.hasDrive = true;
  };
  await assert.rejects(account.authorizeDrive(), /再読み込み/);
});

test('a late unauthorized response from A cannot sign out the new account B', async () => {
  const previousFetch = globalThis.fetch;
  const account = new LiveGoogleAccount(() => assert.fail('B must remain logged in'), assert.fail);
  account.profile = { id: 'a' }; account.token = 'a'; account.expiresAt = Date.now() + 60000;
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  try {
    const request = account.request('https://www.googleapis.com/test-only');
    account.profile = { id: 'b' }; account.token = 'b'; account.generation++;
    finish(new Response(null, { status: 401 }));
    await assert.rejects(request, /再度ログイン/);
    assert.equal(account.profile.id, 'b');
    assert.ok(account.signedIn);
  } finally { globalThis.fetch = previousFetch; }
});
