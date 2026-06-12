/**
 * 通用工具函数。微信小游戏没有浏览器 DOM，尽量保持这些函数纯粹，
 * 方便在游戏逻辑和云函数之间复用同样的随机、坐标、数学逻辑。
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function sameCell(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

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

  next() {
    // Mulberry32，足够小游戏抽卡和波次使用。
    let t = this.seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeId(prefix) {
  return `${prefix}_${now()}_${Math.floor(Math.random() * 100000)}`;
}

function pointInRect(point, rect) {
  return point.x >= rect.x
    && point.x <= rect.x + rect.w
    && point.y >= rect.y
    && point.y <= rect.y + rect.h;
}

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
