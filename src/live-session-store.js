import { normalizeEmotion } from './live-emotions.js';

// APIキーやOAuthトークンを含まない、保存・共有用の明示的なデータ形式。
export function validateSession(input) {
  if (input?.app !== 'decontradictor-live' || input.version !== 1) {
    throw new Error('このアプリの会話保存ファイルではありません。');
  }
  const text = (v, limit = 20000) => typeof v === 'string' ? v.slice(0, limit) : '';
  const date = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : new Date().toISOString();
  const list = (v, limit) => {
    if (!Array.isArray(v) || v.length > limit) throw new Error('保存データの形式または件数が不正です。');
    return v;
  };
  const nodes = list(input.graph?.nodes, 500).map((n) => {
    if (typeof n?.id !== 'string' || !n.id || !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y)) {
      throw new Error('ノードのIDまたは座標が不正です。');
    }
    return { id: text(n.id, 200), type: text(n.type, 40), position: { x: n.position.x, y: n.position.y },
      data: Object.fromEntries(['label', 'description', 'kind', 'status'].map(k => [k, text(n.data?.[k], 500)])) };
  });
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) throw new Error('ノードIDが重複しています。');
  const edges = list(input.graph?.edges, 2000).map((e) => {
    if (typeof e?.id !== 'string' || !e.id || !ids.has(e.source) || !ids.has(e.target)) throw new Error('矢印の接続先が不正です。');
    return { id: text(e.id, 200), source: e.source, target: e.target, label: text(e.label || e.data?.label, 200), type: text(e.type, 40) };
  });
  if (new Set(edges.map(e => e.id)).size !== edges.length) throw new Error('矢印IDが重複しています。');
  const messages = list(input.messages, 1000).map(m => {
    if (!['user', 'model'].includes(m?.role)) throw new Error('発言者の形式が不正です。');
    return { role: m.role, text: text(m.text), time: date(m.time), emotion: normalizeEmotion(m.emotion),
      color: m.color === 'pink' ? 'pink' : 'blue', author: m.author ? {
        name: text(m.author.name, 100),
        picture: /^https:\/\//.test(m.author.picture || '') ? text(m.author.picture, 2000) : '',
      } : null };
  });
  const logs = list(input.logs, 300).map(l => ({
    kind: ['info', 'user', 'model', 'tool', 'emotion', 'flow', 'error'].includes(l?.kind) ? l.kind : 'info',
    text: text(l?.text), time: date(l?.time),
  }));
  return { app: 'decontradictor-live', version: 1,
    issueId: typeof input.issueId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(input.issueId) ? input.issueId : '',
    title: text(input.title, 100) || '会話',
    savedAt: date(input.savedAt), messages, logs, graph: { nodes, edges } };
}

export class LiveSessionStore {
  constructor(databaseName = 'DeContradictorLive') { this.databaseName = databaseName; }
  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.databaseName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sessions');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sessions', mode);
      const req = action(tx.objectStore('sessions'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('保存が中断されました。'));
    });
  }
  save(id, session) { return this.transaction('readwrite', s => s.put({ id, session }, id)); }
  load(id) { return this.transaction('readonly', s => s.get(id)); }
  list() { return this.transaction('readonly', s => s.getAll()); }
}
