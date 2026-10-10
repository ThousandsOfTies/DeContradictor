export class AudioPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.audioCtx = null;
    this.audioQueue = [];
    this.activeSources = []; // Track active playing source nodes
    this.isPlaying = false;
    this.nextPlayTime = 0;

    // Callbacks
    this.onPlaybackStart = null;
    this.onPlaybackEnd = null;
  }

  // Must be called from a user interaction event (e.g. click)
  async init() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    // Play a tiny silent buffer to keep the AudioContext unlocked and active
    try {
      const buffer = this.audioCtx.createBuffer(1, 1, this.sampleRate);
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);
      source.start(0);
    } catch(e) {}
  }

  // Decode base64 PCM16 into an AudioBuffer
  _decodePcm16(base64Data, isBigEndian = false) {
    try {
      // Normalize URL-safe base64 strings to standard base64
      const normalized = base64Data.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Ensure the byte buffer length is even to avoid RangeError in Int16Array
      const safeLength = bytes.length - (bytes.length % 2);
      if (safeLength === 0) {
        return this.audioCtx.createBuffer(1, 1, this.sampleRate); // return empty 1-sample buffer
      }

      const numSamples = safeLength / 2;
      const float32 = new Float32Array(numSamples);

      if (isBigEndian) {
        for (let i = 0; i < numSamples; i++) {
          const byteIdx = i * 2;
          let val = (bytes[byteIdx] << 8) | bytes[byteIdx + 1];
          if (val & 0x8000) {
            val = val - 0x10000; // convert to signed 16-bit
          }
          float32[i] = val / 32768.0; // convert to -1.0 to 1.0
        }
      } else {
        const int16 = new Int16Array(bytes.buffer, 0, numSamples);
        for (let i = 0; i < numSamples; i++) {
          float32[i] = int16[i] / 32768.0; // convert to -1.0 to 1.0
        }
      }

      const buffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate);
      buffer.getChannelData(0).set(float32);
      return buffer;
    } catch (e) {
      console.warn("PCM16 decoding failed:", e);
      return this.audioCtx.createBuffer(1, 1, this.sampleRate); // fallback to empty
    }
  }

  playChunk(base64Data, isBigEndian = false) {
    if (!this.audioCtx) {
      console.warn("AudioPlayer: playChunk ignored because audioCtx is null");
      return;
    }

    // Auto-resume if needed (though init() should have handled it)
    if (this.audioCtx.state === 'suspended') {
      console.log("AudioPlayer: audioCtx is suspended, attempting auto-resume...");
      this.audioCtx.resume().catch((e) => console.error("AudioPlayer auto-resume failed:", e));
    }

    const buffer = this._decodePcm16(base64Data, isBigEndian);
    if (buffer.duration === 0) return;

    this.audioQueue.push(buffer);
    this._scheduleNext();
  }

  // Cloud TTS REST が返す MP3 など、エンコード済み音声を再生キューに追加する。
  async playEncodedAudio(base64Data) {
    if (!this.audioCtx) {
      console.warn('AudioPlayer: playEncodedAudio ignored because audioCtx is null');
      return;
    }

    try {
      const normalized = base64Data.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // decodeAudioData は引数を消費する実装があるためコピーを渡す。
      const buffer = await this.audioCtx.decodeAudioData(bytes.buffer.slice(0));
      this.audioQueue.push(buffer);
      this._scheduleNext();
    } catch (e) {
      console.warn('Encoded audio decoding failed:', e);
      throw new Error('Cloud TTS 音声を再生できませんでした。');
    }
  }

  _scheduleNext() {
    if (this.audioQueue.length === 0) return;

    console.log(`AudioPlayer: Scheduling next chunk. Queue length: ${this.audioQueue.length}, currentTime: ${this.audioCtx.currentTime}, nextPlayTime: ${this.nextPlayTime}`);

    // Reset playback time if we fell behind or just started
    if (this.nextPlayTime < this.audioCtx.currentTime) {
      console.log(`AudioPlayer: nextPlayTime (${this.nextPlayTime}) fell behind currentTime (${this.audioCtx.currentTime}). Resetting to currentTime + 0.05.`);
      this.nextPlayTime = this.audioCtx.currentTime + 0.05;
    }

    // Dequeue next buffer
    const buffer = this.audioQueue.shift();
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

    // Track active sources so we can stop them on stopAll()
    this.activeSources.push(source);

    // Track state
    if (!this.isPlaying) {
      console.log("AudioPlayer: Transitioning to isPlaying = true. Triggering onPlaybackStart.");
      this.isPlaying = true;
      if (this.onPlaybackStart) this.onPlaybackStart();
    }

    console.log(`AudioPlayer: Starting source node at nextPlayTime: ${this.nextPlayTime}, duration: ${buffer.duration}`);
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;

    // Setup end listener for this specific buffer
    source.onended = () => {
      // Remove from active list
      this.activeSources = this.activeSources.filter(s => s !== source);

      console.log(`AudioPlayer: Chunk playback ended. Queue length: ${this.audioQueue.length}, currentTime: ${this.audioCtx.currentTime}, nextPlayTime: ${this.nextPlayTime}`);

      // If the queue is empty and the current time has surpassed the last scheduled time, we are done
      if (this.audioQueue.length === 0 && this.audioCtx.currentTime >= this.nextPlayTime - 0.01) {
        if (this.isPlaying) {
          console.log("AudioPlayer: Queue empty and time surpassed. Transitioning to isPlaying = false. Triggering onPlaybackEnd.");
          this.isPlaying = false;
          if (this.onPlaybackEnd) this.onPlaybackEnd();
        }
      }
    };
  }

  stopAll() {
    console.log("AudioPlayer: stopAll() called. Clearing active sources and queue.");
    // Stop all active playing nodes immediately
    this.activeSources.forEach(source => {
      try {
        source.stop();
      } catch (e) {}
    });
    this.activeSources = [];
    this.audioQueue = [];
    this.isPlaying = false;
    this.nextPlayTime = 0;
    if (this.onPlaybackEnd) this.onPlaybackEnd();
  }
}
