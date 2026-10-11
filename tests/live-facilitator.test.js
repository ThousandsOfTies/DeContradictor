import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueContext, buildFacilitatorInstruction, buildOpeningTurn,
  CONTEXT_NODE_PAGE_SIZE, CONTEXT_EDGE_PAGE_SIZE } from '../src/live-facilitator.js';
import { GeminiLiveProbe } from '../src/gemini-live.js';
import { LiveFlowCanvas } from '../src/live-flow.js';
import { applyValidatedFlowUpdate } from '../src/live-flow-update.js';

const node = (id, label = id) => ({ id, position: { x: 0, y: 0 }, data: { label, kind: 'ude', status: '確認済み' } });
const issue = () => ({ title: '手戻りを減らす',
  messages: [{ role: 'user', text: '手戻りが多く、納期が遅れます。', time: '2026-10-11T00:00:00Z' }],
  graph: { nodes: [node('rework', '手戻りが多い'), node('delay', '納期が遅れる')],
    edges: [{ id: 'rework-delay', source: 'rework', target: 'delay', label: '原因（仮説）' }] } });

test('new/resume uses actual conversation or graph, not task creation/save timestamps', () => {
  const blank = { title: 'ダイエット', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    logs: [{ kind: 'info', text: '接続完了' }], messages: [], graph: { nodes: [], edges: [] } };
  assert.equal(buildIssueContext(blank).mode, 'new');
  assert.equal(buildIssueContext({ ...blank, messages: [{ role: 'user', text: 'こんにちは' }] }).mode, 'resume');
  assert.equal(buildIssueContext({ ...blank, graph: issue().graph }).mode, 'resume');
  assert.equal(buildIssueContext({ ...blank, messages: [{ role: 'info', text: 'ログ' }, { role: 'user', text: ' ' }] }).mode, 'new');
});

test('context whitelist contains content, not credentials, Google identity, logs or coordinates', () => {
  const input = issue();
  Object.assign(input, { apiKey: 'secret-key', accessToken: 'secret-token', profile: { email: 'private@example.com' },
    logs: [{ text: 'secret-log' }] });
  input.messages[0].author = { name: 'secret-name', picture: 'https://example.com/secret-avatar' };
  input.graph.nodes[0].data.apiKey = 'secret-node';
  const before = structuredClone(input), context = buildIssueContext(input), json = JSON.stringify(context);
  for (const secret of ['secret-', 'private@example.com', 'position']) assert.ok(!json.includes(secret));
  assert.equal(context.title, input.title);
  assert.equal(context.graph.nodes[0].data.status, '確認済み');
  assert.equal(context.graph.edges[0].label, '原因（仮説）');
  context.graph.nodes[0].data.label = '変更';
  context.conversation.recentMessages[0].text = '変更';
  assert.deepEqual(input, before, 'context must not mutate the stored issue');
});

test('context retains the newest conversation within a bounded excerpt and marks omissions', () => {
  const input = { messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: `${i}:` + 'あ'.repeat(1500) })) };
  const context = buildIssueContext(input);
  assert.equal(context.conversation.messageCount, 30);
  assert.ok(context.conversation.truncated);
  assert.ok(context.conversation.omittedMessageCount > 0);
  assert.ok(context.conversation.recentMessages.reduce((total, message) => total + message.text.length, 0) <= 6000);
  assert.ok(context.conversation.recentMessages.at(-1).text.startsWith('29:'));
  assert.ok(context.conversation.recentMessages.every(message => message.text.length <= 1200));
  assert.equal(input.messages[29].text.length, 1503);
});

test('large diagrams have explicit, non-overlapping pages without changing IDs or endpoints', () => {
  const nodes = Array.from({ length: CONTEXT_NODE_PAGE_SIZE + 3 }, (_, i) => node(`n-${i}`));
  const edges = Array.from({ length: CONTEXT_EDGE_PAGE_SIZE + 2 }, (_, i) => ({ id: `e-${i}`, source: 'n-0', target: 'n-1' }));
  const input = { graph: { nodes, edges } };
  const first = buildIssueContext(input), second = buildIssueContext(input, {
    nodeOffset: first.graph.nextNodeOffset, edgeOffset: first.graph.nextEdgeOffset,
  });
  assert.equal(first.graph.nodeCount, nodes.length);
  assert.equal(first.graph.edgeCount, edges.length);
  assert.equal(first.graph.nodes.length, CONTEXT_NODE_PAGE_SIZE);
  assert.equal(second.graph.nodes.length, 3);
  assert.equal(second.graph.edges.length, 2);
  assert.equal(second.graph.nextNodeOffset, null);
  assert.equal(second.graph.nextEdgeOffset, null);
  assert.deepEqual([...first.graph.nodes, ...second.graph.nodes].map(n => n.id), nodes.map(n => n.id));
  assert.deepEqual([...first.graph.edges, ...second.graph.edges].map(e => e.id), edges.map(e => e.id));
  assert.equal(buildIssueContext(input, { nodeOffset: -1 }).graph.nodeOffset, 0);
});

test('facilitator role covers implicit UDE drawing, hypotheses, duplicate/containment distinction and elicitation', () => {
  const instruction = buildFacilitatorInstruction('落ち着いた口調で');
  for (const rule of ['TOC', 'TRIZ', 'UDE', '重複', '包含関係', '原因から結果', '原因（仮説）', 'get_issue_context',
    'ユーザーが手で直した図', '1〜2点', '否定された候補', '落ち着いた口調で']) assert.ok(instruction.includes(rule), rule);
  assert.ok(!instruction.includes('これは音声応答の動作確認です'));
});

test('opening requests differ for new/resume and do not invent progress from a title or greeting', () => {
  const newOpening = buildOpeningTurn(buildIssueContext({ title: '手戻りを減らす' }));
  const resumeOpening = buildOpeningTurn(buildIssueContext(issue()));
  assert.ok(newOpening.includes('何ができるか'));
  assert.ok(newOpening.includes('まだ述べていない現象や図は作らない'));
  assert.ok(resumeOpening.includes('振り返って'));
  assert.ok(resumeOpening.includes('挨拶しか残っていなければ分析はこれから'));
  assert.ok(resumeOpening.includes('手戻りが多い'));
  assert.ok(resumeOpening.includes('納期が遅れる'));
  assert.ok(resumeOpening.includes('次に進める作業を1つ'));
});

function mockProbe(t, getIssueContext = () => ({}), onReactFlowUpdate = null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const sockets = [], logs = [], events = [], played = [];
  class MockSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(json) { assert.equal(this.readyState, MockSocket.OPEN); this.sent.push(JSON.parse(json)); }
    open() { this.readyState = MockSocket.OPEN; this.onopen?.(); }
    receive(message) { return this.onmessage?.({ data: JSON.stringify(message) }); }
    close(code = 1000, reason = '') { this.readyState = MockSocket.CLOSED; this.onclose?.({ code, reason }); }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: MockSocket });
  t.after(() => previous ? Object.defineProperty(globalThis, 'WebSocket', previous) : delete globalThis.WebSocket);
  const probe = new GeminiLiveProbe({ llm: { apiKey: 'mock-key-not-real' }, getIssueContext, onReactFlowUpdate });
  probe.audioPlayer = { init: async () => {}, stopAll: () => {}, playChunk: data => played.push(data) };
  probe._appendLog = (kind, text) => logs.push({ kind, text });
  probe._dispatchLiveEvent = (name, detail) => events.push({ name, detail });
  t.after(() => probe.stop({ silent: true }));
  return { probe, sockets, logs, events, played };
}
async function connect(probe, sockets) {
  await probe.start({ textOnly: true });
  const socket = sockets.at(-1); socket.open();
  await socket.receive({ setupComplete: {} });
  return socket;
}
const openings = socket => socket.sent.filter(message => message.clientContent?.turnComplete);

test('successful setup triggers one opening without waiting for user input; duplicate setup does not repeat it', async t => {
  const { probe, sockets, logs } = mockProbe(t);
  const socket = await connect(probe, sockets);
  assert.equal(socket.sent[0].setup.generationConfig.responseModalities[0], 'AUDIO');
  assert.ok(socket.sent[0].setup.systemInstruction.parts[0].text.includes('TOC'));
  assert.ok(socket.sent[0].setup.tools[1].functionDeclarations.some(tool => tool.name === 'get_issue_context'));
  assert.equal(openings(socket).length, 1);
  assert.ok(openings(socket)[0].clientContent.turns[0].parts[0].text.includes('新しい課題'));
  assert.ok(logs.some(log => log.text.includes('初回の趣旨説明')));
  assert.ok(!logs.some(log => log.kind === 'user'), 'internal opening request must not become a user chat bubble');
  await socket.receive({ setupComplete: {}, serverContent: { outputTranscription: { text: 'こんにちは。' } } });
  assert.equal(openings(socket).length, 1);
  assert.ok(logs.some(log => log.kind === 'model' && log.text.includes('こんにちは。')));
});

test('resume opening includes the actual saved graph/history and response uses normal voice and chat paths', async t => {
  const { probe, sockets, logs, played, events } = mockProbe(t, issue);
  const socket = await connect(probe, sockets);
  const prompt = openings(socket)[0].clientContent.turns[0].parts[0].text;
  assert.ok(prompt.includes('作業を再開'));
  assert.ok(prompt.includes('rework-delay'));
  assert.ok(prompt.includes('手戻りが多く、納期が遅れます。'));
  await socket.receive({ toolCall: { functionCalls: [{ name: 'change_emotion', id: 'emotion-1', args: { emotion: 'empathetic' } }] } });
  await socket.receive({ serverContent: { outputTranscription: { text: '手戻りと納期遅れを整理していましたね。' },
    modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] }, turnComplete: true } });
  assert.deepEqual(played, ['AAA=']);
  assert.ok(logs.some(log => log.kind === 'model' && log.text.includes('整理していましたね')));
  assert.ok(events.some(event => event.name === 'gemini-live-emotion' && event.detail.emotion === 'empathetic'));
  assert.ok(events.some(event => event.name === 'gemini-live-turn-end'));
  assert.equal(openings(socket).length, 1);
});

test('reconnect captures fresh content and ignores delayed setup/close from a stopped connection', async t => {
  let current = {};
  const { probe, sockets } = mockProbe(t, () => current);
  const first = await connect(probe, sockets);
  await probe.stop({ silent: true });
  current = issue();
  await probe.start({ textOnly: true });
  const second = sockets.at(-1); second.open();
  await first.receive({ setupComplete: {} });
  first.onclose({ code: 1011, reason: 'late close' });
  assert.equal(probe.socket, second);
  assert.equal(probe.setupComplete, false);
  await second.receive({ setupComplete: {} });
  assert.equal(openings(first).length, 1);
  assert.equal(openings(second).length, 1);
  assert.ok(openings(second)[0].clientContent.turns[0].parts[0].text.includes('作業を再開'));
});

test('delayed Blob decoding from the old connection cannot send a greeting into the new connection', async t => {
  const { probe, sockets } = mockProbe(t);
  await probe.start({ textOnly: true });
  const first = sockets[0]; first.open();
  let resolve;
  const pending = probe._handleMessage({ text: () => new Promise(done => { resolve = done; }) });
  await probe.stop({ silent: true });
  await probe.start({ textOnly: true });
  const second = sockets[1]; second.open();
  resolve(JSON.stringify({ setupComplete: {} })); await pending;
  assert.equal(openings(second).length, 0);
  assert.equal(probe.setupComplete, false);
  await second.receive({ setupComplete: {} });
  assert.equal(openings(second).length, 1);
});

test('starting twice is ignored; stopping during audio initialization cannot open a socket later', async t => {
  const { probe, sockets } = mockProbe(t);
  let resolve, inits = 0;
  probe.audioPlayer.init = () => { inits++; return new Promise(done => { resolve = done; }); };
  probe.els.startBtn = {}; probe.els.stopBtn = {};
  const pending = probe.start({ textOnly: true });
  assert.equal(probe.starting, true);
  assert.equal(probe.els.startBtn.disabled, true);
  assert.equal(probe.els.stopBtn.disabled, false);
  await probe.start({ textOnly: true });
  assert.equal(inits, 1);
  await probe.stop({ silent: true });
  resolve(); await pending;
  assert.equal(probe.starting, false);
  assert.equal(sockets.length, 0);
  assert.equal(probe.els.startBtn.disabled, false);
});

test('connection failure before setup never sends an opening', async t => {
  const { probe, sockets, logs } = mockProbe(t);
  await probe.start({ textOnly: true });
  const socket = sockets[0]; socket.open(); socket.close(1011, 'quota');
  await socket.receive({ setupComplete: {} });
  assert.equal(probe.socket, null);
  assert.equal(openings(socket).length, 0);
  assert.ok(logs.some(log => log.kind === 'error' && log.text.includes('1011')));
});

test('get_issue_context reads fresh manual edits', async t => {
  const current = issue();
  const { probe, sockets } = mockProbe(t, () => current);
  const socket = await connect(probe, sockets);
  current.title = '人間が変えた課題名'; current.graph.nodes[0].data.label = '手で修正した現象';
  await socket.receive({ toolCall: { functionCalls: [{ id: 'read-1', name: 'get_issue_context', args: {} }] } });
  const result = socket.sent.at(-1).toolResponse.functionResponses[0].response.result;
  assert.equal(result.status, 'ok');
  assert.equal(result.context.title, current.title);
  assert.equal(result.context.graph.nodes[0].data.label, '手で修正した現象');
});

test('invalid graph operations are rejected atomically and returned as an error, not accepted', async t => {
  const canvas = new LiveFlowCanvas(null); canvas.restoreState(issue().graph);
  const before = canvas.getState();
  const { probe, sockets } = mockProbe(t, () => ({ graph: canvas.getState() }), update => applyValidatedFlowUpdate(canvas, update));
  const socket = await connect(probe, sockets);
  await socket.receive({ toolCall: { functionCalls: [
    { id: 'bad-1', name: 'update_react_flow', args: { operations: [
      { op: 'upsert_node', id: 'cause', node: { data: { label: '条件が曖昧' } } },
      { op: 'upsert_edge', id: 'bad-edge', source: 'cause', target: 'nonexistent' },
    ] } },
    { id: 'emotion-2', name: 'change_emotion', args: { emotion: 'thinking' } },
  ] } });
  assert.deepEqual(canvas.getState(), before);
  const responses = socket.sent.at(-1).toolResponse.functionResponses;
  assert.equal(responses[0].response.result.status, 'error');
  assert.equal(responses[0].response.result.accepted, false);
  assert.ok(responses[0].response.result.error.includes('接続先'));
  assert.equal(responses[1].response.result.status, 'ok', 'another tool in the batch must still be answered');
});

test('valid graph operations apply and automatically layout', () => {
  const canvas = new LiveFlowCanvas(null); canvas.restoreState(issue().graph);
  applyValidatedFlowUpdate(canvas, { operations: [
    { op: 'upsert_node', id: 'cause', node: { data: { label: '条件が曖昧', status: '仮説' } } },
    { op: 'upsert_edge', id: 'cause-rework', source: 'cause', target: 'rework', label: '原因（仮説）' },
  ] });
  assert.equal(canvas.nodes.size, 3);
  assert.equal(canvas.edges.size, 2);
  assert.equal(canvas.nodes.get('cause').data.status, '仮説');
  assert.ok(new Set([...canvas.nodes.values()].map(n => `${n.position.x},${n.position.y}`)).size === 3);
  assert.throws(() => applyValidatedFlowUpdate(canvas, { operations: [{ op: 'unknown', id: 'n' }] }));
});

test('successful graph tool returns acceptance and its changes appear in the next context read', async t => {
  const canvas = new LiveFlowCanvas(null); canvas.restoreState(issue().graph);
  const { probe, sockets } = mockProbe(t, () => ({ graph: canvas.getState() }), update => applyValidatedFlowUpdate(canvas, update));
  const socket = await connect(probe, sockets);
  await socket.receive({ toolCall: { functionCalls: [{ id: 'good-update', name: 'update_react_flow', args: { operations: [
    { op: 'upsert_node', id: 'cause', node: { data: { label: '条件が曖昧', status: '仮説' } } },
    { op: 'upsert_edge', id: 'cause-rework', edge: { source: 'cause', target: 'rework', label: '原因（仮説）' } },
  ] } }] } });
  assert.deepEqual(socket.sent.at(-1).toolResponse.functionResponses[0].response.result,
    { status: 'ok', accepted: true, operationCount: 2 });
  await socket.receive({ toolCall: { functionCalls: [{ id: 'read-after', name: 'get_issue_context', args: {} }] } });
  const graph = socket.sent.at(-1).toolResponse.functionResponses[0].response.result.context.graph;
  assert.equal(graph.nodeCount, 3);
  assert.equal(graph.nodes.find(n => n.id === 'cause').data.status, '仮説');
  assert.equal(graph.edgeCount, 2);
});

test('stopping while microphone permission is pending releases a late stream and cannot connect', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let resolveMic, tracksStopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => new Promise(resolve => { resolveMic = resolve; }),
  } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : delete globalThis.navigator);
  const { probe, sockets } = mockProbe(t);
  const pending = probe.start();
  await Promise.resolve(); // audio initialization completes before permission is requested
  assert.equal(typeof resolveMic, 'function');
  await probe.stop({ silent: true });
  resolveMic({ getTracks: () => [{ stop: () => { tracksStopped++; } }] });
  await pending;
  assert.equal(tracksStopped, 1);
  assert.equal(probe.mediaStream, null);
  assert.equal(sockets.length, 0);
  assert.equal(probe.starting, false);
});
