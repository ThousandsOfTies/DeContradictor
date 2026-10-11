import '../src/live-page.css';
import { initGeminiLive } from '../src/gemini-live.js';
import { LiveFlowCanvas } from '../src/live-flow.js';
import { applyValidatedFlowUpdate } from '../src/live-flow-update.js';
import { LiveChat } from '../src/live-chat.js';

const $ = id => document.getElementById(id);
let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error(label);
  const item = document.createElement('li'); item.textContent = `✓ ${label}`; $('qa-results').append(item); passed++;
}
const sockets = [], played = [];

// この検証ページ内だけで通信を置換。実APIのURL・キーを外へ送らない。
class MockSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  constructor() {
    this.readyState = 0; this.sent = []; this.openingCount = 0;
    this.done = new Promise(resolve => { this.finishTurn = resolve; });
    sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  receive(message) { return this.onmessage?.({ data: JSON.stringify(message) }); }
  send(raw) {
    const message = JSON.parse(raw); this.sent.push(message);
    if (message.setup) queueMicrotask(() => this.receive({ setupComplete: {} }));
    if (message.clientContent?.turnComplete) {
      this.openingCount++;
      const content = message.clientContent.turns[0].parts[0].text;
      const context = JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
      queueMicrotask(async () => {
        const greeting = context.mode === 'new'
          ? 'こんにちは。ここでは困りごとや原因を一緒に整理して、改善の道筋を図にしていきます。思い当たる現象や原因、周辺で改善したいことを順不同で話してください。図や矢印はこちらで整理します。まず、いま一番気になっている困りごとは何ですか？'
          : `おかえりなさい。「${context.title}」の続きを進めましょう。前回は「${context.graph.nodes[0].data.label}」と「${context.graph.nodes[1].data.label}」を整理しましたね。両者の因果関係はまだ仮説です。次は手戻りが起きる場面を確かめましょう。ほかにも、その周辺で困っていることはありますか？`;
        await this.receive({ toolCall: { functionCalls: [{ name: 'change_emotion', id: 'greeting-emotion', args: { emotion: 'empathetic' } }] } });
        const split = Math.floor(greeting.length / 2);
        await this.receive({ serverContent: { outputTranscription: { text: greeting.slice(0, split) } } });
        await this.receive({ serverContent: { outputTranscription: { text: greeting.slice(split) },
          modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] }, turnComplete: true } });
        this.finishTurn();
      });
    }
    if (message.realtimeInput?.text) {
      queueMicrotask(async () => {
        await this.receive({ serverContent: { outputTranscription: { text: 'その現象はいつ起こりやすいですか？' }, turnComplete: true } });
      });
    }
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

async function run() {
  // 本番HTMLの構成を使うが、本番の初期化スクリプトは実行しない。
  const html = new DOMParser().parseFromString(await (await fetch('../live.html')).text(), 'text/html');
  const main = document.importNode(html.getElementById('live-page'), true);
  document.body.append(main);
  for (const link of main.querySelectorAll('a')) link.addEventListener('click', event => event.preventDefault());
  $('live-open-settings-btn').disabled = true;
  $('live-test-start-btn').hidden = true; // 検証はマイクなしのみ
  $('live-session-title').value = '手戻りを減らす';
  $('live-issue-name').textContent = '手戻りを減らす（検証用）';
  $('live-issue-sync').textContent = 'メモリ内の検証';
  $('live-test-direction-card').open = true;

  const chat = new LiveChat($('live-chat-list'), () => {});
  const flow = new LiveFlowCanvas($('live-flow-svg'), { emptyElement: $('live-flow-empty') });
  const originalSocket = window.WebSocket;
  window.WebSocket = MockSocket;
  window.addEventListener('pagehide', () => { window.WebSocket = originalSocket; }, { once: true });
  const probe = initGeminiLive({ llm: { apiKey: 'mock-key-not-real' },
    getIssueContext: () => ({ title: $('live-session-title').value, messages: chat.messages, graph: flow.getState() }),
    onReactFlowUpdate: update => applyValidatedFlowUpdate(flow, update),
  });
  probe.audioPlayer = { init: async () => {}, stopAll: () => {}, playChunk: data => played.push(data) };
  await probe.start({ textOnly: true });
  const first = sockets.at(-1); await first.done;
  check(first.openingCount === 1 && first.sent[1].clientContent.turns[0].parts[0].text.includes('新しい課題'), '初回の声かけ');
  check(chat.messages.length === 1 && chat.messages[0].role === 'model', '内部依頼を自分の発言にしない');
  check(chat.messages[0].text.includes('順不同') && chat.messages[0].text.includes('一番気になっている'), '説明・誘導がチャットに連結');
  check(chat.messages[0].emotion === 'empathetic' && $('live-chat-list').querySelector('.robot-avatar'), '感情付きロボアイコン');
  await first.receive({ setupComplete: {} });
  check(first.openingCount === 1, '接続通知が重複しても一度だけ');
  check(flow.nodes.size === 0, '挨拶だけで図を作らない');

  await probe.stop({ silent: true });
  chat.restore([{ role: 'user', text: '手戻りが多く、納期が遅れています。', time: new Date().toISOString() }]);
  flow.restoreState({ nodes: [
    { id: 'rework', position: { x: 50, y: 50 }, data: { label: '手戻りが多い', kind: 'ude', status: '確認済み' } },
    { id: 'delay', position: { x: 300, y: 50 }, data: { label: '納期が遅れる', kind: 'ude', status: '確認済み' } },
  ], edges: [{ id: 'rework-delay', source: 'rework', target: 'delay', label: '原因（仮説）' }] });
  await probe.start({ textOnly: true });
  const second = sockets.at(-1); await second.done;
  check(second.openingCount === 1 && chat.messages.at(-1).text.includes('前回は'), '再開の振り返り・次の誘導');
  check(second.sent[1].clientContent.turns[0].parts[0].text.includes('手戻りが多く、納期が遅れています。'), '保存した会話と図を引継ぎ');
  await first.receive({ setupComplete: {} });
  check(second.openingCount === 1, '古い接続通知を無視');
  check(played.length === 2, '音声チャンクの受信経路（再生は模擬）');
  await second.receive({ toolCall: { functionCalls: [{ name: 'get_issue_context', id: 'read-context', args: {} }] } });
  const context = second.sent.at(-1).toolResponse.functionResponses[0].response.result.context;
  check(context.graph.nodes.length === 2 && context.graph.edges.length === 1, '最新の図を読み取るツール');
  const before = JSON.stringify(flow.getState());
  await second.receive({ toolCall: { functionCalls: [{ name: 'update_react_flow', id: 'bad-update', args: {
    operations: [{ op: 'upsert_edge', id: 'bad', source: 'rework', target: 'missing' }],
  } }] } });
  check(JSON.stringify(flow.getState()) === before && second.sent.at(-1).toolResponse.functionResponses[0].response.result.accepted === false,
    '不正な図の差分を拒否');
  $('qa-status').textContent = `PASS ${passed}項目。以下は再開時の表示サンプルです（実際のGeminiの発話ではありません）。`;
}

run().catch(error => { $('qa-status').textContent = `FAIL: ${error.message}`; console.error(error); });
