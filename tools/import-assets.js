'use strict';

/**
 * 角色素材：导入 + 体检 + 自动对齐
 *
 * 用法：
 *   node tools/import-assets.js            从「待导入」文件夹导入（推荐，双击 导入素材.bat）
 *   node tools/import-assets.js --align    只对已经导入的角色重新对齐（双击 对齐素材.bat）
 *   node tools/import-assets.js --align 角色1  只处理某一个角色
 *
 * 体检会告诉你：透明通道有没有、背景抠没抠干净、两张图尺寸是否一致、
 * 人物位置对不对得齐、差异是不是只集中在脸上。
 *
 * 对齐会做一件很实在的事：算出「点击图」相对「平时图」需要平移和缩放多少，
 * 然后直接生成两张对齐好的新图（原图备份到 _原始/）。
 * 不这么做的话，点击时人物会整体抖一下 —— 因为程序是把两张图叠在同一个位置、
 * 只调上面那层的透明度。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { encodePNG } = require('../lib/png.js');

const ROOT = path.join(__dirname, '..');
const CHARS_DIR = path.join(ROOT, 'assets', 'characters');
const INBOX = path.join(ROOT, '待导入');
const BACKUP_DIR = '_原始';

const IMAGE_EXT = ['.png', '.webp'];
const IDLE_MARKS = ['闭眼', '闭', '平时', '普通', '平静', 'idle', 'closed', 'normal'];
const ACTIVE_MARKS = ['睁眼', '睁', '点击', '邪笑', '坏笑', 'smirk', 'active', 'open', 'click'];

const IDLE_FILES = ['idle.png', 'idle.webp', '平时.png', '平时.webp', '普通.png'];
const ACTIVE_FILES = ['active.png', 'active.webp', '点击.png', '点击.webp', '睁眼.png', '邪笑.png'];

const ALPHA_SOLID = 128; // 算「实心人物」的阈值
const ALPHA_LIMIT = 16; // 低于这个算完全透明
const MASK_ALPHA = 100; // 算进轮廓掩码的阈值

const line = (n = 64) => '─'.repeat(n);

/* ================================================================
 * 一、PNG 解码（纯手写，只为了能读到像素，不依赖任何第三方库）
 * ================================================================ */

function channelsFor(colorType) {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, out, width, height, channels) {
  const stride = width * channels;
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    pos++;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          value = rawByte;
      }
      out[rowStart + x] = value & 0xff;
    }
    pos += stride;
  }
}

function decodePng(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (err) {
    return null;
  }
  if (buffer.length < 26 || buffer.readUInt32BE(0) !== 0x89504e47) return null;

  let offset = 8;
  const idat = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }

  const unsupported = { width, height, colorType, supported: false };
  if (!width || !height) return null;
  if (bitDepth !== 8 || interlace !== 0) return unsupported;

  const channels = channelsFor(colorType);
  if (!channels) return unsupported;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    return unsupported;
  }

  const stride = width * channels;
  if (raw.length < stride * height) return unsupported;

  const pixels = Buffer.alloc(stride * height);
  unfilter(raw, pixels, width, height, channels);

  return { width, height, colorType, channels, pixels, palette, trns, supported: true };
}

function pixelAtIndex(img, i) {
  switch (img.colorType) {
    case 6:
      return [img.pixels[i * 4], img.pixels[i * 4 + 1], img.pixels[i * 4 + 2], img.pixels[i * 4 + 3]];
    case 2:
      return [img.pixels[i * 3], img.pixels[i * 3 + 1], img.pixels[i * 3 + 2], 255];
    case 4:
      return [img.pixels[i * 2], img.pixels[i * 2], img.pixels[i * 2], img.pixels[i * 2 + 1]];
    case 0:
      return [img.pixels[i], img.pixels[i], img.pixels[i], 255];
    case 3: {
      const idx = img.pixels[i];
      if (!img.palette) return null;
      return [
        img.palette[idx * 3],
        img.palette[idx * 3 + 1],
        img.palette[idx * 3 + 2],
        img.trns && idx < img.trns.length ? img.trns[idx] : 255
      ];
    }
    default:
      return null;
  }
}

/* ================================================================
 * 二、把图统一成 RGBA，方便后面做缩放 / 平移 / 打分
 * ================================================================ */

function toRGBA(img) {
  const count = img.width * img.height;
  const data = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) {
    const px = pixelAtIndex(img, i);
    if (!px) return null;
    data[i * 4] = px[0];
    data[i * 4 + 1] = px[1];
    data[i * 4 + 2] = px[2];
    data[i * 4 + 3] = px[3];
  }
  return { width: img.width, height: img.height, data };
}

/** 双线性缩放。先乘 alpha 再插值，避免半透明边缘发黑。 */
function scaleRGBA(src, scale) {
  if (Math.abs(scale - 1) < 1e-6) return src;

  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const out = { width: dw, height: dh, data: Buffer.alloc(dw * dh * 4) };
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;

  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    const y0 = Math.min(sh - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - Math.floor(sy)));

    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - Math.floor(sx)));

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      const a00 = sd[i00 + 3];
      const a10 = sd[i10 + 3];
      const a01 = sd[i01 + 3];
      const a11 = sd[i11 + 3];
      const alpha = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

      const p00 = a00 / 255;
      const p10 = a10 / 255;
      const p01 = a01 / 255;
      const p11 = a11 / 255;

      const r = sd[i00] * p00 * w00 + sd[i10] * p10 * w10 + sd[i01] * p01 * w01 + sd[i11] * p11 * w11;
      const g =
        sd[i00 + 1] * p00 * w00 + sd[i10 + 1] * p10 * w10 + sd[i01 + 1] * p01 * w01 + sd[i11 + 1] * p11 * w11;
      const b =
        sd[i00 + 2] * p00 * w00 + sd[i10 + 2] * p10 * w10 + sd[i01 + 2] * p01 * w01 + sd[i11 + 2] * p11 * w11;

      const o = (y * dw + x) * 4;
      const aNorm = alpha / 255;
      if (aNorm > 0.0001) {
        out.data[o] = Math.min(255, Math.round(r / aNorm));
        out.data[o + 1] = Math.min(255, Math.round(g / aNorm));
        out.data[o + 2] = Math.min(255, Math.round(b / aNorm));
      }
      out.data[o + 3] = Math.min(255, Math.round(alpha));
    }
  }
  return out;
}

function pasteOnto(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

function bboxOfRGBA(rgba, threshold) {
  let minX = rgba.width;
  let minY = rgba.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rgba.height; y++) {
    for (let x = 0; x < rgba.width; x++) {
      if (rgba.data[(y * rgba.width + x) * 4 + 3] < threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function maskOfRGBA(rgba, threshold) {
  const mask = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < mask.length; i++) mask[i] = rgba.data[i * 4 + 3] >= threshold ? 1 : 0;
  return mask;
}

/** 把 b 平移 (dx, dy) 之后和 a 的重合度，1 = 完全重合 */
function overlapScore(a, wa, ha, b, wb, hb, dx, dy) {
  const x0 = Math.min(0, dx);
  const y0 = Math.min(0, dy);
  const x1 = Math.max(wa, wb + dx);
  const y1 = Math.max(ha, hb + dy);

  let inter = 0;
  let union = 0;
  for (let y = y0; y < y1; y++) {
    const by = y - dy;
    const rowA = y >= 0 && y < ha ? y * wa : -1;
    const rowB = by >= 0 && by < hb ? by * wb : -1;
    for (let x = x0; x < x1; x++) {
      const av = rowA >= 0 && x >= 0 && x < wa ? a[rowA + x] : 0;
      const bx = x - dx;
      const bv = rowB >= 0 && bx >= 0 && bx < wb ? b[rowB + bx] : 0;
      if (av || bv) {
        union++;
        if (av && bv) inter++;
      }
    }
  }
  return union ? inter / union : 0;
}

/**
 * 找出「点击图」相对「平时图」的最佳缩放 + 位移。
 * 先用低分辨率粗搜，再逐步提高分辨率精修。
 * @returns {{scale, dx, dy, score, base}} base = 粗搜时两者各自的外观分（用来判断对齐是否可信）
 */
function findAlignment(idleRGBA, activeRGBA) {
  const maxEdge = Math.max(
    idleRGBA.width,
    idleRGBA.height,
    activeRGBA.width,
    activeRGBA.height
  );

  // --- 第一轮：降到 128 像素粗搜 ---
  const k1 = Math.min(1, 128 / maxEdge);
  const a1 = scaleRGBA(idleRGBA, k1);
  const b1 = scaleRGBA(activeRGBA, k1);
  const bbA = bboxOfRGBA(a1, MASK_ALPHA);
  const bbB = bboxOfRGBA(b1, MASK_ALPHA);
  if (!bbA || !bbB) return null;

  const baseScale = bbA.h / bbB.h;
  const maskA1 = maskOfRGBA(a1, MASK_ALPHA);

  let best = null;
  const scaleCandidates = [-0.06, -0.045, -0.03, -0.015, 0, 0.015, 0.03, 0.045, 0.06].map(
    (m) => baseScale * (1 + m)
  );

  for (const s of scaleCandidates) {
    const bs = scaleRGBA(b1, s);
    const bb = bboxOfRGBA(bs, MASK_ALPHA);
    if (!bb) continue;
    const cx = Math.round(bbA.x + bbA.w / 2 - (bb.x + bb.w / 2));
    const cy = Math.round(bbA.y + bbA.h / 2 - (bb.y + bb.h / 2));
    const maskBs = maskOfRGBA(bs, MASK_ALPHA);

    for (let dy = cy - 12; dy <= cy + 12; dy += 2) {
      for (let dx = cx - 12; dx <= cx + 12; dx += 2) {
        const score = overlapScore(maskA1, a1.width, a1.height, maskBs, bs.width, bs.height, dx, dy);
        if (!best || score > best.score) best = { score, scale: s, dx, dy, k: k1 };
      }
    }
  }
  if (!best) return null;

  // --- 第二轮：在同一分辨率下把步长收到 1 像素 ---
  let refined = best;
  {
    const bs = scaleRGBA(b1, best.scale);
    const maskBs = maskOfRGBA(bs, MASK_ALPHA);
    for (let dy = best.dy - 3; dy <= best.dy + 3; dy++) {
      for (let dx = best.dx - 3; dx <= best.dx + 3; dx++) {
        const score = overlapScore(maskA1, a1.width, a1.height, maskBs, bs.width, bs.height, dx, dy);
        if (score > refined.score) refined = { score, scale: best.scale, dx, dy, k: k1 };
      }
    }
  }

  // --- 第三轮：提到 384 像素精修 ---
  const k2 = Math.min(1, 384 / maxEdge);
  if (k2 > k1) {
    const a2 = scaleRGBA(idleRGBA, k2);
    const b2 = scaleRGBA(activeRGBA, k2);
    const maskA2 = maskOfRGBA(a2, MASK_ALPHA);
    const ratio = k2 / k1;
    const cx = Math.round(refined.dx * ratio);
    const cy = Math.round(refined.dy * ratio);

    for (const m of [-0.004, 0, 0.004]) {
      const s = refined.scale * (1 + m);
      const bs = scaleRGBA(b2, s);
      const maskBs = maskOfRGBA(bs, MASK_ALPHA);
      for (let dy = cy - 4; dy <= cy + 4; dy++) {
        for (let dx = cx - 4; dx <= cx + 4; dx++) {
          const score = overlapScore(maskA2, a2.width, a2.height, maskBs, bs.width, bs.height, dx, dy);
          if (score > refined.score) refined = { score, scale: s, dx, dy, k: k2 };
        }
      }
    }
  }

  return {
    scale: refined.scale,
    dx: refined.dx / refined.k,
    dy: refined.dy / refined.k,
    score: refined.score
  };
}

/**
 * 把两张图对齐到同一张画布上。
 * @returns {{idle: object, active: object} | null}
 */
function buildAlignedPair(idleRGBA, activeRGBA, align) {
  const activeScaled = scaleRGBA(activeRGBA, align.scale);
  const ox = align.dx;
  const oy = align.dy;

  const bbI = bboxOfRGBA(idleRGBA, MASK_ALPHA);
  const bbA = bboxOfRGBA(activeScaled, MASK_ALPHA);
  if (!bbI || !bbA) return null;

  const minX = Math.min(bbI.x, bbA.x + ox);
  const minY = Math.min(bbI.y, bbA.y + oy);
  const maxX = Math.max(bbI.x + bbI.w, bbA.x + bbA.w + ox);
  const maxY = Math.max(bbI.y + bbI.h, bbA.y + bbA.h + oy);

  const contentW = Math.ceil(maxX - minX);
  const contentH = Math.ceil(maxY - minY);
  const margin = Math.max(6, Math.round(Math.max(contentW, contentH) * 0.02));

  const outW = contentW + margin * 2;
  const outH = contentH + margin * 2;

  const idleOut = { width: outW, height: outH, data: Buffer.alloc(outW * outH * 4) };
  const activeOut = { width: outW, height: outH, data: Buffer.alloc(outW * outH * 4) };

  const idleX = Math.round(margin - minX);
  const idleY = Math.round(margin - minY);

  pasteOnto(idleOut, idleRGBA, idleX, idleY);
  pasteOnto(activeOut, activeScaled, Math.round(idleX + ox), Math.round(idleY + oy));

  return { idle: idleOut, active: activeOut };
}

/* ================================================================
 * 三、体检
 * ================================================================ */

function analyse(file) {
  const img = decodePng(file);

  if (!img) {
    return { ok: false, reason: '不是 PNG 或者读不出来（.webp 不支持体检，但不影响使用）' };
  }
  if (!img.supported) {
    return {
      ok: false,
      reason: `PNG 格式比较特殊（位深/隔行/颜色类型 ${img.colorType}），跳过体检`,
      width: img.width,
      height: img.height
    };
  }

  const rgba = toRGBA(img);
  if (!rgba) return { ok: false, reason: '颜色格式不支持，跳过体检' };

  const hasAlphaChannel = img.colorType === 4 || img.colorType === 6;
  let transparent = 0;
  for (let i = 0; i < rgba.width * rgba.height; i++) {
    if (rgba.data[i * 4 + 3] < ALPHA_LIMIT) transparent++;
  }

  const corners = [
    [0, 0],
    [rgba.width - 1, 0],
    [0, rgba.height - 1],
    [rgba.width - 1, rgba.height - 1]
  ].map(([x, y]) => {
    const i = (y * rgba.width + x) * 4;
    return [rgba.data[i], rgba.data[i + 1], rgba.data[i + 2], rgba.data[i + 3]];
  });

  return {
    ok: true,
    width: rgba.width,
    height: rgba.height,
    colorType: img.colorType,
    hasAlphaChannel,
    transparentRatio: transparent / (rgba.width * rgba.height),
    bbox: bboxOfRGBA(rgba, ALPHA_SOLID),
    cornerWhite: corners.every((c) => c[0] > 240 && c[1] > 240 && c[2] > 240),
    rgba
  };
}

function reportImage(label, info) {
  if (!info || !info.ok) {
    console.log(`   ${label}  ⚠️  ${info ? info.reason : '读不出来'}`);
    return false;
  }

  console.log(`   ${label}  ${info.width}×${info.height}`);
  let good = true;

  if (!info.hasAlphaChannel) {
    if (info.cornerWhite) {
      console.log('        ❌ 没有透明通道，四个角是白色的 —— 背景还在，没有抠图。');
      console.log('           桌宠会变成「人物 + 一块白底」，必须重新导出带透明度的 PNG。');
    } else {
      console.log(`        ❌ 没有透明通道（PNG 颜色类型 ${info.colorType}），做不成透明底。`);
    }
    good = false;
  } else if (info.transparentRatio < 0.02) {
    console.log(
      `        ❌ 有透明通道，但只有 ${(info.transparentRatio * 100).toFixed(1)}% 的像素是透明的 —— 背景基本没抠掉。`
    );
    good = false;
  } else {
    console.log(`        ✅ 透明底正常（${(info.transparentRatio * 100).toFixed(0)}% 的像素是透明的）`);
  }

  if (info.bbox) {
    const { x, y, w, h } = info.bbox;
    console.log(`        · 人物范围：x ${x} → ${x + w - 1}，y ${y} → ${y + h - 1}`);
  } else {
    console.log('        ❌ 整张图没有不透明像素');
    good = false;
  }

  return good;
}

/* ================================================================
 * 四、对齐 + 落盘
 * ================================================================ */

function backupOnce(folder, file) {
  try {
    const dir = path.join(folder, BACKUP_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(file));
    if (!fs.existsSync(target)) fs.copyFileSync(file, target);
  } catch (err) {
    /* 备份失败不影响主流程 */
  }
}

function writeRGBA(file, rgba) {
  fs.writeFileSync(file, encodePNG(rgba.width, rgba.height, rgba.data));
}

/**
 * 对齐一对图并报告。writeBack = true 时会把对齐结果写回文件夹（原图先备份）。
 * @returns {boolean} 是否一切正常
 */
function alignAndReport(folder, idleFile, activeFile, writeBack) {
  const idleInfo = analyse(idleFile);
  const activeInfo = analyse(activeFile);

  if (!idleInfo.ok || !activeInfo.ok || !idleInfo.rgba || !activeInfo.rgba) {
    console.log('        ⚠️  这两张图读不出像素，跳过自动对齐。');
    return false;
  }

  const align = findAlignment(idleInfo.rgba, activeInfo.rgba);
  if (!align) {
    console.log('        ⚠️  图里找不到不透明内容，跳过自动对齐。');
    return false;
  }

  const scalePct = (align.scale - 1) * 100;
  const sizeChanged =
    idleInfo.width !== activeInfo.width || idleInfo.height !== activeInfo.height;
  const misaligned =
    Math.abs(align.dx) >= 1.5 || Math.abs(align.dy) >= 1.5 || Math.abs(scalePct) >= 0.5 || sizeChanged;

  console.log(
    `        · 实测：点击图相对平时图 平移 ${align.dx.toFixed(1)}, ${align.dy.toFixed(1)} 像素，缩放 ${scalePct >= 0 ? '+' : ''}${scalePct.toFixed(2)}%，轮廓重合度 ${(align.score * 100).toFixed(1)}%`
  );

  if (!misaligned) {
    console.log('        ✅ 两张图本来就是对齐的，不用动。');
    return true;
  }

  if (!writeBack) {
    console.log('        ⚠️  没对齐。加上 --align 参数可以自动修好。');
    return false;
  }

  const pair = buildAlignedPair(idleInfo.rgba, activeInfo.rgba, align);
  if (!pair) {
    console.log('        ❌ 生成对齐图失败。');
    return false;
  }

  backupOnce(folder, idleFile);
  backupOnce(folder, activeFile);
  writeRGBA(path.join(folder, 'idle.png'), pair.idle);
  writeRGBA(path.join(folder, 'active.png'), pair.active);

  // 原来的文件如果扩展名不是 .png，清掉，免得两个版本打架
  for (const f of [idleFile, activeFile]) {
    if (path.extname(f).toLowerCase() !== '.png') {
      try {
        fs.unlinkSync(f);
      } catch (err) {
        /* ignore */
      }
    }
  }

  console.log(
    `        ✅ 已对齐并重新生成（${pair.idle.width}×${pair.idle.height}），原图备份在 ${BACKUP_DIR}/`
  );
  return true;
}

/* ================================================================
 * 五、入口 —— 导入模式
 * ================================================================ */

function parseName(file) {
  const base = path.basename(file, path.extname(file));
  const parts = base.split('_');
  const last = parts[parts.length - 1].toLowerCase();
  let state = null;
  if (IDLE_MARKS.some((m) => last.includes(m))) state = 'idle';
  else if (ACTIVE_MARKS.some((m) => last.includes(m))) state = 'active';
  if (!state) return null;
  const key = parts.length >= 2 ? parts[parts.length - 2] : '角色';
  return { key: key.trim(), state };
}

function collectInputs(argv) {
  const fromArgs = argv.filter((f) => {
    try {
      return fs.statSync(f).isFile() && IMAGE_EXT.includes(path.extname(f).toLowerCase());
    } catch (err) {
      return false;
    }
  });
  if (fromArgs.length) return { files: fromArgs, source: '命令行里指定的文件' };

  let entries = [];
  try {
    entries = fs.readdirSync(INBOX);
  } catch (err) {
    return { files: [], source: '待导入文件夹（不存在）' };
  }
  const files = entries
    .filter((name) => IMAGE_EXT.includes(path.extname(name).toLowerCase()))
    .map((name) => path.join(INBOX, name));
  return { files, source: `待导入文件夹（${files.length} 个文件）` };
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true });
}

function removeOldFrames(folder) {
  for (const name of [...IDLE_FILES, ...ACTIVE_FILES]) {
    const target = path.join(folder, name);
    try {
      if (fs.statSync(target).isFile()) fs.unlinkSync(target);
    } catch (err) {
      /* 不存在就算了 */
    }
  }
}

function runImport(argv) {
  const { files, source } = collectInputs(argv);

  console.log('');
  console.log(line());
  console.log('  角色素材导入 · 体检 · 自动对齐');
  console.log(line());
  console.log(`  来源：${source}`);
  console.log('');

  if (!files.length) {
    console.log('  没有找到任何图片。');
    console.log('');
    console.log('  把图片放进这个文件夹再双击「导入素材.bat」：');
    console.log(`    ${INBOX}`);
    console.log('');
    console.log('  文件名里要能看出哪张是平时的、哪张是点击的，例如：');
    console.log('    银狼_闭眼.png   银狼_睁眼.png');
    console.log('    华1_闭眼.png    华1_睁眼.png');
    console.log('');
    return;
  }

  const groups = new Map();
  const unparsed = [];
  for (const file of files) {
    const parsed = parseName(file);
    if (!parsed) {
      unparsed.push(path.basename(file));
      continue;
    }
    if (!groups.has(parsed.key)) groups.set(parsed.key, {});
    const slot = groups.get(parsed.key);
    if (slot[parsed.state]) {
      unparsed.push(`${path.basename(file)}（${parsed.key} 已经有一张${parsed.state === 'idle' ? '平时' : '点击'}图了）`);
      continue;
    }
    slot[parsed.state] = file;
  }

  if (unparsed.length) {
    console.log('  ⚠️  这些文件没能识别，跳过：');
    for (const name of unparsed) console.log(`       ${name}`);
    console.log('');
  }

  const keys = [...groups.keys()].sort(naturalCompare);
  const complete = [];
  for (const key of keys) {
    const slot = groups.get(key);
    if (slot.idle && slot.active) complete.push({ key, idle: slot.idle, active: slot.active });
    else {
      console.log(`  ⚠️  角色「${key}」只有一张图（缺 ${slot.idle ? '睁眼' : '闭眼'}），跳过。`);
      console.log('');
    }
  }

  if (!complete.length) {
    console.log('  ❌ 没有凑齐一对的（每个角色需要「闭眼」和「睁眼」各一张）。');
    console.log('');
    return;
  }

  console.log(line());
  console.log(`  开始处理 · ${complete.length} 个角色`);
  console.log(line());

  let problems = 0;

  complete.forEach((group, index) => {
    const folderName = `角色${index + 1}`;
    const folder = path.join(CHARS_DIR, folderName);

    console.log('');
    console.log(`  【${group.key}】 → assets/characters/${folderName}/`);
    console.log('');

    const idleInfo = analyse(group.idle);
    const activeInfo = analyse(group.active);
    const idleOk = reportImage('平时(闭眼)', idleInfo);
    const activeOk = reportImage('点击(睁眼)', activeInfo);
    if (!idleOk || !activeOk) problems++;

    try {
      fs.mkdirSync(folder, { recursive: true });
      removeOldFrames(folder);

      const idleExt = path.extname(group.idle).toLowerCase();
      const activeExt = path.extname(group.active).toLowerCase();

      fs.copyFileSync(group.idle, path.join(folder, `idle${idleExt}`));
      fs.copyFileSync(group.active, path.join(folder, `active${activeExt}`));
      fs.writeFileSync(path.join(folder, 'name.txt'), `${group.key}\n`, 'utf8');
    } catch (err) {
      console.log(`        ❌ 复制失败：${err.message}`);
      problems++;
      return;
    }

    // 复制完之后就开始对齐
    const idleFile = path.join(folder, `idle${path.extname(group.idle).toLowerCase()}`);
    const activeFile = path.join(folder, `active${path.extname(group.active).toLowerCase()}`);
    const aligned = alignAndReport(folder, idleFile, activeFile, true);
    if (!aligned) {
      console.log('        ⚠️  这一对没能自动对齐，点击时人物可能会抖一下。');
      problems++;
    }

    console.log(`        📁 已就位（右键菜单里显示「${group.key}」）`);
  });

  console.log('');
  console.log(line());
  if (problems === 0) {
    console.log('  🎉 全部通过，而且都对齐好了。双击「启动.bat」就能看到。');
  } else {
    console.log(`  ⚠️  有 ${problems} 处需要注意（上面标了 ❌ / ⚠️ 的地方）。`);
    console.log('     程序能跑，但这些问题会体现在显示效果上。');
  }
  console.log(line());
  console.log('');
}

/* ================================================================
 * 六、入口 —— 对齐模式（只处理已经导入好的角色）
 * ================================================================ */

function pickExisting(folder, names) {
  for (const name of names) {
    const full = path.join(folder, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch (err) {
      /* 继续找 */
    }
  }
  return null;
}

function runAlign(argv) {
  const only = argv.filter((a) => !a.startsWith('--'));

  console.log('');
  console.log(line());
  console.log('  角色素材 · 自动对齐');
  console.log(line());
  console.log('  （把「点击图」对齐到「平时图」上，原图备份到 _原始/）');
  console.log('');

  let entries = [];
  try {
    entries = fs.readdirSync(CHARS_DIR, { withFileTypes: true });
  } catch (err) {
    console.log(`  ❌ 找不到素材目录：${CHARS_DIR}`);
    console.log('');
    return;
  }

  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(naturalCompare);
  const targets = only.length ? folders.filter((f) => only.includes(f)) : folders;

  if (!targets.length) {
    console.log('  没有找到任何角色文件夹。');
    console.log('');
    return;
  }

  let fixed = 0;
  let failed = 0;

  for (const name of targets) {
    const folder = path.join(CHARS_DIR, name);
    const idleFile = pickExisting(folder, IDLE_FILES);
    const activeFile = pickExisting(folder, ACTIVE_FILES);

    console.log('');
    console.log(`  【${name}】`);
    console.log('');

    if (!idleFile || !activeFile) {
      console.log('        ⚠️  这个文件夹里没凑齐 idle / active 两张图，跳过。');
      continue;
    }

    let ok = false;
    try {
      ok = alignAndReport(folder, idleFile, activeFile, true);
    } catch (err) {
      console.log(`        ❌ 处理失败：${err.message}`);
    }
    if (ok) fixed++;
    else failed++;
  }

  console.log('');
  console.log(line());
  console.log(`  处理完成：OK ${fixed} 个，需要你手动看一下的 ${failed} 个。`);
  console.log('  改完记得重启桌宠（关掉黑窗口再双击 启动.bat）才会重新加载图片。');
  console.log(line());
  console.log('');
}

/* ================================================================
 * 启动
 * ================================================================ */

function main() {
  const argv = process.argv.slice(2);
  const alignMode = argv.includes('--align');
  const rest = argv.filter((a) => a !== '--align');

  if (alignMode) runAlign(rest);
  else runImport(rest);
}

try {
  main();
} catch (err) {
  console.log('');
  console.log(`  出错了：${err && err.message ? err.message : err}`);
  console.log('');
  console.log('  把上面的内容截图发我，我来看看是哪里不对。');
  console.log('');
  process.exitCode = 1;
}
