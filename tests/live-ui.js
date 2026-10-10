import '../src/live-page.css';
import { robotAvatar, LIVE_EMOTIONS, EMOTIONS } from '../src/live-emotions.js';
import { LiveChat } from '../src/live-chat.js';
import { LiveSessionStore, validateSession } from '../src/live-session-store.js';

const assert = (condition, label) => { if (!condition) throw new Error(label); };
const send = (name, detail = {}) => window.dispatchEvent(new CustomEvent(name, { detail }));
const log = (kind, text) => send('gemini-live-log', { kind, text, time: new Date().toISOString() });
try {
  for (const color of ['blue', 'pink']) for (const emotion of LIVE_EMOTIONS) {
    const box = document.createElement('div');
    const avatar = robotAvatar(emotion, color);
    avatar.style.width = '72px'; avatar.style.height = '72px';
    const label = document.createElement('p'); label.textContent = EMOTIONS[emotion];
    box.append(avatar, label); document.getElementById('gallery').append(box);
  }
  const chat = new LiveChat(document.getElementById('live-chat-list'), () => {});
  chat.setProfile({ name: 'テストユーザー', picture: '' });
  log('user', '入力: 問題と原因を'); log('user', '入力: 整理したいです。');
  send('gemini-live-emotion', { emotion: 'thinking' });
  log('model', 'Gemini: 一緒に'); log('model', 'Gemini: 考えてみましょう。');
  assert(chat.messages.length === 2, 'ストリーム連結');
  assert(chat.messages[0].text === '問題と原因を整理したいです。', '入力連結');
  assert(chat.messages[1].emotion === 'thinking', '感情反映');
  send('gemini-live-emotion', { emotion: 'empathetic' });
  assert(chat.messages[1].emotion === 'empathetic', '応答途中の感情更新');
  send('gemini-live-turn-end'); chat.color = 'pink';
  log('model', 'Gemini: ボトルネックを順に確認していきましょう。');
  assert(chat.messages.length === 3 && chat.messages[2].color === 'pink', 'ターン分離・色');
  const session = validateSession({ app: 'decontradictor-live', version: 1, title: 'UIテスト',
    messages: chat.messages, logs: [], graph: { nodes: [], edges: [] } });
  const store = new LiveSessionStore('DeContradictorLive-UI-Tests');
  await store.init(); await store.save('test', session);
  const stored = (await store.load('test')).session;
  assert(JSON.stringify(session) === JSON.stringify(stored), 'IndexedDB復元');
  send('gemini-live-clear'); assert(chat.messages.length === 0, 'クリア');
  chat.restore(stored.messages); assert(chat.messages[0].author.name === 'テストユーザー', '発言者復元');
  store.db.close();
  document.getElementById('result').textContent = 'PASS: 連結 / 感情更新 / ターン分離 / 発言者 / IndexedDB保存・復元 / クリア';
} catch (error) { document.getElementById('result').textContent = `FAIL: ${error.message}`; }
