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
    savedAt: date(input.savedAt), updatedAt: date(input.updatedAt || input.savedAt),
    messages, logs, graph: { nodes, edges } };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// 保存操作の日時は内容の一致判定に含めない。図の配列順だけの違いも無視する。
export function sessionContent(input, { includeLogs = true } = {}) {
  const session = validateSession(input);
  const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const graph = { nodes: [...session.graph.nodes].sort(compareIds), edges: [...session.graph.edges].sort(compareIds) };
  return JSON.stringify(canonical({ issueId: session.issueId, title: session.title,
    messages: session.messages, graph, ...(includeLogs ? { logs: session.logs } : {}) }));
}

export async function sessionFingerprint(input) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionContent(input)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);

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

  remove(id) { return this.transaction('readwrite', s => s.delete(id)); }

  // 照合中に別タブで編集されても、古いスナップショットで置換・削除しない。
  commitIssue(issueId, expectedContent, { session, sync, conflict, backup, backupProfileId, owner, remove = false } = {}) {
    if (!validId(issueId)) throw new Error('課題IDが不正です。');
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sessions', 'readwrite');
      const records = tx.objectStore('sessions');
      let committed = false;
      let failure;
      const request = records.get(`issue:${issueId}`);
      request.onsuccess = () => {
        try {
          const current = request.result?.session;
          if ((current ? sessionContent(current) : null) !== expectedContent) return;
          const put = (id, value) => records.put({ id, session: value }, id);
          if (backup) {
            put(`issue:${backup.issueId}`, validateSession(backup));
            if (backupProfileId) put(`owner:${backup.issueId}`, { issueId: backup.issueId, profileId: backupProfileId });
          }
          if (remove) {
            records.delete(`issue:${issueId}`);
            records.delete(`sync:${issueId}`);
            records.delete(`conflict:${issueId}`);
            records.delete(`owner:${issueId}`);
            put(`meta:removed-issue:${issueId}`, { issueId });
          } else {
            if (session) put(`issue:${issueId}`, validateSession(session));
            if (sync) put(`sync:${issueId}`, sync);
            if (owner) put(`owner:${issueId}`, { issueId, profileId: owner });
            if (conflict) put(`conflict:${issueId}`, conflict);
            else if (conflict === null) records.delete(`conflict:${issueId}`);
          }
          committed = true;
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(failure || tx.error || new Error('同期管理データを保存できませんでした。'));
    });
  }

  async saveIssue(input, { fromRemote = false } = {}) {
    const session = validateSession(input);
    if (!session.issueId) throw new Error('課題IDが不正です。');
    if (!fromRemote) {
      const existing = await this.loadIssue(session.issueId);
      if (existing) session.updatedAt = sessionContent(existing, { includeLogs: false }) === sessionContent(session, { includeLogs: false })
        ? existing.updatedAt : new Date().toISOString();
    }
    await this.save(`issue:${session.issueId}`, session);
    return session;
  }

  async saveEditedIssue(input, expectedContent) {
    const session = validateSession(input);
    const existing = await this.loadIssue(session.issueId);
    if (!existing || sessionContent(existing) !== expectedContent) return null;
    session.updatedAt = sessionContent(existing, { includeLogs: false }) === sessionContent(session, { includeLogs: false })
      ? existing.updatedAt : new Date().toISOString();
    return await this.commitIssue(session.issueId, expectedContent, { session }) ? session : null;
  }

  async loadIssue(issueId) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(issueId || '')) return null;
    const record = await this.load(`issue:${issueId}`);
    return record ? validateSession(record.session) : null;
  }

  async listIssues() {
    return (await this.list())
      .filter(record => record.id?.startsWith('issue:'))
      .map(record => validateSession(record.session))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async loadSync(issueId) {
    const record = validId(issueId) ? await this.load(`sync:${issueId}`) : null;
    return record?.session || null;
  }
  async loadOwner(issueId) { return (validId(issueId) ? await this.load(`owner:${issueId}`) : null)?.session || null; }
  async listOwners() { return (await this.list()).filter(record => record.id?.startsWith('owner:')).map(record => record.session); }
  async claimIssue(issueId, profileId) {
    if (!profileId) return false;
    const [local, owner, sync] = await Promise.all([this.loadIssue(issueId), this.loadOwner(issueId), this.loadSync(issueId)]);
    if (!local || (owner && owner.profileId !== profileId) || (sync && sync.profileId !== profileId)) return false;
    return this.commitIssue(issueId, sessionContent(local), { owner: profileId });
  }
  async listSync() { return (await this.list()).filter(record => record.id?.startsWith('sync:')).map(record => record.session); }
  async saveSync(sync) {
    if (!validId(sync.issueId) || !sync.profileId || !sync.id) throw new Error('Drive登録情報が不正です。');
    await this.save(`sync:${sync.issueId}`, sync);
  }
  async loadConflict(issueId) { return (await this.load(`conflict:${issueId}`))?.session || null; }

  async migrateCloudLinks(storage) {
    if (!storage) return;
    const links = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith('decontradictor.live.cloudLink')) links.push(key);
    }
    for (const key of links) {
      let link;
      try { link = JSON.parse(storage.getItem(key)); } catch (_) { continue; }
      if (!validId(link?.issueId) || !link.profileId || !link.id) continue;
      if (await this.load(`meta:removed-issue:${link.issueId}`)) continue;
      if (!await this.loadSync(link.issueId)) await this.saveSync({ issueId: link.issueId, profileId: link.profileId,
        id: link.id, modifiedTime: link.modifiedTime || '', lastSyncedHash: '' });
      // 移行済みの登録情報が、次回起動時に復活しないようにする。
      storage.removeItem(key);
    }
  }

  async restoreDriveIssue(input) {
    const session = validateSession(input);
    const issueId = session.issueId || crypto.randomUUID();
    const existing = await this.loadIssue(issueId);
    let backupId = null;
    if (existing && sessionContent(existing) !== sessionContent({ ...session, issueId })) {
      backupId = crypto.randomUUID();
      await this.saveIssue({ ...existing, issueId: backupId, title: `${existing.title}（Drive復元前）`, savedAt: new Date().toISOString() });
    }
    await this.saveIssue({ ...session, issueId }, { fromRemote: true });
    return { issueId, backupId };
  }

  async migrateLegacy() {
    const migrationFinished = !!(await this.load('meta:issue-migration-v1'));
    const records = await this.list();
    const existing = new Set(records.filter(record => record.id?.startsWith('issue:')).map(record => record.id));
    for (const record of records.filter(item => item.id === 'draft' || (!migrationFinished && /^[a-zA-Z0-9-]{1,100}$/.test(item.id || '')))) {
      const session = validateSession(record.session);
      const issueId = record.id === 'draft' ? (session.issueId || 'legacy-draft') : `legacy-${record.id}`;
      if (records.some(item => item.id === `meta:removed-issue:${issueId}`)) continue;
      const key = `issue:${issueId}`;
      if (existing.has(key)) {
        // 旧画面を開いたまま更新した下書きだけは、初回移行後でも拾う。
        const current = records.find(item => item.id === key)?.session;
        if (record.id !== 'draft' || !current || session.savedAt <= current.savedAt) continue;
      }
      const title = record.id.startsWith('backup-') ? `${session.title}（読込前の退避）` : session.title;
      await this.saveIssue({ ...session, issueId, title });
      existing.add(key);
    }
    // 移行完了の印は最後に書く。途中で止まっても同じIDで安全に再実行できる。
    if (!migrationFinished) await this.save('meta:issue-migration-v1', { finishedAt: new Date().toISOString() });
  }
}
