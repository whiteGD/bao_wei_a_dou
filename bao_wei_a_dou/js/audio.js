/**
 * 音效管理器。
 * 第一版没有正式音频资源，所以这里用系统振动作为反馈兜底；
 * 后续只需要把 audioMap 中的 src 指向真实 mp3/wav 即可。
 */

class AudioManager {
  constructor() {
    this.muted = false;
    this.audioMap = {};
  }

  setMuted(value) {
    this.muted = !!value;
  }

  toggleMuted() {
    this.muted = !this.muted;
    return this.muted;
  }

  play(name) {
    if (this.muted) return;

    const audio = this.audioMap[name];
    if (audio) {
      audio.stop();
      audio.play();
      return;
    }

    // 没有资源时，用短振动表达“点击/成功/失败”等关键反馈。
    if (typeof wx !== 'undefined' && wx.vibrateShort) {
      wx.vibrateShort({ type: name === 'error' ? 'heavy' : 'light' });
    }
  }
}

module.exports = { AudioManager };
