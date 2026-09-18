'use strict';

/**
 * 角色素材扫描。
 *
 * 目录结构：
 *   assets/characters/<任意文件夹名>/
 *       idle.png     ← 平时状态（闭眼 / 平静）
 *       active.png   ← 点击状态（睁眼 + 邪笑）
 *       name.txt     ← 可选，第一行是显示在右键菜单里的名字
 *
 * 想加角色就往这个目录里丢文件夹，右键菜单会自动多一项，不用重启。
 */

const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');
const { pathToFileURL } = require('url');

const IDLE_NAMES = ['idle.png', 'idle.webp', '平时.png', '平时.webp', '普通.png'];
const ACTIVE_NAMES = ['active.png', 'active.webp', '点击.png', '点击.webp', '睁眼.png', '邪笑.png'];

function charactersDir() {
  // 打包成 exe 之后，素材放在 exe 旁边的 resources/assets 里，方便用户往里丢图
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', 'characters');
  return path.join(__dirname, '..', 'assets', 'characters');
}

/**
 * 只看 PNG 文件头，判断这张图到底有没有透明通道。
 * IHDR 里的 colorType：0=灰度 2=RGB 3=调色板 4=灰度+透明 6=RGBA
 * 只有 4 和 6 是自带透明通道的。返回 null 表示不是 PNG 或读不出来。
 */
function pngHasAlpha(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(26);
    const read = fs.readSync(fd, head, 0, 26, 0);
    if (read < 26) return null;
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    const colorType = head[25];
    return colorType === 4 || colorType === 6;
  } catch (err) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        /* ignore */
      }
    }
  }
}

const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function pickFile(dir, candidates) {
  for (const name of candidates) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch (err) {
      /* 不存在就继续找下一个 */
    }
  }
  return null;
}

function readDisplayName(dir, fallback) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'name.txt'), 'utf8');
    const first = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first.slice(0, 24);
  } catch (err) {
    /* 没有 name.txt 就用文件夹名 */
  }
  return fallback;
}

/** 读一张图，失败返回 null */
function safeImage(file) {
  if (!file) return null;
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    if (!size.width || !size.height) return null;
    return img;
  } catch (err) {
    return null;
  }
}

let cache = { at: 0, data: [] };
const CACHE_MS = 2000;

/**
 * 列出所有可用角色。结果缓存 2 秒，这样右键菜单里刚丢进去的素材
 * 几乎立刻就能看到，又不会每次点右键都把图片重新读一遍。
 * @returns {Array<{id, name, idleUrl, activeUrl, idleImage, activeImage, width, height, icon}>}
 */
function list() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.data;
  const data = scan();
  cache = { at: now, data };
  return data;
}

function scan() {
  const dir = charactersDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    const idlePath = pickFile(folder, IDLE_NAMES);
    if (!idlePath) continue;
    const idleImage = safeImage(idlePath);
    if (!idleImage) continue;
    const size = idleImage.getSize();
    const activePath = pickFile(folder, ACTIVE_NAMES) || idlePath;
    const activeImage = safeImage(activePath) || idleImage;

    // 两个最容易踩的坑，启动时就在控制台说一声
    if (path.extname(idlePath).toLowerCase() === '.png' && pngHasAlpha(idlePath) === false) {
      warnOnce(
        `${entry.name}:alpha`,
        `[素材] ${entry.name}/ 的 PNG 没有透明通道（是白底图），角色周围会带一块白底。需要重新导出成带透明度的 PNG。`
      );
    }
    const activeSize = activeImage.getSize();
    if (activePath !== idlePath && (activeSize.width !== size.width || activeSize.height !== size.height)) {
      warnOnce(
        `${entry.name}:size`,
        `[素材] ${entry.name}/ 两张图尺寸不一致（${size.width}×${size.height} vs ${activeSize.width}×${activeSize.height}），点击时角色会整体位移。`
      );
    }

    let icon = null;
    try {
      icon = idleImage.resize({ height: 16 });
    } catch (err) {
      icon = null;
    }

    result.push({
      id: entry.name,
      name: readDisplayName(folder, entry.name),
      idleUrl: pathToFileURL(idlePath).href,
      activeUrl: pathToFileURL(activePath).href,
      idleImage,
      activeImage,
      width: size.width,
      height: size.height,
      icon
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return result;
}

function get(id) {
  if (!id) return null;
  return list().find((item) => item.id === id) || null;
}

module.exports = { list, get, charactersDir };
