/**
 * 通用工具函数。微信小游戏没有浏览器 DOM，尽量保持这些函数纯粹，
 * 方便在游戏逻辑和云函数之间复用同样的随机、坐标、数学逻辑。
 */

// 把数值限制在指定范围内，常用于时间差、坐标和数组下标保护。
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 线性插值：t 为 0 返回 a，t 为 1 返回 b，中间值用于平滑移动。
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 欧氏距离，适合需要真实直线距离的场景。
function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// 曼哈顿距离，适合棋盘格范围判断。
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// 判断两个格子坐标是否完全相同。
function sameCell(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

// 把格子坐标转成字符串 key，方便放进 Map/Object 做查找。
function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

// 当前时间戳封装，方便后续统一替换为测试时间。
function now() {
  return Date.now();
}

/**
 * 简单可复现随机数。云函数和客户端只要使用相同 seed，
 * 征兵或波次结果就可以稳定复现。
 */
class SeededRandom {
  constructor(seed) {
    this.seed = hashString(String(seed || Date.now()));
  }

  // 返回 0 到 1 之间的伪随机数。同一个 seed 会得到同样序列。
  next() {
    // Mulberry32，足够小游戏抽卡和波次使用。
    let t = this.seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 返回 min 到 max 之间的整数，包含两端。
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  // 从数组里按随机下标取一个元素。
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }
}

// 把字符串稳定转换成 32 位数字，作为伪随机种子。
function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// 生成带前缀的临时 ID，用于敌人、房间和特效对象。
function makeId(prefix) {
  return `${prefix}_${now()}_${Math.floor(Math.random() * 100000)}`;
}

// 判断触摸点是否落在矩形按钮或区域内。
function pointInRect(point, rect) {
  return point.x >= rect.x
    && point.x <= rect.x + rect.w
    && point.y >= rect.y
    && point.y <= rect.y + rect.h;
}

// 给 Canvas 当前路径追加一个圆角矩形，调用方再自行 fill/stroke。
function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// 绘制居中文本，支持描边，常用于标题、棋子文字和按钮文字。
function drawCenteredText(ctx, text, x, y, options) {
  const opt = options || {};
  ctx.save();
  ctx.fillStyle = opt.color || '#241915';
  ctx.font = opt.font || '24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opt.stroke) {
    ctx.lineWidth = opt.strokeWidth || 3;
    ctx.strokeStyle = opt.stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

// 按最大宽度逐字换行绘制中文文本，返回实际绘制行数。
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const lines = [];
  let line = '';
  for (let i = 0; i < text.length; i += 1) {
    const test = line + text[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = text[i];
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
  return lines.length;
}

// 安全执行函数，异常时返回 null，避免非核心逻辑中断游戏。
function safeCall(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn(err);
    return null;
  }
}

module.exports = {
  clamp,
  lerp,
  distance,
  manhattan,
  sameCell,
  cellKey,
  now,
  SeededRandom,
  hashString,
  makeId,
  pointInRect,
  roundedRect,
  drawCenteredText,
  wrapText,
  safeCall
};
