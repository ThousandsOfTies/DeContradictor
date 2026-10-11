import { LiveFlowCanvas } from './live-flow.js';
import { validateSession } from './live-session-store.js';

// 不正な差分が画面・自動保存に入り込まないよう、一式を先に検証する。
// Geminiへの成功応答も、描画へ反映できた後にだけ返す。
export function applyValidatedFlowUpdate(canvas, update) {
  const operations = update?.operations;
  const supported = ['upsert_node', 'upsert_edge', 'remove_node', 'remove_edge'];
  if (!Array.isArray(operations) || !operations.length) throw new Error('図の差分操作がありません。');
  for (const operation of operations) {
    if (!supported.includes(operation?.op) || typeof operation.id !== 'string' || !operation.id.trim()) {
      throw new Error('図の操作名またはIDが不正です。');
    }
  }
  const candidate = new LiveFlowCanvas(null);
  candidate.restoreState(canvas.getState());
  candidate.applyUpdate(update);
  validateSession({ app: 'decontradictor-live', version: 1, messages: [], logs: [], graph: candidate.getState() });
  canvas.applyUpdate(update);
}
