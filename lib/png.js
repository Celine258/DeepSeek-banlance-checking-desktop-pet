'use strict';

/**
 * 纯 Node 实现的 PNG 生成器（不依赖任何第三方库）。
 *
 * 用途有两个：
 *   1. 生成系统托盘图标（否则 Tray 在某些环境下会因为没有图标直接报错）；
 *   2. 生成占位角色图 —— 在用户还没放正式素材的时候，桌宠依然能正常跑起来。
 */

const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * 基础：CRC32 + PNG 分块编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 把 RGBA 像素缓冲编码成 PNG Buffer。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须是 width * height * 4
 */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ *
 * 画布小工具
 * ------------------------------------------------------------------ */

function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** 把颜色按 alpha 混合到画布上（正常 source-over） */
function blend(canvas, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || a <= 0) return;
  const i = (y * canvas.width + x) * 4;
  const d = canvas.data;
  const sa = a > 1 ? 1 : a;
  const da = d[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    return;
  }
  d[i] = Math.round((r * sa + d[i] * da * (1 - sa)) / outA);
  d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / outA);
  d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / outA);
  d[i + 3] = Math.round(outA * 255);
}

/** 用距离场做 1px 抗锯齿的覆盖率 */
function coverage(distance) {
  const c = 0.5 - distance;
  return c <= 0 ? 0 : c >= 1 ? 1 : c;
}

function fillCircle(canvas, cx, cy, radius, color, alpha) {
  const x0 = Math.max(0, Math.floor(cx - radius - 2));
  const x1 = Math.min(canvas.width - 1, Math.ceil(cx + radius + 2));
  const y0 = Math.max(0, Math.floor(cy - radius - 2));
  const y1 = Math.min(canvas.height - 1, Math.ceil(cy + radius + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
      const a = coverage(d) * alpha;
      if (a > 0) blend(canvas, x, y, color[0], color[1], color[2], a);
    }
  }
}

function strokeCircle(canvas, cx, cy, radius, thickness, color, alpha) {
  const x0 = Math.max(0, Math.floor(cx - radius - thickness - 2));
  const x1 = Math.min(canvas.width - 1, Math.ceil(cx + radius + thickness + 2));
  const y0 = Math.max(0, Math.floor(cy - radius - thickness - 2));
  const y1 = Math.min(canvas.height - 1, Math.ceil(cy + radius + thickness + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius) - thickness / 2;
      const a = coverage(d) * alpha;
      if (a > 0) blend(canvas, x, y, color[0], color[1], color[2], a);
    }
  }
}

/** 点到线段的距离 */
function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function strokeLine(canvas, x1, y1, x2, y2, thickness, color, alpha) {
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - thickness - 2));
  const xEnd = Math.min(canvas.width - 1, Math.ceil(Math.max(x1, x2) + thickness + 2));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - thickness - 2));
  const yEnd = Math.min(canvas.height - 1, Math.ceil(Math.max(y1, y2) + thickness + 2));
  const half = thickness / 2;
  for (let y = y0; y <= yEnd; y++) {
    for (let x = x0; x <= xEnd; x++) {
      const d = segmentDistance(x + 0.5, y + 0.5, x1, y1, x2, y2) - half;
      const a = coverage(d) * alpha;
      if (a > 0) blend(canvas, x, y, color[0], color[1], color[2], a);
    }
  }
}

/** 圆角矩形的有符号距离场（负值在内部） */
function roundRectDistance(px, py, left, top, right, bottom, radius) {
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const hw = (right - left) / 2;
  const hh = (bottom - top) / 2;
  const r = Math.min(radius, hw, hh);
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

/* ------------------------------------------------------------------ *
 * 托盘图标
 * ------------------------------------------------------------------ */

/**
 * 生成托盘图标：DeepSeek 蓝的圆，中间一个白色圆环（像个硬币）。
 * 圆环旁边点一个小白点，避免和「音量」之类的系统图标撞脸。
 */
function makeTrayIcon(size = 32) {
  const canvas = createCanvas(size, size);
  const s = size / 32;
  const cx = size / 2;
  const cy = size / 2;
  const R = 14.5 * s;

  // 外圈：从上到下的蓝色渐变，用横向条带近似
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(91 + (61 - 91) * t);
    const g = Math.round(124 + (85 - 124) * t);
    const b = Math.round(255 + (232 - 255) * t);
    const halfSpan = size;
    for (let x = 0; x < halfSpan; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R;
      const a = coverage(d);
      if (a > 0) blend(canvas, x, y, r, g, b, a);
    }
  }

  strokeCircle(canvas, cx, cy, 8.2 * s, 2.6 * s, [255, 255, 255], 0.95);
  fillCircle(canvas, cx + 4.4 * s, cy + 4.4 * s, 2.1 * s, [255, 255, 255], 0.95);

  return encodePNG(canvas.width, canvas.height, canvas.data);
}

/* ------------------------------------------------------------------ *
 * 占位角色图
 * ------------------------------------------------------------------ */

/**
 * 用户还没放素材时用的占位图：一个淡淡的剪影 + 虚线画布框。
 * 目的有两个：确认透明底是好的，以及让你在正式素材到位之前
 * 就能看到「点击后睁眼邪笑」这个效果确实生效。
 *
 * @param {'closed'|'open'} [options.eyes] closed = 平时闭眼，open = 点击时睁眼邪笑
 */
function makePlaceholderCharacter(width = 400, height = 600, options = {}) {
  const drawOpenEyes = options.eyes === 'open';
  const canvas = createCanvas(width, height);
  const silhouette = [128, 138, 182];
  const ink = [54, 58, 80];
  const line = [77, 107, 254];

  const cx = width / 2;
  const headR = width * 0.22;
  const headCY = height * 0.245;
  const bodyTop = headCY + headR * 0.72; // 插进头里面一点，别让脑袋和身子断开
  const bodyBottom = height * 0.945;
  const bodyHalf = width * 0.245;
  const bodyRadius = width * 0.15;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const headA = coverage(Math.hypot(px - cx, py - headCY) - headR);
      const bodyA = coverage(
        roundRectDistance(px, py, cx - bodyHalf, bodyTop, cx + bodyHalf, bodyBottom, bodyRadius)
      );
      const a = Math.max(headA, bodyA) * 0.82;
      if (a > 0) blend(canvas, x, y, silhouette[0], silhouette[1], silhouette[2], a);
    }
  }

  /* ---- 五官：两种状态共用同一套位置，切换时只有五官变化 ---- */

  const eyeDX = headR * 0.4;
  const eyeY = headCY - headR * 0.04;
  const eyeX1 = cx - eyeDX;
  const eyeX2 = cx + eyeDX;

  if (drawOpenEyes) {
    // 睁开的眼睛
    for (const ex of [eyeX1, eyeX2]) {
      fillCircle(canvas, ex, eyeY, headR * 0.15, ink, 1);
      fillCircle(canvas, ex - headR * 0.055, eyeY - headR * 0.055, headR * 0.05, [255, 255, 255], 1);
    }
    // 坏笑：嘴角往右上方挑
    const m0x = cx - headR * 0.06;
    const m0y = headCY + headR * 0.4;
    const m1x = cx + headR * 0.18;
    const m1y = headCY + headR * 0.46;
    const m2x = cx + headR * 0.42;
    const m2y = headCY + headR * 0.2;
    strokeLine(canvas, m0x, m0y, m1x, m1y, headR * 0.06, ink, 1);
    strokeLine(canvas, m1x, m1y, m2x, m2y, headR * 0.06, ink, 1);
  } else {
    // 闭着的眼睛：两条短横线
    for (const ex of [eyeX1, eyeX2]) {
      strokeLine(
        canvas,
        ex - headR * 0.2,
        eyeY,
        ex + headR * 0.2,
        eyeY,
        headR * 0.055,
        ink,
        0.9
      );
    }
    // 平静的嘴角
    strokeLine(
      canvas,
      cx - headR * 0.12,
      headCY + headR * 0.42,
      cx + headR * 0.16,
      headCY + headR * 0.42,
      headR * 0.055,
      ink,
      0.9
    );
  }

  // 虚线外框，提示这是画布边界
  const inset = Math.max(3, Math.round(width * 0.015));
  const left = inset;
  const top = inset;
  const right = width - inset - 1;
  const bottom = height - inset - 1;
  const dash = Math.max(6, Math.round(width * 0.035));
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const onEdge =
        Math.abs(x - left) <= 0.75 ||
        Math.abs(x - right) <= 0.75 ||
        Math.abs(y - top) <= 0.75 ||
        Math.abs(y - bottom) <= 0.75;
      if (!onEdge) continue;
      const phase = (Math.abs(x - left) <= 0.75 || Math.abs(x - right) <= 0.75)
        ? (y - top)
        : (x - left);
      if (phase % (dash * 2) >= dash) continue;
      // alpha 压得比 hitmask 的阈值低，免得这一圈虚线把桌面图标的点击也挡了
      blend(canvas, x, y, line[0], line[1], line[2], 0.3);
    }
  }

  return {
    buffer: encodePNG(canvas.width, canvas.height, canvas.data),
    width,
    height
  };
}

module.exports = { encodePNG, makeTrayIcon, makePlaceholderCharacter };
