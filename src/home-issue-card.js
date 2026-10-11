import { SYNC_LABELS } from './live-issue-sync.js';

export function issueCard(issue, { status, href, onConflict, onRetry, onDelete, deleteBlocked = '' }) {
  const card = document.createElement('article');
  card.className = 'home-issue';
  const link = document.createElement('a');
  link.className = 'home-issue-link'; link.href = href;
  const top = document.createElement('div'); top.className = 'home-issue-top';
  const title = document.createElement('strong'); title.textContent = issue.title;
  const arrow = document.createElement('span');
  arrow.className = 'home-issue-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
  top.append(title, arrow);
  const details = document.createElement('p');
  const updated = new Date(issue.updatedAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
  details.textContent = `更新 ${updated} · 会話 ${issue.messages.length}件 · ノード ${issue.graph.nodes.length}個`;
  link.append(top, details);
  const footer = document.createElement('div'); footer.className = 'home-issue-footer';
  const { state, detail } = status;
  const badge = document.createElement('span'); badge.className = 'sync-badge'; badge.dataset.state = state;
  badge.textContent = SYNC_LABELS[state]; badge.title = detail || '';
  footer.append(badge);
  const actions = document.createElement('div'); actions.className = 'home-issue-actions';
  if (state === 'conflict') {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '版を確認';
    button.addEventListener('click', () => onConflict(issue.issueId)); actions.append(button);
  } else if (state === 'error' && onRetry) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '再試行';
    button.addEventListener('click', onRetry); actions.append(button);
  }
  if (onDelete) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '削除';
    button.className = 'home-delete-button'; button.setAttribute('aria-label', `「${issue.title}」を削除`);
    button.disabled = !!deleteBlocked; button.title = deleteBlocked || 'この課題を削除';
    button.addEventListener('click', () => onDelete(issue.issueId)); actions.append(button);
  }
  footer.append(actions);
  card.append(link, footer);
  if (detail && ['error', 'conflict'].includes(state)) {
    const note = document.createElement('p'); note.className = 'home-issue-note'; note.textContent = detail; card.append(note);
  }
  return card;
}
