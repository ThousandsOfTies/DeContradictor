import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSession } from '../src/live-session-store.js';
import { LiveFlowCanvas } from '../src/live-flow.js';
import { LIVE_EMOTIONS, normalizeEmotion, profileAvatar } from '../src/live-emotions.js';
import { LiveGoogleAccount, validateDriveSettings } from '../src/live-google-account.js';
import { GeminiLiveProbe } from '../src/gemini-live.js';

const fixture = () => ({ app: 'decontradictor-live', version: 1, issueId: 'test-issue', title: 'テスト', savedAt: '2026-09-26T00:00:00Z',
  apiKey: 'SHOULD_NOT_EXPORT', token: 'SHOULD_NOT_EXPORT',
  messages: [{ role: 'user', text: 'こんにちは', time: '2026-09-26T00:00:00Z',
    author: { name: '利用者', email: 'private@example.com', id: 'private-id', picture: 'https://lh3.googleusercontent.com/example' } },
    ...LIVE_EMOTIONS.map(emotion => ({ role: 'model', text: emotion, emotion, color: 'pink' }))],
  logs: [{ kind: 'info', text: 'テスト' }], graph: {
    nodes: ['a','b'].map((id, i) => ({ id, position: { x: i * 300, y: 25 }, data: { label: id } })),
    edges: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'ba', source: 'b', target: 'a' }],
  } });

test('9 emotions and unknown fallback', () => {
  assert.equal(LIVE_EMOTIONS.length, 9);
  assert.equal(normalizeEmotion('thinking'), 'thinking');
  assert.equal(normalizeEmotion('unexpected'), 'neutral');
});
test('cleared key input must not reuse the previous session key', async () => {
  const probe = new GeminiLiveProbe({ llm: { apiKey: 'previous-test-key' } });
  probe.els.apiKeyInput = { value: '' };
  let state;
  probe._setState = value => { state = value; };
  probe._appendLog = () => {};
  await probe.start({ textOnly: true });
  assert.equal(state, 'APIキー未設定');
  assert.equal(probe.socket, null);
});
test('Live function handler accepts all 9 emotions', () => {
  let received;
  const probe = new GeminiLiveProbe({ llm: {}, onEmotionDetected: emotion => { received = emotion; } });
  for (const emotion of LIVE_EMOTIONS) {
    assert.equal(probe._handleEmotionData({ emotion }).emotion, emotion);
    assert.equal(received, emotion);
  }
});
test('snapshot whitelist excludes credentials and account identifiers', () => {
  const output = validateSession(fixture());
  const serialized = JSON.stringify(output);
  for (const value of ['SHOULD_NOT_EXPORT', 'private@example.com', 'private-id']) assert.ok(!serialized.includes(value));
  assert.equal(output.messages[0].author.name, '利用者');
  assert.equal(output.messages[0].author.picture, 'https://lh3.googleusercontent.com/example');
  assert.deepEqual(output.messages.slice(1).map(m => m.emotion), LIVE_EMOTIONS);
  assert.deepEqual(validateSession(JSON.parse(serialized)), output);
});
test('reject invalid snapshot before replacing current graph', () => {
  assert.throws(() => validateSession({}));
  let input = fixture(); input.graph.nodes[0].position.x = NaN; assert.throws(() => validateSession(input));
  input = fixture(); input.graph.edges[0].target = 'missing'; assert.throws(() => validateSession(input));
  input = fixture(); input.graph.edges[0].id = 123; assert.throws(() => validateSession(input));
  input = fixture(); input.graph.nodes.push(input.graph.nodes[0]); assert.throws(() => validateSession(input));
  input = fixture(); input.messages[0].role = 'invalid'; assert.throws(() => validateSession(input));
});
test('cycle graph restore retains coordinates and isolates references', () => {
  const graph = validateSession(fixture()).graph;
  const flow = new LiveFlowCanvas(null);
  flow.restoreState(graph);
  assert.deepEqual(flow.getState(), graph);
  assert.equal(flow.layoutDirection, 'horizontal');
  assert.equal(flow.layoutBackEdges.size, 1);
  graph.nodes[0].position.x = 99;
  assert.equal(flow.nodes.get('a').position.x, 0);
  const copy = flow.getState(); copy.nodes[0].position.x = 55;
  assert.equal(flow.nodes.get('a').position.x, 0);
});
test('profile image uses account photo and fallback on load error', () => {
  const old = globalThis.document;
  const created = [];
  globalThis.document = { createElement: tag => {
    const element = { tag, children: [], append(child) { this.children.push(child); },
      addEventListener(name, callback) { this[name] = callback; }, remove() { this.removed = true; } };
    created.push(element); return element;
  } };
  try {
    const avatar = profileAvatar({ name: '太郎', picture: 'https://lh3.googleusercontent.com/test' });
    assert.equal(avatar.textContent, '太');
    assert.equal(avatar.children[0].src, 'https://lh3.googleusercontent.com/test');
    assert.equal(avatar.children[0].referrerPolicy, 'no-referrer');
    avatar.children[0].error(); assert.ok(avatar.children[0].removed);
    assert.equal(profileAvatar(null).textContent, '自');
    assert.equal(profileAvatar({ picture: 'javascript:alert(1)' }).children.length, 0);
  } finally { globalThis.document = old; }
});
test('Google profile, incremental Drive scope and multipart upload (mock network)', async () => {
  const previous = { window: globalThis.window, fetch: globalThis.fetch, sessionStorage: globalThis.sessionStorage };
  let config, requested;
  const storage = new Map();
  globalThis.sessionStorage = { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  globalThis.window = { google: { accounts: { oauth2: {
    initTokenClient: options => { config = options; return { requestAccessToken: options => {
      requested = options;
      queueMicrotask(() => config.callback({ access_token: 'test-token', expires_in: 3600, scope: options.scope }));
    } }; },
    hasGrantedAllScopes: (response, ...scopes) => scopes.every(scope => response.scope.includes(scope)),
  } } } };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('userinfo') ? { sub: '123', name: 'テスト', picture: 'https://lh3.googleusercontent.com/test' } : { id: 'file-id', name: 'test.json' }));
  };
  try {
    let profile;
    const account = new LiveGoogleAccount(value => { profile = value; }, message => assert.fail(message));
    await account.init('test.apps.googleusercontent.com'); await account.login();
    assert.equal(profile.name, 'テスト'); assert.ok(account.signedIn); assert.ok(!account.hasDrive);
    const saved = await account.save(validateSession(fixture()));
    assert.equal(saved.id, 'file-id'); assert.ok(requested.scope.includes('drive.file'));
    assert.ok(requested.scope.includes('drive.appdata'));
    const upload = calls.find(c => c.url.includes('upload/drive'));
    assert.ok(upload.options.body.type.startsWith('multipart/related; boundary='));
    const body = await upload.options.body.text();
    assert.ok(body.includes('decontradictor-live')); assert.ok(!body.includes('test-token')); assert.ok(!body.includes('SHOULD_NOT_EXPORT'));
    account.signOut(); assert.equal(profile, null); assert.equal(storage.size, 0);
    await assert.rejects(account.request('https://www.googleapis.com/anything'), /認証期限/);
  } finally { Object.assign(globalThis, previous); }
});

test('Drive settings include the API key only in a separate appDataFolder file', async () => {
  const account = new LiveGoogleAccount(() => {}, () => {});
  account.profile = { id: 'user' }; account.token = 'token'; account.expiresAt = Date.now() + 60000; account.hasDrive = true;
  const settings = validateDriveSettings({ app: 'decontradictor-live-settings', version: 1,
    apiKey: 'test-gemini-key', voice: 'Zephyr', avatarColor: 'pink', direction: '簡潔に' });
  let exists = false, stored = null, createdInAppData = false, updated = false, deleted = false;
  account.request = async (url, options = {}) => {
    if (url.includes('spaces=appDataFolder')) return new Response(JSON.stringify({ files: exists ? [{ id: 'settings-id' }] : [] }));
    if (options.method === 'POST') {
      const body = await options.body.text();
      createdInAppData = body.includes('appDataFolder') && body.includes('test-gemini-key');
      stored = settings; exists = true;
      return new Response(JSON.stringify({ id: 'settings-id' }));
    }
    if (options.method === 'PATCH') { updated = true; stored = JSON.parse(options.body); return new Response('{}'); }
    if (options.method === 'DELETE') { deleted = true; exists = false; return new Response(null, { status: 204 }); }
    if (url.includes('alt=media')) return new Response(JSON.stringify(stored));
    assert.fail(`unexpected URL: ${url}`);
  };
  assert.equal(await account.saveSettings(settings), 'settings-id');
  assert.ok(createdInAppData);
  assert.deepEqual(await account.loadSettings(), settings);
  assert.equal(await account.saveSettings({ ...settings, apiKey: 'new-key' }), 'settings-id');
  assert.ok(updated);
  assert.equal((await account.loadSettings()).apiKey, 'new-key');
  assert.equal(await account.deleteSettings(), true); assert.ok(deleted);
  assert.equal(await account.loadSettings(), null);
  assert.throws(() => validateDriveSettings({ apiKey: 'invalid' }), /形式/);
});

test('Drive session updates the same file and stops on remote conflict', async () => {
  const account = new LiveGoogleAccount(() => {}, () => {});
  account.profile = { id: 'user' }; account.token = 'token'; account.expiresAt = Date.now() + 60000; account.hasDrive = true;
  let exists = false, modifiedTime = '2026-10-10T00:00:00Z', posts = 0, patches = 0;
  account.request = async (url, options = {}) => {
    if (url.includes('files?q=')) return new Response(JSON.stringify({ files: exists ? [{ id: 'session-id', modifiedTime }] : [] }));
    if (url.includes('fields=id,modifiedTime')) return new Response(JSON.stringify({ id: 'session-id', modifiedTime }));
    if (options.method === 'POST') {
      posts++; exists = true;
      return new Response(JSON.stringify({ id: 'session-id', name: 'test.json', modifiedTime }));
    }
    if (options.method === 'PATCH') {
      patches++; modifiedTime = '2026-10-10T00:00:01Z';
      return new Response(JSON.stringify({ id: 'session-id', name: 'test.json', modifiedTime }));
    }
    assert.fail(`unexpected URL: ${url}`);
  };
  const session = validateSession(fixture());
  const first = await account.save(session);
  assert.equal(posts, 1); assert.equal(first.id, 'session-id');
  const second = await account.save(session, first);
  assert.equal(patches, 1); assert.equal(second.modifiedTime, modifiedTime);
  await assert.rejects(account.save(session, first), /別の端末/);
  assert.equal(patches, 1);
  await assert.rejects(account.save(session), /同じ課題/);
});
