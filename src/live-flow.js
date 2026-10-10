const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_WIDTH = 190;
const NODE_HEIGHT = 88;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.5;

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asText(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * Gemini Liveが返すReact Flow形式の差分を、依存なしで確認する軽量キャンバス。
 * ノード・エッジの形はReact Flowへ渡せるように保ち、画面上ではSVGで描画する。
 */
export class LiveFlowCanvas {
  constructor(svg, { emptyElement = null, onChange = null } = {}) {
    this.onChange = onChange;
    this.svg = svg;
    this.emptyElement = emptyElement;
    this.nodes = new Map();
    this.edges = new Map();
    this.viewport = { x: 0, y: 0, scale: 1 };
    this.drag = null;
    this.hasReceivedData = false;
    this.selection = null;
    this.connectMode = false;
    this.pendingEdgeSource = null;
    this.layoutBackEdges = new Set();
    this.layoutDirection = 'vertical';
    this.nextHumanNodeNumber = 1;
    this.nextHumanEdgeNumber = 1;

    if (!this.svg) return;
    this._initSvg();
    this._bindEvents();
    this._render();
  }

  getState() {
    return structuredClone({ nodes: [...this.nodes.values()], edges: [...this.edges.values()] });
  }

  // 呼び出し元で保存形式を検証してから復元する。ユーザーの配置を維持する。
  restoreState(graph) {
    this.nodes = new Map(graph.nodes.map(node => [node.id, structuredClone(node)]));
    this.edges = new Map(graph.edges.map(edge => [edge.id, structuredClone(edge)]));
    this.selection = null;
    this.pendingEdgeSource = null;
    this.connectMode = false;
    this.hasReceivedData = this.nodes.size > 0;
    this.layoutBackEdges = this._findCycleBackEdges([...this.nodes.values()], [...this.edges.values()]);
    const xs = graph.nodes.map(n => n.position.x), ys = graph.nodes.map(n => n.position.y);
    this.layoutDirection = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 'horizontal' : 'vertical';
    if (this.svg) { this._syncEditorUi(); this.fitView(); }
  }

  _initSvg() {
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'Gemini応答から生成されたReact Flow図');
    this.svg.setAttribute('tabindex', '0');
    this.svg.replaceChildren();

    const defs = svgElement('defs');
    const pattern = svgElement('pattern', {
      id: 'live-flow-grid-pattern',
      width: 24,
      height: 24,
      patternUnits: 'userSpaceOnUse',
    });
    pattern.appendChild(svgElement('path', {
      d: 'M 24 0 L 0 0 0 24',
      fill: 'none',
      stroke: '#262743',
      'stroke-width': 1,
      opacity: 0.7,
    }));
    defs.appendChild(pattern);

    const marker = svgElement('marker', {
      id: 'live-flow-arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    marker.appendChild(svgElement('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      fill: '#8f88ff',
    }));
    defs.appendChild(marker);

    const backMarker = svgElement('marker', {
      id: 'live-flow-back-arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    backMarker.appendChild(svgElement('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      fill: '#ffaf73',
    }));
    defs.appendChild(backMarker);

    this.background = svgElement('rect', {
      class: 'live-flow-background',
      x: 0,
      y: 0,
      width: '100%',
      height: '100%',
      fill: 'url(#live-flow-grid-pattern)',
    });
    this.edgeLayer = svgElement('g', { class: 'live-flow-edge-layer' });
    this.nodeLayer = svgElement('g', { class: 'live-flow-node-layer' });
    this.viewportLayer = svgElement('g', { class: 'live-flow-viewport' });
    this.viewportLayer.append(this.edgeLayer, this.nodeLayer);
    this.svg.append(defs, this.background, this.viewportLayer);
  }

  _bindEvents() {
    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      this.drag = {
        type: 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: this.viewport.x,
        originY: this.viewport.y,
      };
      this.svg.setPointerCapture(event.pointerId);
      this.svg.classList.add('is-panning');
    });

    this.svg.addEventListener('pointermove', (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      const dx = event.clientX - this.drag.startX;
      const dy = event.clientY - this.drag.startY;

      if (this.drag.type === 'pan') {
        this.viewport.x = this.drag.originX + dx;
        this.viewport.y = this.drag.originY + dy;
      } else if (this.drag.type === 'node') {
        const node = this.nodes.get(this.drag.id);
        if (node) {
          node.position = {
            x: this.drag.originNodeX + dx / this.viewport.scale,
            y: this.drag.originNodeY + dy / this.viewport.scale,
          };
        }
      }
      this._render();
    });

    const finishPointer = (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      try { this.svg.releasePointerCapture(event.pointerId); } catch (_) {}
      this.drag = null;
      this.svg.classList.remove('is-panning');
    };
    this.svg.addEventListener('pointerup', finishPointer);
    this.svg.addEventListener('pointercancel', finishPointer);

    this.svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const worldX = (pointerX - this.viewport.x) / this.viewport.scale;
      const worldY = (pointerY - this.viewport.y) / this.viewport.scale;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.viewport.scale * factor));

      this.viewport.scale = nextScale;
      this.viewport.x = pointerX - worldX * nextScale;
      this.viewport.y = pointerY - worldY * nextScale;
      this._render();
    }, { passive: false });

    this.svg.addEventListener('contextmenu', (event) => event.preventDefault());

    this.svg.addEventListener('click', (event) => {
      if (event.target !== this.svg && event.target !== this.background) return;
      if (this.connectMode) {
        this._setEditStatus('接続モード中です。ノードを2つ選択してください。');
        return;
      }
      this._clearSelection();
    });

    this.svg.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this.deleteSelection();
      } else if (event.key === 'Escape') {
        this._cancelConnectMode();
        this._clearSelection();
      }
    });

    document.getElementById('live-flow-zoom-in')?.addEventListener('click', () => this._zoomBy(1.2));
    document.getElementById('live-flow-zoom-out')?.addEventListener('click', () => this._zoomBy(1 / 1.2));
    document.getElementById('live-flow-layout-btn')?.addEventListener('click', () => {
      this.autoLayout();
      this.fitView();
    });
    document.getElementById('live-flow-fit-btn')?.addEventListener('click', () => this.fitView());
    document.getElementById('live-flow-add-node-btn')?.addEventListener('click', () => this.addNode());
    document.getElementById('live-flow-connect-btn')?.addEventListener('click', () => {
      if (this.connectMode) this._cancelConnectMode();
      else this._startConnectMode();
    });
    document.getElementById('live-flow-delete-btn')?.addEventListener('click', () => this.deleteSelection());

    document.getElementById('live-flow-inspector')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this._saveSelectedNode();
    });
    document.getElementById('live-flow-inspector-close')?.addEventListener('click', () => {
      this._clearSelection();
    });

    this._syncEditorUi();
  }

  _zoomBy(factor) {
    const rect = this.svg.getBoundingClientRect();
    const pointerX = rect.width / 2;
    const pointerY = rect.height / 2;
    const worldX = (pointerX - this.viewport.x) / this.viewport.scale;
    const worldY = (pointerY - this.viewport.y) / this.viewport.scale;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.viewport.scale * factor));
    this.viewport.scale = nextScale;
    this.viewport.x = pointerX - worldX * nextScale;
    this.viewport.y = pointerY - worldY * nextScale;
    this._render();
  }

  _setEditStatus(text) {
    const status = document.getElementById('live-flow-edit-status');
    if (status) status.textContent = text;
  }

  _syncEditorUi() {
    const deleteButton = document.getElementById('live-flow-delete-btn');
    if (deleteButton) deleteButton.disabled = !this.selection;

    const connectButton = document.getElementById('live-flow-connect-btn');
    if (connectButton) {
      connectButton.setAttribute('aria-pressed', String(this.connectMode));
      connectButton.classList.toggle('is-active', this.connectMode);
      connectButton.textContent = this.connectMode ? '接続中止' : '接続';
    }

    const inspector = document.getElementById('live-flow-inspector');
    const labelInput = document.getElementById('live-flow-node-label');
    const descriptionInput = document.getElementById('live-flow-node-description');
    const selectedNode = this.selection?.type === 'node'
      ? this.nodes.get(this.selection.id)
      : null;
    if (!inspector) return;
    inspector.hidden = !selectedNode;
    if (!selectedNode) return;
    if (labelInput) labelInput.value = asText(selectedNode.data?.label, selectedNode.id);
    if (descriptionInput) descriptionInput.value = asText(selectedNode.data?.description);
  }

  _setSelection(type, id) {
    if (type === 'node' && !this.nodes.has(id)) return;
    if (type === 'edge' && !this.edges.has(id)) return;
    this.selection = { type, id };
    const item = type === 'node' ? this.nodes.get(id) : this.edges.get(id);
    const label = type === 'node'
      ? asText(item.data?.label, id)
      : `エッジ ${id}`;
    this._setEditStatus(`選択中: ${label}（Deleteキーまたは削除ボタンで削除）`);
    this._syncEditorUi();
    this._render();
  }

  _clearSelection() {
    this.selection = null;
    this._syncEditorUi();
    this._setEditStatus('ノードやエッジを選択すると編集できます。');
    this._render();
  }

  _startConnectMode() {
    this.connectMode = true;
    this.pendingEdgeSource = null;
    this._syncEditorUi();
    this._setEditStatus('接続モード: 始点ノード、終点ノードの順に選択してください。');
    this._render();
  }

  _cancelConnectMode() {
    this.connectMode = false;
    this.pendingEdgeSource = null;
    this._syncEditorUi();
    this._setEditStatus('ノードやエッジを選択すると編集できます。');
    this._render();
  }

  _handleConnectNode(id) {
    if (!this.connectMode) return;
    if (!this.pendingEdgeSource) {
      this.pendingEdgeSource = id;
      this._setSelection('node', id);
      this._setEditStatus(`始点「${asText(this.nodes.get(id)?.data?.label, id)}」を選択中。終点ノードを選択してください。`);
      return;
    }

    if (this.pendingEdgeSource === id) {
      this._setEditStatus('同じノード同士は接続できません。別の終点ノードを選択してください。');
      return;
    }

    const source = this.pendingEdgeSource;
    const edgeId = this._nextHumanEdgeId();
    this.edges.set(edgeId, {
      id: edgeId,
      source,
      target: id,
      type: 'default',
      label: '次へ',
      data: { origin: 'human' },
    });
    this.connectMode = false;
    this.pendingEdgeSource = null;
    this._layoutAfterEdit();
    this._setSelection('edge', edgeId);
    this._setEditStatus('エッジを追加し、自動配置しました。');
  }

  _nextHumanNodeId() {
    let id;
    do {
      id = `human-node-${this.nextHumanNodeNumber}`;
      this.nextHumanNodeNumber += 1;
    } while (this.nodes.has(id));
    return id;
  }

  _nextHumanEdgeId() {
    let id;
    do {
      id = `human-edge-${this.nextHumanEdgeNumber}`;
      this.nextHumanEdgeNumber += 1;
    } while (this.edges.has(id));
    return id;
  }

  addNode() {
    const id = this._nextHumanNodeId();
    const number = this.nextHumanNodeNumber - 1;
    this.nodes.set(id, {
      id,
      type: 'default',
      position: { x: 0, y: 60 },
      data: {
        label: `新しいノード${number}`,
        description: '手動で追加したノード',
        origin: 'human',
      },
    });
    this._layoutAfterEdit();
    this._setSelection('node', id);
    this._setEditStatus('ノードを追加しました。ラベルと説明を編集できます。');
  }

  deleteSelection() {
    if (!this.selection) {
      this._setEditStatus('削除するノードまたはエッジを選択してください。');
      return;
    }

    const { type, id } = this.selection;
    if (type === 'node') {
      this.nodes.delete(id);
      for (const [edgeId, edge] of this.edges) {
        if (edge.source === id || edge.target === id) this.edges.delete(edgeId);
      }
    } else {
      this.edges.delete(id);
    }
    this.selection = null;
    this._layoutAfterEdit();
    this._syncEditorUi();
    this._setEditStatus(type === 'node'
      ? 'ノードと接続エッジを削除し、自動配置しました。'
      : 'エッジを削除し、自動配置しました。');
  }

  _saveSelectedNode() {
    if (this.selection?.type !== 'node') return;
    const node = this.nodes.get(this.selection.id);
    if (!node) return;
    const labelInput = document.getElementById('live-flow-node-label');
    const descriptionInput = document.getElementById('live-flow-node-description');
    const label = asText(labelInput?.value).trim() || node.id;
    const description = asText(descriptionInput?.value).trim();
    node.data = { ...node.data, label, description, origin: 'human' };
    this._syncEditorUi();
    this._render();
    this._setEditStatus(`「${label}」を更新しました。`);
  }

  _layoutAfterEdit() {
    this.autoLayout();
    this.fitView();
  }

  /** Gemini Liveのupdate_react_flow引数を適用する。 */
  applyUpdate(update) {
    const operations = Array.isArray(update?.operations) ? update.operations : [];
    if (!operations.length) return;

    for (const operation of operations) {
      this._applyOperation(operation);
    }
    if (this.selection
      && ((this.selection.type === 'node' && !this.nodes.has(this.selection.id))
        || (this.selection.type === 'edge' && !this.edges.has(this.selection.id)))) {
      this.selection = null;
    }
    if (this.pendingEdgeSource && !this.nodes.has(this.pendingEdgeSource)) {
      this._cancelConnectMode();
    }
    this._syncEditorUi();
    this.autoLayout();
    this.hasReceivedData = true;
    // 仮ノードから本体のグラフへ段階的に更新される場合もあるため、
    // AI更新のたびに配置と表示範囲を同期して、追加ノードが画面外へ出ないようにする。
    if (this.nodes.size) this.fitView();
    else this._render();
    this._hasFittedInitialData = this.nodes.size > 0;
  }

  _applyOperation(operation) {
    const op = asText(operation?.op);
    const id = asText(operation?.id);
    if (!id) return;

    if (op === 'upsert_node') {
      const previous = this.nodes.get(id) || {
        id,
        type: 'default',
        position: this._nextNodePosition(),
        data: {},
      };
      const node = operation.node && typeof operation.node === 'object' ? operation.node : {};
      const position = node.position && typeof node.position === 'object'
        ? {
            x: asNumber(node.position.x, previous.position.x),
            y: asNumber(node.position.y, previous.position.y),
          }
        : previous.position;
      const data = node.data && typeof node.data === 'object'
        ? { ...previous.data, ...node.data }
        : previous.data;
      this.nodes.set(id, {
        ...previous,
        ...node,
        id,
        position,
        data,
      });
      return;
    }

    if (op === 'upsert_edge') {
      const previous = this.edges.get(id) || { id };
      // GeminiがReact Flowのedgeをネストせず、source/targetを操作直下に
      // 返す場合もあるため、両方の形式を受け付ける。
      const edge = operation.edge && typeof operation.edge === 'object'
        ? { ...operation, ...operation.edge }
        : operation;
      this.edges.set(id, { ...previous, ...edge, id });
      return;
    }

    if (op === 'remove_node') {
      this.nodes.delete(id);
      for (const [edgeId, edge] of this.edges) {
        if (edge.source === id || edge.target === id) this.edges.delete(edgeId);
      }
      return;
    }

    if (op === 'remove_edge') this.edges.delete(id);
  }

  _nextNodePosition() {
    const index = this.nodes.size;
    return { x: 60 + (index % 3) * 240, y: 60 + Math.floor(index / 3) * 150 };
  }

  _findCycleBackEdges(nodes, edges) {
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      if (!outgoing.has(edge.source) || !outgoing.has(edge.target)) continue;
      outgoing.get(edge.source).push(edge);
      indegree.set(edge.target, indegree.get(edge.target) + 1);
    }

    const visited = new Set();
    const active = new Set();
    const backEdges = new Set();
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      active.add(id);
      for (const edge of outgoing.get(id) || []) {
        if (!visited.has(edge.target)) {
          visit(edge.target);
        } else if (active.has(edge.target)) {
          // DFS中の祖先へ戻るエッジを、循環の「戻り道」として扱う。
          backEdges.add(edge.id);
        }
      }
      active.delete(id);
    };

    const orderedNodes = [...nodes].sort((a, b) => (
      asNumber(a.position?.x) - asNumber(b.position?.x)
      || asNumber(a.position?.y) - asNumber(b.position?.y)
      || a.id.localeCompare(b.id)
    ));
    for (const node of orderedNodes) {
      if (indegree.get(node.id) === 0) visit(node.id);
    }
    // 純粋な循環グラフには根がないため、未訪問の成分も調べる。
    for (const node of orderedNodes) visit(node.id);
    return backEdges;
  }

  _getNodeBounds() {
    if (!this.nodes.size) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }
    const positions = [...this.nodes.values()].map((node) => node.position);
    return {
      minX: Math.min(...positions.map((position) => asNumber(position?.x))),
      maxX: Math.max(...positions.map((position) => asNumber(position?.x) + NODE_WIDTH)),
      minY: Math.min(...positions.map((position) => asNumber(position?.y))),
      maxY: Math.max(...positions.map((position) => asNumber(position?.y) + NODE_HEIGHT)),
    };
  }

  /**
   * エッジから簡易的な階層を計算し、ノード同士が重ならないように再配置する。
   * React Flow側へ渡すデータのpositionは、モデルよりも画面側の配置を優先する。
   */
  autoLayout() {
    if (!this.nodes.size) return;

    const nodes = [...this.nodes.values()];
    const validEdges = [...this.edges.values()].filter((edge) => (
      this.nodes.has(edge.source) && this.nodes.has(edge.target)
    ));
    const modelX = nodes.map((node) => asNumber(node.position?.x));
    const modelY = nodes.map((node) => asNumber(node.position?.y));
    const modelSpanX = Math.max(...modelX) - Math.min(...modelX);
    const modelSpanY = Math.max(...modelY) - Math.min(...modelY);
    // Geminiが返した配置の向きをヒントにする。因果関係の横並びは横方向、
    // 開始・作業・終了の縦並びは縦方向に保ち、循環だけを特別扱いする。
    this.layoutDirection = modelSpanX >= modelSpanY ? 'horizontal' : 'vertical';
    this.layoutBackEdges = this._findCycleBackEdges(nodes, validEdges);

    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of validEdges) {
      // 戻り道を階層計算から外すことで、循環の主経路を一直線にする。
      if (this.layoutBackEdges.has(edge.id)) continue;
      outgoing.get(edge.source).push(edge.target);
      indegree.set(edge.target, indegree.get(edge.target) + 1);
    }

    const levels = new Map();
    const queue = [];
    for (const node of nodes) {
      if (indegree.get(node.id) === 0) {
        levels.set(node.id, 0);
        queue.push(node.id);
      }
    }

    // Kahn法に近い形で、根からの最長距離を各ノードの階層にする。
    for (let index = 0; index < queue.length; index += 1) {
      const currentId = queue[index];
      const currentLevel = levels.get(currentId) || 0;
      for (const nextId of outgoing.get(currentId) || []) {
        levels.set(nextId, Math.max(levels.get(nextId) ?? 0, currentLevel + 1));
        indegree.set(nextId, indegree.get(nextId) - 1);
        if (indegree.get(nextId) === 0) queue.push(nextId);
      }
    }

    // 何らかの理由で階層を決められないノードは先頭階層へ置く。
    for (const node of nodes) {
      if (!levels.has(node.id)) levels.set(node.id, 0);
    }

    const layers = new Map();
    for (const node of nodes) {
      const level = levels.get(node.id);
      if (!layers.has(level)) layers.set(level, []);
      layers.get(level).push(node);
    }

    const horizontalGap = 42;
    const verticalGap = 52;
    for (const [level, layer] of layers) {
      layer.sort((a, b) => (
        asNumber(a.position?.x) - asNumber(b.position?.x)
        || a.id.localeCompare(b.id)
      ));
      if (this.layoutDirection === 'horizontal') {
        const layerHeight = layer.length * NODE_HEIGHT + Math.max(0, layer.length - 1) * verticalGap;
        const startY = -layerHeight / 2;
        layer.forEach((node, index) => {
          node.position = {
            x: 60 + level * (NODE_WIDTH + horizontalGap),
            y: startY + index * (NODE_HEIGHT + verticalGap),
          };
        });
      } else {
        const layerWidth = layer.length * NODE_WIDTH + Math.max(0, layer.length - 1) * horizontalGap;
        const startX = -layerWidth / 2;
        layer.forEach((node, index) => {
          node.position = {
            x: startX + index * (NODE_WIDTH + horizontalGap),
            y: 60 + level * (NODE_HEIGHT + verticalGap),
          };
        });
      }
    }
  }

  fitView() {
    if (!this.svg || !this.nodes.size) {
      this.viewport = { x: 0, y: 0, scale: 1 };
      this._render();
      return;
    }

    const rect = this.svg.getBoundingClientRect();
    const width = rect.width || this.svg.clientWidth || 720;
    const height = rect.height || this.svg.clientHeight || 420;
    const bounds = this._getNodeBounds();
    const minX = bounds.minX;
    const maxX = bounds.maxX + (this.layoutDirection === 'vertical' && this.layoutBackEdges.size ? 72 : 0);
    const minY = bounds.minY;
    const maxY = bounds.maxY + (this.layoutDirection === 'horizontal' && this.layoutBackEdges.size ? 72 : 0);
    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const padding = 54;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, Math.min((width - padding * 2) / graphWidth, (height - padding * 2) / graphHeight)),
    );
    this.viewport.scale = scale;
    this.viewport.x = (width - graphWidth * scale) / 2 - minX * scale;
    this.viewport.y = (height - graphHeight * scale) / 2 - minY * scale;
    this._render();
  }

  _startNodeDrag(event, id) {
    if (event.button !== 0) return;
    const node = this.nodes.get(id);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag = {
      type: 'node',
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originNodeX: node.position.x,
      originNodeY: node.position.y,
    };
    this.svg.setPointerCapture(event.pointerId);
  }

  _render() {
    if (!this.svg) return;
    this.viewportLayer.setAttribute(
      'transform',
      `translate(${this.viewport.x} ${this.viewport.y}) scale(${this.viewport.scale})`,
    );
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    const graphBounds = this._getNodeBounds();

    for (const edge of this.edges.values()) {
      const source = this.nodes.get(edge.source);
      const target = this.nodes.get(edge.target);
      if (!source || !target) continue;

      const sourceCenterX = source.position.x + NODE_WIDTH / 2;
      const sourceCenterY = source.position.y + NODE_HEIGHT / 2;
      const targetCenterX = target.position.x + NODE_WIDTH / 2;
      const targetCenterY = target.position.y + NODE_HEIGHT / 2;
      const horizontal = Math.abs(targetCenterX - sourceCenterX) >= Math.abs(targetCenterY - sourceCenterY);
      const forward = horizontal
        ? targetCenterX >= sourceCenterX
        : targetCenterY >= sourceCenterY;
      let x1 = horizontal
        ? (forward ? source.position.x + NODE_WIDTH : source.position.x)
        : sourceCenterX;
      let y1 = horizontal
        ? sourceCenterY
        : (forward ? source.position.y + NODE_HEIGHT : source.position.y);
      let x2 = horizontal
        ? (forward ? target.position.x : target.position.x + NODE_WIDTH)
        : targetCenterX;
      let y2 = horizontal
        ? targetCenterY
        : (forward ? target.position.y : target.position.y + NODE_HEIGHT);
      const isBackEdge = this.layoutBackEdges.has(edge.id);
      let control1;
      let control2;
      let labelX = (x1 + x2) / 2;
      let labelY = (y1 + y2) / 2 - 6;

      if (isBackEdge && this.layoutDirection === 'horizontal') {
        const returnsLeft = sourceCenterX >= targetCenterX;
        const routeY = graphBounds.maxY + 72;
        x1 = returnsLeft ? source.position.x : source.position.x + NODE_WIDTH;
        y1 = sourceCenterY;
        x2 = returnsLeft ? target.position.x + NODE_WIDTH : target.position.x;
        y2 = targetCenterY;
        control1 = `${x1} ${routeY}`;
        control2 = `${x2} ${routeY}`;
        labelX = (x1 + x2) / 2;
        labelY = routeY - 8;
      } else if (isBackEdge) {
        const returnsUp = sourceCenterY >= targetCenterY;
        const routeX = graphBounds.maxX + 72;
        x1 = sourceCenterX;
        y1 = returnsUp ? source.position.y : source.position.y + NODE_HEIGHT;
        x2 = targetCenterX;
        y2 = returnsUp ? target.position.y + NODE_HEIGHT : target.position.y;
        control1 = `${routeX} ${y1}`;
        control2 = `${routeX} ${y2}`;
        labelX = routeX + 8;
        labelY = (y1 + y2) / 2;
      } else {
        const bend = horizontal ? Math.max(28, Math.abs(x2 - x1) * 0.35) : Math.max(28, Math.abs(y2 - y1) * 0.35);
        control1 = horizontal ? `${x1 + (forward ? bend : -bend)} ${y1}` : `${x1} ${y1 + (forward ? bend : -bend)}`;
        control2 = horizontal ? `${x2 - (forward ? bend : -bend)} ${y2}` : `${x2} ${y2 - (forward ? bend : -bend)}`;
      }
      const line = svgElement('path', {
        class: `live-flow-edge${isBackEdge ? ' is-back-edge' : ''}${this.selection?.type === 'edge' && this.selection.id === edge.id ? ' is-selected' : ''}`,
        d: `M ${x1} ${y1} C ${control1}, ${control2}, ${x2} ${y2}`,
        fill: 'none',
        'marker-end': `url(#${isBackEdge ? 'live-flow-back-arrow' : 'live-flow-arrow'})`,
      });
      line.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || this.connectMode) return;
        event.preventDefault();
        event.stopPropagation();
        this.svg.focus({ preventScroll: true });
        this._setSelection('edge', edge.id);
      });
      this.edgeLayer.appendChild(line);

      const label = edge.label || edge.data?.label;
      if (label) {
        const text = svgElement('text', {
          class: `live-flow-edge-label${isBackEdge ? ' is-back-edge' : ''}`,
          x: labelX,
          y: labelY,
          'text-anchor': 'middle',
        });
        text.textContent = asText(label);
        text.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || this.connectMode) return;
          event.preventDefault();
          event.stopPropagation();
          this.svg.focus({ preventScroll: true });
          this._setSelection('edge', edge.id);
        });
        this.edgeLayer.appendChild(text);
      }
    }

    for (const node of this.nodes.values()) {
      const data = node.data || {};
      const kind = asText(data.kind || node.type, 'default');
      const group = svgElement('g', {
        class: `live-flow-node${this.selection?.type === 'node' && this.selection.id === node.id ? ' is-selected' : ''}`,
        'data-kind': kind,
        'data-node-id': node.id,
        transform: `translate(${node.position.x} ${node.position.y})`,
        role: 'button',
        tabindex: 0,
        'aria-label': asText(data.label || node.id),
      });
      group.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        group.focus({ preventScroll: true });
        if (this.connectMode) {
          this._handleConnectNode(node.id);
          return;
        }
        this._setSelection('node', node.id);
        this._startNodeDrag(event, node.id);
      });
      group.addEventListener('click', (event) => event.stopPropagation());

      group.appendChild(svgElement('rect', {
        class: 'live-flow-node-body',
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        rx: 12,
      }));
      group.appendChild(svgElement('rect', {
        class: 'live-flow-node-accent',
        width: 5,
        height: NODE_HEIGHT,
        rx: 3,
      }));

      this._addWrappedText(group, data.label || node.id, 16, 28, 15, 21, 18);
      this._addWrappedText(group, data.description || kind, 16, 54, 11, 15, 23);
      this._addWrappedText(group, data.status || '', 16, 74, 10, 14, 18);
      this.nodeLayer.appendChild(group);
    }

    if (this.emptyElement) this.emptyElement.hidden = this.nodes.size > 0;
    this.onChange?.();
  }

  _addWrappedText(parent, value, x, y, fontSize, lineHeight, maxCharacters) {
    const text = svgElement('text', {
      class: 'live-flow-node-text',
      x,
      y,
      'font-size': fontSize,
    });
    const source = asText(value);
    const lines = [];
    for (let index = 0; index < source.length; index += maxCharacters) {
      lines.push(source.slice(index, index + maxCharacters));
    }
    if (!lines.length) lines.push('');
    lines.slice(0, 2).forEach((line, index) => {
      const tspan = svgElement('tspan', { x, dy: index === 0 ? 0 : lineHeight });
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    parent.appendChild(text);
  }
}
