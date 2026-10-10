import { EMOTIONS, normalizeEmotion, robotAvatar, profileAvatar } from './live-emotions.js';

export class LiveChat {
  constructor(element, onChange) {
    this.element = element;
    this.onChange = onChange;
    this.messages = [];
    this.emotion = 'neutral';
    this.color = 'blue';
    this.profile = null;
    this.active = null;
    this.follow = true;
    this.latest = document.getElementById('live-chat-latest');
    this.element.addEventListener('scroll', () => {
      this.follow = this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight < 32;
      this.latest.hidden = this.follow;
    });
    this.latest.addEventListener('click', () => { this.follow = true; this.scroll(); });
    window.addEventListener('gemini-live-log', ({ detail }) => {
      if (detail.kind === 'user' || detail.kind === 'model') this.append(detail);
    });
    window.addEventListener('gemini-live-turn-end', () => { this.active = null; });
    window.addEventListener('gemini-live-emotion', ({ detail }) => {
      this.emotion = normalizeEmotion(detail.emotion);
      if (this.active?.role === 'model') {
        this.active.emotion = this.emotion;
        this.render();
        this.onChange();
      }
    });
    window.addEventListener('gemini-live-clear', () => {
      this.messages = []; this.active = null; this.render(); this.onChange();
    });
    this.render();
  }

  append({ kind, text, time }) {
    const clean = text.replace(/^(入力: |テキスト指示: |Gemini: |テキスト: )/, '');
    if (!clean) return;
    if (this.active?.role !== kind) {
      this.active = {
        role: kind, text: '', time, emotion: this.emotion, color: this.color,
        author: kind === 'user' && this.profile ? { ...this.profile } : null,
      };
      this.messages.push(this.active);
      if (this.messages.length > 1000) this.messages.shift();
    }
    this.active.text += clean;
    this.render();
    this.onChange();
  }

  setProfile(profile) {
    this.profile = profile;
    // 過去の発言者は保存時のプロフィールを維持する。
    this.render();
  }

  restore(messages) {
    this.messages = messages;
    this.active = null;
    this.render();
  }

  render() {
    const previousScrollTop = this.element.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const message of this.messages) {
      const item = document.createElement('li');
      item.className = `chat-message chat-${message.role}`;
      const avatar = message.role === 'model'
        ? robotAvatar(message.emotion, message.color)
        : profileAvatar(message.author);
      const body = document.createElement('div');
      body.className = 'chat-message-body';
      const heading = document.createElement('div');
      heading.className = 'chat-message-heading';
      const name = message.role === 'model' ? 'Gemini' : (message.author?.name || '自分');
      const emotion = message.role === 'model' ? ` · ${EMOTIONS[normalizeEmotion(message.emotion)]}` : '';
      heading.textContent = `${name}${emotion} · ${new Date(message.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
      const text = document.createElement('p');
      text.textContent = message.text;
      body.append(heading, text);
      item.append(avatar, body);
      fragment.append(item);
    }
    this.element.replaceChildren(fragment);
    document.getElementById('live-chat-empty').hidden = this.messages.length > 0;
    if (this.follow) this.scroll();
    else this.element.scrollTop = previousScrollTop;
  }

  scroll() {
    this.element.scrollTop = this.element.scrollHeight;
    this.latest.hidden = true;
  }
}
