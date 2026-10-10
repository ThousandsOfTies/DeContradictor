export const EMOTIONS = {
  neutral: '普通', happy: '喜び', angry: '怒り', sad: '悲しみ',
  surprised: '驚き', relaxed: '穏やか', thinking: '考え中',
  confused: '困惑', empathetic: '共感',
};
export const LIVE_EMOTIONS = Object.keys(EMOTIONS);
export const normalizeEmotion = (value) => LIVE_EMOTIONS.includes(value) ? value : 'neutral';

// 採用済み画像をそのまま使い、各円形ポートレートをCSSで切り出す。
export function robotAvatar(emotion, color) {
  const safe = normalizeEmotion(emotion);
  const index = LIVE_EMOTIONS.indexOf(safe);
  const x = (color === 'pink' ? [803, 1044, 1284] : [39, 279, 519])[index % 3];
  const y = [108, 389, 671][Math.floor(index / 3)];
  const avatar = document.createElement('span');
  avatar.className = 'chat-avatar robot-avatar';
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', `Gemini：${EMOTIONS[safe]}`);
  avatar.title = EMOTIONS[safe];
  avatar.style.backgroundImage = `url("${import.meta.env?.BASE_URL || '/'}avatars/robot-emotions.png")`;
  avatar.style.backgroundSize = `${1536 / 220 * 100}% ${1024 / 220 * 100}%`;
  avatar.style.backgroundPosition = `${x / (1536 - 220) * 100}% ${y / (1024 - 220) * 100}%`;
  return avatar;
}

export function profileAvatar(profile) {
  const avatar = document.createElement('span');
  avatar.className = 'chat-avatar user-avatar';
  avatar.textContent = (profile?.name || '自分').slice(0, 1);
  avatar.title = profile?.name || '自分';
  if (profile?.picture && /^https:\/\//.test(profile.picture)) {
    const image = document.createElement('img');
    image.src = profile.picture;
    image.alt = profile.name || '自分';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove());
    avatar.append(image);
  }
  return avatar;
}
