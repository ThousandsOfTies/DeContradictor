import { AudioPlayer } from './audio-player.js';
import { LIVE_EMOTIONS } from './live-emotions.js';

// Gemini Live の確認用に限定した最小クライアント。
// 会話・図・感情はLive画面側で管理する。
const LIVE_MODEL = 'gemini-3.8-live';
const LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const PROCESSOR_BUFFER_SIZE = 2048;
const MAX_LOG_ITEMS = 300;
const LIVE_VOICE_STORAGE_KEY = 'decontradictor.live.voice';
const LIVE_SEARCH_ENABLED = true;

// Live APIから音声と一緒に受け取りたい機械可読データ。
// React Flow本体への反映は画面側に任せ、ここでは差分データを受け渡す。
const LIVE_FUNCTION_DECLARATIONS = [
  {
    name: 'change_emotion',
    description: 'アバターの現在の感情をUIへ通知する。音声の表現に合わせて1ターンに1回呼び出す。',
    parameters: {
      type: 'object',
      properties: {
        emotion: {
          type: 'string',
          enum: LIVE_EMOTIONS,
          description: '現在の感情。thinking=考え中、confused=困惑、empathetic=共感。会話に合う表情を選ぶ。',
        },
      },
      required: ['emotion'],
    },
  },
  {
    name: 'update_react_flow',
    description: '会話の主張・質問・結論・矛盾・関係が変化したときだけ、React Flowへ渡す差分を通知する。通常の雑談では呼び出さない。',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'React Flowのノードまたはエッジに対する小さな差分操作。',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['upsert_node', 'upsert_edge', 'remove_node', 'remove_edge'],
              },
              id: {
                type: 'string',
                description: '更新対象のReact FlowノードまたはエッジのID。',
              },
              source: {
                type: 'string',
                description: 'upsert_edgeの場合の接続元ノードID。',
              },
              target: {
                type: 'string',
                description: 'upsert_edgeの場合の接続先ノードID。',
              },
              label: {
                type: 'string',
                description: 'upsert_edgeの場合の表示ラベル。',
              },
              type: {
                type: 'string',
                description: 'upsert_edgeの場合のReact Flowエッジタイプ。',
              },
              node: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  position: {
                    type: 'object',
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' },
                    },
                  },
                  data: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                      kind: { type: 'string' },
                      status: { type: 'string' },
                    },
                  },
                },
              },
              edge: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  target: { type: 'string' },
                  type: { type: 'string' },
                  label: { type: 'string' },
                },
              },
            },
            required: ['op', 'id'],
          },
        },
      },
      required: ['operations'],
    },
  },
];

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function float32ToPcm16Base64(samples, sourceRate, targetRate) {
  const source = sourceRate === targetRate
    ? samples
    : (() => {
        const ratio = sourceRate / targetRate;
        const length = Math.max(1, Math.round(samples.length / ratio));
        const resampled = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const position = i * ratio;
          const left = Math.floor(position);
          const right = Math.min(left + 1, samples.length - 1);
          const fraction = position - left;
          resampled[i] = samples[left] + (samples[right] - samples[left]) * fraction;
        }
        return resampled;
      })();

  const bytes = new Uint8Array(source.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < source.length; i++) {
    const value = Math.max(-1, Math.min(1, source[i]));
    view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

export class GeminiLiveProbe {
  constructor({
    llm,
    onEmotionDetected = null,
    onReactFlowUpdate = null,
  }) {
    this.llm = llm;
    this.onEmotionDetected = onEmotionDetected;
    this.onReactFlowUpdate = onReactFlowUpdate;
    this.socket = null;
    this.mediaStream = null;
    this.inputContext = null;
    this.inputSource = null;
    this.inputProcessor = null;
    this.inputMute = null;
    this.setupComplete = false;
    this.userStopped = false;
    this.audioChunks = 0;
    this.followLogs = true;
    this.audioPlayer = new AudioPlayer(OUTPUT_SAMPLE_RATE);

    this.els = {};
  }

  init() {
    this.els = {
      panel: document.getElementById('live-test-panel'),
      apiKeyInput: document.getElementById('live-api-key'),
      voiceSelect: document.getElementById('live-voice-select'),
      directionInput: document.getElementById('live-direction-input'),
      textInput: document.getElementById('live-text-input'),
      textSendBtn: document.getElementById('live-text-send-btn'),
      startBtn: document.getElementById('live-test-start-btn'),
      textOnlyStartBtn: document.getElementById('live-test-text-only-btn'),
      stopBtn: document.getElementById('live-test-stop-btn'),
      clearBtn: document.getElementById('live-test-clear-btn'),
      status: document.getElementById('live-test-status'),
      logs: document.getElementById('live-test-log-list'),
      latestLogBtn: document.getElementById('live-test-log-latest-btn'),
    };

    const required = ['panel', 'startBtn', 'stopBtn', 'clearBtn', 'status', 'logs'];
    if (required.some((key) => !this.els[key])) return;

    this.els.startBtn.addEventListener('click', () => this.start());
    if (this.els.textOnlyStartBtn) {
      this.els.textOnlyStartBtn.addEventListener('click', () => this.start({ textOnly: true }));
    }
    this.els.stopBtn.addEventListener('click', () => this.stop());
    this.els.clearBtn.addEventListener('click', () => this._clearLogs());
    if (this.els.textSendBtn) this.els.textSendBtn.addEventListener('click', () => this._sendTextInput());
    if (this.els.textInput) {
      this.els.textInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this._sendTextInput();
        }
      });
    }
    if (this.els.logs) {
      this.els.logs.addEventListener('scroll', () => this._updateLogFollowState());
    }
    if (this.els.latestLogBtn) {
      this.els.latestLogBtn.addEventListener('click', () => {
        this.followLogs = true;
        this._scrollLogsToEnd();
      });
    }

    if (this.els.apiKeyInput) {
      this.els.apiKeyInput.value = this.llm.apiKey || '';
    }
    if (this.els.voiceSelect) {
      try {
        const savedVoice = localStorage.getItem(LIVE_VOICE_STORAGE_KEY);
        if ([...this.els.voiceSelect.options].some((option) => option.value === savedVoice)) {
          this.els.voiceSelect.value = savedVoice;
        }
      } catch (_) {}
      this.els.voiceSelect.addEventListener('change', () => {
        try { localStorage.setItem(LIVE_VOICE_STORAGE_KEY, this.els.voiceSelect.value); } catch (_) {}
      });
    }

    this._setState('停止中');
    this._appendLog('info', `モデル: ${LIVE_MODEL}`);
    this._appendLog('info', `音声: ${this._getVoiceLabel()}`);
    this._appendLog('info', 'Google検索: ON（必要なときだけ自動使用）');
    this._appendLog('info', '応答データ: 感情 + React Flow（Function Calling）');
  }

  async start({ textOnly = false } = {}) {
    if (this.socket) return;

    const apiKey = (this.els.apiKeyInput ? this.els.apiKeyInput.value : (this.llm.apiKey || '')).trim();
    if (!apiKey) {
      this._setState('APIキー未設定');
      this._appendLog('error', 'この画面のAPIキー欄にGoogle AI Studioのキーを入力してください。');
      return;
    }
    // この画面で入力されたキーを、接続に反映する。
    // キーの記憶は画面側で管理する。このクライアントからDriveへ保存しない。
    this.llm.apiKey = apiKey;
    if (!textOnly && !navigator.mediaDevices?.getUserMedia) {
      this._setState('マイク非対応');
      this._appendLog('error', 'このブラウザではマイク入力を利用できません。');
      return;
    }

    this.userStopped = false;
    this.setupComplete = false;
    this.audioChunks = 0;
    const voiceName = this._getVoiceName();
    const direction = this._getDirection();
    this._dispatchLiveEvent('gemini-live-turn-end', {});
    this._appendLog('info', `モデル: ${LIVE_MODEL}`);
    this._appendLog('info', `音声: ${this._getVoiceLabel()} (${voiceName})`);
    this._appendLog('info', 'Google検索: ON（必要なときだけ自動使用）');
    this._appendLog('info', '応答データ: 感情 + React Flow（Function Calling）');
    this._appendLog('info', textOnly ? '接続方式: テキスト専用（マイクなし）' : '接続方式: 音声＋テキスト');
    this._appendLog('info', direction ? `会話ディレクション: ${direction}` : '会話ディレクション: なし');
    this._setState('マイクを準備中...');

    try {
      await this.audioPlayer.init();
      if (textOnly) {
        this._setState('テキスト接続を準備中...');
      } else {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        await this._startInputPipeline();
      }

      const url = `${LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
      const socket = new WebSocket(url);
      this.socket = socket;
      this._setState('接続中...');
      this._appendLog('info', 'Gemini Liveへ接続しています。ヘッドホン推奨です。');

      socket.onopen = () => {
        this._appendLog('info', 'WebSocket接続完了。設定を送信しました。');
        socket.send(JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
            },
            systemInstruction: {
              parts: [{
                text: this._buildSystemInstruction(direction),
              }],
            },
            tools: [
              ...(LIVE_SEARCH_ENABLED ? [{ googleSearch: {} }] : []),
              { functionDeclarations: LIVE_FUNCTION_DECLARATIONS },
            ],
            inputAudioTranscription: { languageCodes: ['ja'] },
            outputAudioTranscription: { languageCodes: ['ja'] },
          },
        }));
      };

      socket.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      socket.onerror = () => {
        this._setState('接続エラー');
        this._appendLog('error', 'WebSocket接続でエラーが発生しました。');
      };

      socket.onclose = (event) => {
        if (this.socket === socket) this.socket = null;
        this.setupComplete = false;
        this._cleanupInput();
        this._setState('停止中');
        if (!this.userStopped) {
          this._appendLog('error', `接続終了 (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
        }
        this.userStopped = false;
      };
    } catch (err) {
      await this.stop({ silent: true });
      this._setState('開始失敗');
      this._appendLog('error', err.message || String(err));
    }
  }

  async stop({ silent = false } = {}) {
    this._dispatchLiveEvent('gemini-live-turn-end', {});
    this.userStopped = true;
    this.setupComplete = false;
    this.audioPlayer.stopAll();
    this._cleanupInput();

    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try { socket.close(1000, 'user stopped'); } catch (_) {}
    }

    this._setState('停止中');
    if (!silent) this._appendLog('info', 'Liveセッションを停止しました。');
  }

  async _startInputPipeline() {
    this.inputContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    await this.inputContext.resume();
    this.inputSource = this.inputContext.createMediaStreamSource(this.mediaStream);
    this.inputProcessor = this.inputContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    this.inputMute = this.inputContext.createGain();
    this.inputMute.gain.value = 0;

    this.inputProcessor.onaudioprocess = (event) => {
      if (!this.setupComplete || this.socket?.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      const data = float32ToPcm16Base64(
        samples,
        this.inputContext.sampleRate,
        INPUT_SAMPLE_RATE,
      );
      this.socket.send(JSON.stringify({
        realtimeInput: {
          audio: { data, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
        },
      }));
    };

    this.inputSource.connect(this.inputProcessor);
    this.inputProcessor.connect(this.inputMute);
    this.inputMute.connect(this.inputContext.destination);
    this._appendLog('info', `マイク入力準備完了 (${this.inputContext.sampleRate}Hz → ${INPUT_SAMPLE_RATE}Hz)`);
  }

  _cleanupInput() {
    try { this.inputProcessor?.disconnect(); } catch (_) {}
    try { this.inputSource?.disconnect(); } catch (_) {}
    try { this.inputMute?.disconnect(); } catch (_) {}
    this.inputProcessor = null;
    this.inputSource = null;
    this.inputMute = null;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    if (this.inputContext) {
      this.inputContext.close().catch(() => {});
      this.inputContext = null;
    }
  }

  async _handleMessage(raw) {
    try {
      const text = typeof raw === 'string' ? raw : await raw.text();
      const message = JSON.parse(text);

      if (message.setupComplete) {
        this.setupComplete = true;
        this._setState('聞いています');
        this._appendLog('info', 'Liveセッション準備完了。話しかけてください。');
        return;
      }

      if (message.error) {
        this._setState('APIエラー');
        this._appendLog('error', JSON.stringify(message.error));
        return;
      }

      if (message.toolCall) {
        this._handleToolCall(message.toolCall);
      }

      const content = message.serverContent;
      if (content?.interimInputTranscription?.text) {
        this._setState('認識中...');
      }
      if (content?.inputTranscription?.text) {
        this._appendLog('user', `入力: ${content.inputTranscription.text}`);
      }
      if (content?.outputTranscription?.text) {
        this._appendLog('model', `Gemini: ${content.outputTranscription.text}`);
      }
      if (content?.groundingMetadata) {
        const count = content.groundingMetadata.groundingChunks?.length;
        this._appendLog('info', `Google検索を使用しました${count ? `（参照 ${count}件）` : ''}。`);
      }

      const parts = content?.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.audioPlayer.playChunk(part.inlineData.data, false);
          this.audioChunks++;
        }
        if (part.text) this._appendLog('model', `テキスト: ${part.text}`);
      }

      if (content?.interrupted) {
        this._dispatchLiveEvent('gemini-live-turn-end', {});
        this.audioPlayer.stopAll();
        this._appendLog('info', '音声応答が割り込まれて停止しました。');
      }
      if (content?.turnComplete) {
        this._dispatchLiveEvent('gemini-live-turn-end', {});
        this._setState('聞いています');
        this._appendLog('info', `ターン完了（音声チャンク ${this.audioChunks}個）`);
        this.audioChunks = 0;
      }
      if (message.usageMetadata?.totalTokenCount) {
        this._appendLog('info', `使用トークン: ${message.usageMetadata.totalTokenCount}`);
      }
      if (message.goAway?.timeLeft) {
        this._appendLog('info', `サーバーからまもなく切断されます: ${message.goAway.timeLeft}`);
      }
    } catch (err) {
      this._appendLog('error', `受信データの処理に失敗: ${err.message || err}`);
    }
  }

  _setState(text) {
    if (this.els.status) this.els.status.textContent = text;
    if (this.els.startBtn) this.els.startBtn.disabled = !!this.socket;
    if (this.els.textOnlyStartBtn) this.els.textOnlyStartBtn.disabled = !!this.socket;
    if (this.els.stopBtn) this.els.stopBtn.disabled = !this.socket && !this.mediaStream;
    if (this.els.voiceSelect) this.els.voiceSelect.disabled = !!this.socket || !!this.mediaStream;
    if (this.els.directionInput) this.els.directionInput.disabled = !!this.socket || !!this.mediaStream;
    if (this.els.textInput) this.els.textInput.disabled = !this.setupComplete;
    if (this.els.textSendBtn) this.els.textSendBtn.disabled = !this.setupComplete;
  }

  _getVoiceName() {
    return this.els.voiceSelect?.value || 'Puck';
  }

  _getVoiceLabel() {
    return this.els.voiceSelect?.selectedOptions?.[0]?.textContent?.trim() || this._getVoiceName();
  }

  _getDirection() {
    return (this.els.directionInput?.value || '').trim();
  }

  _buildSystemInstruction(direction) {
    const base = '日本語で、短く自然な会話をしてください。これは音声応答の動作確認です。最新情報・現在の情報・事実確認が必要な質問にはGoogle検索を使ってから答えてください。雑談や一般的な会話では検索しなくて構いません。各ターンの応答開始時に、音声表現に合う現在の感情をchange_emotionで1回通知してください。会話の主張・質問・結論・矛盾・関係に追加や変更があるときだけ、React Flowへ渡す小さな差分をupdate_react_flowで通知してください。これらのツール呼び出しはUIへ渡す機械可読データなので、ツール名やJSONを音声で読み上げないでください。';
    return direction ? `${base}\n\n追加の会話ディレクション:\n${direction}` : base;
  }

  _handleToolCall(toolCall) {
    const functionCalls = Array.isArray(toolCall?.functionCalls)
      ? toolCall.functionCalls
      : [];
    if (!functionCalls.length) return;

    const functionResponses = [];
    for (const functionCall of functionCalls) {
      const name = functionCall?.name || 'unknown';
      const args = this._coerceFunctionArgs(functionCall?.args);
      this._appendLog('tool', `Function Calling: ${name} ${this._stringifyForLog(args)}`);

      let result;
      if (name === 'change_emotion') {
        result = this._handleEmotionData(args);
      } else if (name === 'update_react_flow') {
        result = this._handleReactFlowData(args);
      } else {
        result = { status: 'error', error: `未対応のFunction Calling: ${name}` };
        this._appendLog('error', result.error);
      }

      functionResponses.push({
        name,
        id: functionCall?.id || `${name}-${Date.now()}`,
        response: { result },
      });
    }

    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
      this._appendLog('info', `Function Callingへ応答しました（${functionResponses.length}件）。`);
    }
  }

  _handleEmotionData(args) {
    const requestedEmotion = String(args?.emotion || 'neutral').toLowerCase();
    const emotion = LIVE_EMOTIONS.includes(requestedEmotion) ? requestedEmotion : 'neutral';
    const payload = { emotion };
    this.onEmotionDetected?.(emotion, payload);
    this.llm?.onEmotionDetected?.(emotion);
    this._dispatchLiveEvent('gemini-live-emotion', payload);
    this._appendLog('emotion', `感情データ: ${emotion}`);
    return { status: 'ok', emotion };
  }

  _handleReactFlowData(args) {
    const operations = Array.isArray(args?.operations) ? args.operations : [];
    const payload = { operations };
    this.onReactFlowUpdate?.(payload);
    this._dispatchLiveEvent('gemini-live-react-flow-update', payload);
    this._appendLog('flow', `React Flow更新データ: ${this._stringifyForLog(payload)}`);
    return { status: 'ok', accepted: true, operationCount: operations.length };
  }

  _coerceFunctionArgs(args) {
    if (args && typeof args === 'object') return args;
    if (typeof args === 'string') {
      try { return JSON.parse(args); } catch (_) {}
    }
    return {};
  }

  _stringifyForLog(value) {
    let serialized = '';
    try { serialized = JSON.stringify(value) ?? String(value); } catch (_) { serialized = String(value); }
    return serialized.length > 1600 ? `${serialized.slice(0, 1600)}…` : serialized;
  }

  _dispatchLiveEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) {}
  }

  _sendTextInput() {
    if (!this.setupComplete || this.socket?.readyState !== WebSocket.OPEN) return;
    const text = (this.els.textInput?.value || '').trim();
    if (!text) return;
    this.socket.send(JSON.stringify({ realtimeInput: { text } }));
    this._appendLog('user', `テキスト指示: ${text}`);
    this._setState('テキストに応答中...');
    if (this.els.textInput) this.els.textInput.value = '';
  }

  _clearLogs() {
    if (!this.els.logs) return;
    this.els.logs.replaceChildren();
    this._dispatchLiveEvent('gemini-live-clear', {});
    this.followLogs = true;
    this._updateLogFollowState();
  }

  _appendLog(kind, text) {
    if (!this.els.logs) return;
    const shouldFollow = this.followLogs;
    const item = document.createElement('li');
    const time = new Date().toLocaleTimeString('ja-JP', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    item.className = `live-log-${kind}`;
    item.textContent = `${time}  ${text}`;
    item.dataset.kind = kind;
    this.els.logs.appendChild(item);
    while (this.els.logs.children.length > MAX_LOG_ITEMS) {
      this.els.logs.firstElementChild.remove();
    }
    if (shouldFollow) this._scrollLogsToEnd();
    else this._updateLogFollowState();
    this._dispatchLiveEvent('gemini-live-log', { kind, text, time: new Date().toISOString() });
  }

  _isLogAtBottom() {
    if (!this.els.logs) return true;
    const distanceFromBottom = this.els.logs.scrollHeight - this.els.logs.scrollTop - this.els.logs.clientHeight;
    return distanceFromBottom <= 24;
  }

  _updateLogFollowState() {
    if (!this.els.logs) return;
    this.followLogs = this._isLogAtBottom();
    if (this.els.latestLogBtn) this.els.latestLogBtn.hidden = this.followLogs;
  }

  _scrollLogsToEnd() {
    if (!this.els.logs) return;
    this.els.logs.scrollTop = this.els.logs.scrollHeight;
    this.followLogs = true;
    if (this.els.latestLogBtn) this.els.latestLogBtn.hidden = true;
  }
}

export function initGeminiLive({
  llm,
  onEmotionDetected = null,
  onReactFlowUpdate = null,
}) {
  const probe = new GeminiLiveProbe({
    llm,
    onEmotionDetected,
    onReactFlowUpdate,
  });
  probe.init();
  return probe;
}
