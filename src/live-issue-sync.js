import { sessionContent, sessionFingerprint, validateSession } from './live-session-store.js';

export const SYNC_LABELS = { local: 'ローカルのみ', connecting: '接続中', syncing: '同期中',
  synced: '同期済み', offline: '接続待ち', conflict: '競合', error: '同期エラー', foreign: '別アカウント', paused: '同期停止中' };

export function issueDeleteBlockReason(registration, account) {
  if (!registration) return '';
  if (!account?.signedIn || !account.hasDrive) return 'Drive登録済みの課題を削除するには、登録したGoogleアカウントへログインしてください。';
  if (account.profile?.id !== registration.profileId) return 'この課題を登録したGoogleアカウントへ切り替えてください。';
  if (globalThis.navigator?.onLine === false) return 'Drive登録済みの課題を削除するには、ネットワークへ接続してください。';
  return '';
}

const backupOf = (session, suffix) => ({ ...session, issueId: crypto.randomUUID(),
  title: `${session.title.slice(0, 75)}（${suffix}）`, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

// ステータスはメモリ上だけ。前回同期した内容の指紋と登録先は課題本文と別に保持する。
export class LiveIssueSync {
  constructor(store, account, { onChange = () => {}, onIssueChanged = () => {}, canApplyRemote = () => true, autoSyncEnabled = () => true } = {}) {
    this.store = store;
    this.account = account;
    this.onChange = onChange;
    this.onIssueChanged = onIssueChanged;
    this.canApplyRemote = canApplyRemote;
    this.autoSyncEnabled = autoSyncEnabled;
    this.owners = new Map();
    this.registrations = new Map();
    this.states = new Map();
    this.queue = Promise.resolve();
    this.epoch = 0;
  }

  async init(storage) {
    await this.store.migrateCloudLinks(storage);
    await this.reloadRegistrations();
    for (const id of this.registrations.keys()) this.setState(id, 'connecting');
  }

  async reloadRegistrations() {
    this.registrations = new Map((await this.store.listSync()).map(sync => [sync.issueId, sync]));
    this.owners = new Map((await this.store.listOwners()).map(owner => [owner.issueId, owner.profileId]));
  }

  ownerOf(issueId) { return this.registrations.get(issueId)?.profileId || this.owners.get(issueId); }

  accountChanged() {
    this.epoch++;
    const profileId = this.account?.profile?.id;
    for (const id of new Set([...this.registrations.keys(), ...this.owners.keys()])) {
      this.setState(id, profileId && profileId !== this.ownerOf(id) ? 'foreign'
        : this.account?.signedIn && this.account.hasDrive && globalThis.navigator?.onLine !== false ? 'connecting' : 'offline');
    }
  }

  status(issueId) {
    if (this.account?.signedIn && this.ownerOf(issueId) === this.account.profile?.id && !this.autoSyncEnabled()) {
      return { state: 'paused', detail: '共通設定でGoogle Driveの自動同期を停止しています。ローカル保存は続けます。' };
    }
    return this.states.get(issueId) || { state: this.ownerOf(issueId) ? 'connecting' : 'local', detail: '' };
  }
  setState(issueId, state, detail = '') {
    this.states.set(issueId, { state, detail });
    this.onChange(issueId, this.status(issueId));
  }
  markDirty(issueId) {
    const sync = this.registrations.get(issueId);
    if (!sync && !this.owners.has(issueId)) return;
    const state = this.status(issueId).state;
    if (['conflict', 'connecting', 'error', 'foreign'].includes(state)) return;
    this.setState(issueId, this.account?.signedIn && this.account.profile.id === this.ownerOf(issueId) && globalThis.navigator?.onLine !== false ? 'syncing' : 'offline');
  }

  capture({ automatic = false } = {}) {
    if (!this.account?.signedIn || !this.account.hasDrive || globalThis.navigator?.onLine === false) {
      this.accountChanged();
      throw new Error('ネットワークとGoogle Driveの接続を確認してください。');
    }
    if (automatic && !this.autoSyncEnabled()) { const error = new Error('自動同期を停止しています。'); error.cancelled = true; throw error; }
    return { profileId: this.account.profile.id, generation: this.account.generation || 0, epoch: this.epoch, automatic };
  }
  check(context) {
    if (!this.account?.signedIn || !this.account.hasDrive || this.account.profile?.id !== context.profileId
      || (this.account.generation || 0) !== context.generation || this.epoch !== context.epoch || (context.automatic && !this.autoSyncEnabled())) {
      const error = new Error('Googleアカウントの接続が変わりました。再度同期してください。');
      error.cancelled = true;
      throw error;
    }
  }
  exclusive(context, action) {
    const run = async () => {
      if (context) this.check(context);
      const execute = async () => { if (context) this.check(context); return action(); };
      // 同一ブラウザのTOP・実行画面によるDrive更新も直列化する。
      return globalThis.navigator?.locks
        ? navigator.locks.request(`${this.store.databaseName}:drive-sync`, execute) : execute();
    };
    const pending = this.queue.catch(() => {}).then(run);
    this.queue = pending;
    return pending;
  }

  deleteIssue(issueId, expectedContent, expectedSync = null) {
    const blocked = issueDeleteBlockReason(expectedSync, this.account);
    if (blocked) throw new Error(blocked);
    const context = expectedSync ? this.capture() : null;
    // ローカルのみの削除もDrive照合と同じロックで直列化する。
    return this.exclusive(context, async () => {
      const [local, sync] = await Promise.all([this.store.loadIssue(issueId), this.store.loadSync(issueId)]);
      if (!local || sessionContent(local) !== expectedContent) throw new Error('課題が変更されたか、すでに削除されています。一覧を確認して削除し直してください。');
      if ((sync?.id || null) !== (expectedSync?.id || null) || (sync?.profileId || null) !== (expectedSync?.profileId || null)
        || (sync?.modifiedTime || '') !== (expectedSync?.modifiedTime || '')) {
        throw new Error('確認中にDrive登録先が変わりました。一覧を確認して削除し直してください。');
      }
      if (!this.canApplyRemote(issueId)) throw new Error('Liveを停止してから課題を削除してください。');
      if (sync) {
        this.check(context);
        const reason = issueDeleteBlockReason(sync, this.account);
        if (reason) throw new Error(reason);
        // Driveが失敗した場合、課題本文・登録先・競合データはそのまま残す。
        await this.account.trashIssue(issueId, sync);
        this.check(context);
      }
      const committed = await this.store.commitIssue(issueId, expectedContent, { remove: true });
      if (!committed) throw new Error(sync
        ? 'Drive側はゴミ箱へ移しましたが、別画面で更新されたローカル版は残しています。「同期・更新」で確認してください。'
        : '別画面で課題が更新されたため、削除しませんでした。一覧を確認して削除し直してください。');
      this.registrations.delete(issueId);
      this.owners.delete(issueId);
      this.states.delete(issueId);
      this.onIssueChanged({ issueId, removed: true });
      this.onChange(issueId, null);
      return { removed: true, driveTrashed: !!sync };
    });
  }
  async remember(sync, context) {
    this.check(context);
    await this.store.saveSync(sync);
    this.check(context);
    this.registrations.set(sync.issueId, sync);
  }

  async readRemote(file, context) {
    this.check(context);
    const remote = await this.account.load(file.id);
    this.check(context);
    const session = validateSession(remote.session);
    if (!session.issueId) {
      // 課題ID導入前のDriveファイルにも、全端末で同じ安定したIDを付ける。
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.id));
      session.issueId = 'drive-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
    }
    if (!session.issueId || (file.appProperties?.issueId && file.appProperties.issueId !== session.issueId)) {
      throw new Error(`Drive課題のUUIDが不正です: ${file.name || file.id}。ローカルは削除していません。`);
    }
    return { session, sync: { ...remote.sync, id: file.id }, hash: await sessionFingerprint(session) };
  }

  async refreshAll({ registerLocal = false, automatic = false } = {}) {
    const context = this.capture({ automatic });
    for (const id of new Set([...this.registrations.keys(), ...this.owners.keys()])) {
      if (this.ownerOf(id) === context.profileId) this.setState(id, 'connecting');
    }
    return this.exclusive(context, async () => {
      const summary = { downloaded: 0, uploaded: 0, removed: 0, backups: 0, conflicts: 0, errors: 0, pending: 0, registered: 0 };
      try {
        const localCandidates = registerLocal ? await this.store.listIssues() : [];
        const files = await this.account.list();
        this.check(context);
        // 全ページ・全本文の取得と検証が成功するまでは、欠落課題を削除しない。
        const remotes = [];
        let next = 0;
        const downloads = await Promise.allSettled(Array.from({ length: Math.min(3, files.length) }, async () => {
          while (next < files.length) {
            const file = files[next++];
            remotes.push(await this.readRemote(file, context));
          }
        }));
        const failure = downloads.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        this.check(context);
        const ids = new Set();
        for (const remote of remotes) {
          if (ids.has(remote.session.issueId)) throw new Error('Driveに同じUUIDのファイルが複数あります。自動上書き・削除を止めました。');
          ids.add(remote.session.issueId);
        }
        await this.reloadRegistrations();
        for (const remote of remotes) {
          try {
            const result = await this.reconcile(remote, context);
            if (result in summary) summary[result]++;
          } catch (error) {
            if (error.cancelled) throw error;
            summary.errors++;
            this.setState(remote.session.issueId, 'error', error.message);
          }
        }
        // 照合・更新で失敗した場合も、削除は次回の完全な照合まで保留する。
        if (!summary.errors) {
          for (const sync of this.registrations.values()) {
            if (sync.profileId !== context.profileId || ids.has(sync.issueId)) continue;
            const result = await this.pruneMissing(sync, context);
            if (result.removed) summary.removed++;
            if (result.backupId) summary.backups++;
          }
          // Driveの全取得・照合に成功した後だけ、未登録のローカル課題を登録する。
          // 整理・版選択で作られた退避コピーは次回の照合で対象にする。
          for (const candidate of localCandidates) {
            this.check(context);
            if (await this.store.loadSync(candidate.issueId)) continue;
            const owner = await this.store.loadOwner(candidate.issueId);
            if (owner && owner.profileId !== context.profileId) continue;
            if (!await this.store.loadIssue(candidate.issueId)) continue;
            try { await this.registerInside(candidate.issueId, context); summary.registered++; }
            catch (error) {
              if (error.cancelled) throw error;
              summary.errors++; this.setState(candidate.issueId, 'error', error.message);
            }
          }
        }
        return summary;
      } catch (error) {
        if (!error.cancelled) for (const id of new Set([...this.registrations.keys(), ...this.owners.keys()])) {
          if (this.ownerOf(id) === context.profileId) this.setState(id, this.account.signedIn ? 'error' : 'offline', error.message);
        }
        throw error;
      }
    });
  }

  async reconcile(remote, context) {
    this.check(context);
    const issueId = remote.session.issueId;
    const sync = await this.store.loadSync(issueId);
    if (sync && sync.profileId !== context.profileId) throw new Error('同じUUIDが別のGoogleアカウントに登録されています。ローカルの内容は変更していません。');
    const owner = await this.store.loadOwner(issueId);
    if (owner && owner.profileId !== context.profileId) throw new Error('この課題は別アカウントのローカル課題です。自動上書きを止めました。');
    const local = await this.store.loadIssue(issueId);
    const localHash = local ? await sessionFingerprint(local) : null;
    const nextSync = { issueId, profileId: context.profileId, id: remote.sync.id,
      modifiedTime: remote.sync.modifiedTime || '', lastSyncedHash: remote.hash };
    this.check(context);
    if (localHash === remote.hash) {
      const committed = await this.store.commitIssue(issueId, sessionContent(local), { sync: nextSync, conflict: null, owner: context.profileId });
      this.check(context);
      if (!committed) { this.setState(issueId, 'syncing'); return 'pending'; }
      this.registrations.set(issueId, nextSync);
      this.setState(issueId, 'synced');
      return 'equal';
    }
    if (!local || (sync?.lastSyncedHash && localHash === sync.lastSyncedHash)) {
      if (!this.canApplyRemote(issueId)) return this.conflict(remote, local, sync, context, 'Driveに更新があります。Liveを停止して、課題一覧で同期してください。');
      this.setState(issueId, 'syncing');
      this.check(context);
      const committed = await this.store.commitIssue(issueId, local ? sessionContent(local) : null,
        { session: remote.session, sync: nextSync, conflict: null, owner: context.profileId });
      this.check(context);
      if (!committed) { this.setState(issueId, 'syncing'); return 'pending'; }
      this.registrations.set(issueId, nextSync);
      this.onIssueChanged({ issueId, session: remote.session });
      this.setState(issueId, 'synced');
      return 'downloaded';
    }
    // 別ファイルに差し替わっている場合は、旧ファイルの同期基準を流用しない。
    if (sync?.id === remote.sync.id && sync.lastSyncedHash === remote.hash) {
      await this.upload(local, localHash, remote.sync, context);
      return 'uploaded';
    }
    return this.conflict(remote, local, sync, context);
  }

  async conflict(remote, local, sync, context, detail = 'ローカルとDriveの内容が異なります。両方を残して採用する版を選べます。') {
    this.check(context);
    const issueId = remote.session.issueId;
    const registration = { issueId, profileId: context.profileId, id: remote.sync.id,
      modifiedTime: remote.sync.modifiedTime || '', lastSyncedHash: sync?.id === remote.sync.id ? sync.lastSyncedHash || '' : '' };
    const committed = await this.store.commitIssue(issueId, local ? sessionContent(local) : null,
      { sync: registration, conflict: { profileId: context.profileId, ...remote }, owner: context.profileId });
    this.check(context);
    if (!committed) { this.setState(issueId, 'syncing'); return 'pending'; }
    this.registrations.set(issueId, registration);
    this.setState(issueId, 'conflict', detail);
    return 'conflicts';
  }

  async upload(local, sentHash, remoteSync, context) {
    const issueId = local.issueId;
    this.setState(issueId, 'syncing');
    this.check(context);
    const saved = await this.account.save(local, { ...remoteSync, profileId: context.profileId });
    this.check(context);
    if (!await this.store.loadIssue(issueId)) throw new Error('送信中にローカルの課題が削除されました。Driveから再取得してください。');
    await this.remember({ issueId, profileId: context.profileId, id: saved.id,
      modifiedTime: saved.modifiedTime || '', lastSyncedHash: sentHash }, context);
    await this.store.remove(`conflict:${issueId}`);
    const latest = await this.store.loadIssue(issueId);
    // 送信中に追加された編集は送信済みとみなさない。
    const latestHash = latest ? await sessionFingerprint(latest) : null;
    this.check(context);
    this.setState(issueId, latestHash === sentHash ? 'synced' : 'syncing');
    return saved;
  }

  async pruneMissing(sync, context) {
    this.check(context);
    const currentSync = await this.store.loadSync(sync.issueId);
    if (currentSync?.profileId !== context.profileId || currentSync.id !== sync.id) return {};
    if (!this.canApplyRemote(sync.issueId)) {
      this.setState(sync.issueId, 'error', 'Drive一覧にこの課題がありません。Liveを停止して課題一覧で確認してください。');
      return {};
    }
    const local = await this.store.loadIssue(sync.issueId);
    const dirty = local && (!sync.lastSyncedHash || await sessionFingerprint(local) !== sync.lastSyncedHash);
    const backup = dirty ? backupOf(local, 'Drive未送信の退避') : null;
    this.check(context);
    const committed = await this.store.commitIssue(sync.issueId, local ? sessionContent(local) : null, { remove: true, backup, backupProfileId: context.profileId });
    this.check(context);
    if (!committed) { this.setState(sync.issueId, 'syncing'); return {}; }
    this.registrations.delete(sync.issueId);
    this.owners.delete(sync.issueId);
    this.states.delete(sync.issueId);
    this.onIssueChanged({ issueId: sync.issueId, removed: true, backupId: backup?.issueId });
    this.onChange(sync.issueId, null);
    return { removed: true, backupId: backup?.issueId };
  }

  syncIssue(issueId, { automatic = false } = {}) {
    const context = this.capture({ automatic });
    return this.exclusive(context, async () => {
      const sync = await this.store.loadSync(issueId);
      if (!sync) return;
      if (sync.profileId !== context.profileId) throw new Error('この課題を登録したGoogleアカウントへ接続してください。');
      try { return await this.reconcile(await this.readRemote({ id: sync.id, appProperties: { issueId } }, context), context); }
      catch (error) {
        if (!error.cancelled) this.setState(issueId, this.account.signedIn ? 'error' : 'offline', error.message);
        throw error;
      }
    });
  }

  register(issueId, { automatic = false } = {}) {
    const context = this.capture({ automatic });
    return this.exclusive(context, () => this.registerInside(issueId, context)).catch(error => {
      if (!error.cancelled) this.setState(issueId, this.account.signedIn ? 'error' : 'offline', error.message);
      throw error;
    });
  }

  async registerInside(issueId, context) {
    this.check(context);
    const sync = await this.store.loadSync(issueId);
    if (sync?.profileId && sync.profileId !== context.profileId) throw new Error('この課題は別のGoogleアカウントに登録済みです。');
    if (!await this.store.claimIssue(issueId, context.profileId)) throw new Error('課題が更新・削除されたか、別のGoogleアカウントの課題です。');
    this.check(context);
    this.owners.set(issueId, context.profileId);
    this.setState(issueId, 'connecting');
    const file = sync || await this.account.findSessionFile(issueId);
    this.check(context);
    if (file) return this.reconcile(await this.readRemote({ ...file, appProperties: { issueId } }, context), context);
    const local = await this.store.loadIssue(issueId);
    if (!local) throw new Error('課題が見つかりません。');
    const hash = await sessionFingerprint(local);
    return this.upload(local, hash, null, context);
  }

  resolve(issueId, choice) {
    if (!['local', 'drive'].includes(choice)) throw new Error('採用する版が不正です。');
    const context = this.capture();
    return this.exclusive(context, async () => {
      const sync = await this.store.loadSync(issueId);
      if (!sync || sync.profileId !== context.profileId) throw new Error('この課題を登録したGoogleアカウントへ接続してください。');
      const remote = await this.readRemote({ id: sync.id, appProperties: { issueId } }, context);
      const local = await this.store.loadIssue(issueId);
      if (!local) throw new Error('ローカルの課題が見つかりません。');
      const localHash = await sessionFingerprint(local);
      if (localHash === remote.hash) return this.reconcile(remote, context);
      this.check(context);
      if (choice === 'local') {
        // 採用しないDrive版も、アップロード前にローカルへ退避する。
        const backup = backupOf(remote.session, '競合時のDrive版');
        await this.store.saveIssue(backup, { fromRemote: true });
        await this.store.claimIssue(backup.issueId, context.profileId);
        await this.upload(local, localHash, remote.sync, context);
        return { backupId: backup.issueId };
      }
      if (!this.canApplyRemote(issueId)) throw new Error('Live接続を停止してからDrive版を採用してください。');
      const backup = backupOf(local, '競合時のローカル版');
      const nextSync = { issueId, profileId: context.profileId, id: remote.sync.id,
        modifiedTime: remote.sync.modifiedTime || '', lastSyncedHash: remote.hash };
      this.check(context);
      const committed = await this.store.commitIssue(issueId, sessionContent(local),
        { session: remote.session, backup, sync: nextSync, conflict: null, owner: context.profileId, backupProfileId: context.profileId });
      this.check(context);
      if (!committed) throw new Error('選択中にローカルが編集されました。内容を確認してもう一度選択してください。');
      this.registrations.set(issueId, nextSync);
      this.onIssueChanged({ issueId, session: remote.session });
      this.setState(issueId, 'synced');
      return { backupId: backup.issueId };
    });
  }
}
