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

  // 外部直接设置静音状态，通常用于同步设置开关。
  setMuted(value) {
    this.muted = !!value;
  }

  // 切换静音状态，并返回切换后的结果，方便按钮刷新显示。
  toggleMuted() {
    this.muted = !this.muted;
    return this.muted;
  }

  // 播放指定音效。没有真实音频资源时，用微信短震动作为临时反馈。
  play(name) {
    if (this.muted) return;
    // 暂时屏蔽测试时高频触发的反馈，保留调用点方便后续恢复。
    if (['drag', 'place', 'attack'].indexOf(name) !== -1) return;

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
