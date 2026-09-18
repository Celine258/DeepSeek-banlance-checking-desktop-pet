'use strict';

/**
 * 角色轮廓掩码。
 *
 * 干嘛用的：桌宠窗口是一整块透明区域，如果不做处理，角色旁边那一大片
 * 「看不见的窗口」会挡住桌面图标。所以要把角色每一帧的不透明区域压成
 * 一张小小的位图，界面拿到之后就能判断「鼠标现在是不是压在角色身上」，
 * 是的话就正常接收点击，不是的话就让鼠标穿过去。
 *
 * 为什么放在主进程算：file:// 页面把本地图片画进 canvas 之后会被浏览器
 * 当成「跨源污染」，getImageData 会直接抛错。主进程用 nativeImage 读像素
 * 没有这个限制。
 *
 * 只需要 alpha 通道，所以不用管 BGRA / RGBA 的通道顺序差异。
 */

const MAX_EDGE = 128; // 掩码最长边最多 128 像素，够用了
const ALPHA_THRESHOLD = 100; // 低于这个透明度的像素算「半透明/透明」，一律让鼠标穿过去

/**
 * @param {Array<import('electron').NativeImage>} images 同一个角色的所有帧
 * @returns {{width: number, height: number, data: string} | null} data 是 base64 的位图
 */
function buildHitMask(images) {
  const masks = [];
  let baseWidth = 0;
  let baseHeight = 0;

  for (const img of images) {
    if (!img || img.isEmpty()) continue;

    const size = img.getSize();
    if (!size.width || !size.height) continue;

    const shrink = Math.min(1, MAX_EDGE / Math.max(size.width, size.height));
    const w = Math.max(1, Math.round(size.width * shrink));
    const h = Math.max(1, Math.round(size.height * shrink));

    let small = img;
    if (w !== size.width || h !== size.height) {
      small = img.resize({ width: w, height: h, quality: 'good' });
    }

    const bitmap = small.toBitmap();
    // 必须严格相等。图片文件名带 @2x 之类时，getSize() 给的是 1x 尺寸、
    // toBitmap() 给的是 2x 像素，这时候宁可放弃掩码也不能拿错位的像素去算。
    if (bitmap.length !== w * h * 4) continue;

    const bits = new Uint8Array(Math.ceil((w * h) / 8));
    let hasOpaque = false;
    for (let i = 0; i < w * h; i++) {
      if (bitmap[i * 4 + 3] > ALPHA_THRESHOLD) {
        bits[i >> 3] |= 1 << (i & 7);
        hasOpaque = true;
      }
    }
    if (!hasOpaque) continue;

    if (!baseWidth) {
      baseWidth = w;
      baseHeight = h;
    }
    masks.push({ w, h, bits });
  }

  if (!masks.length) return null;

  // 每一帧的轮廓取并集，这样「平时」和「点击」两种姿势都能点到
  const merged = masks[0].bits;
  for (let k = 1; k < masks.length; k++) {
    const m = masks[k];
    if (m.w !== masks[0].w || m.h !== masks[0].h) continue;
    for (let i = 0; i < merged.length; i++) merged[i] |= m.bits[i];
  }

  return {
    width: masks[0].w,
    height: masks[0].h,
    data: Buffer.from(merged).toString('base64')
  };
}

module.exports = { buildHitMask };
