'use strict';

/**
 * 配置读写。
 * 存在 Electron 的 userData 目录里（Windows 上大致是
 * C:\Users\<你>\AppData\Roaming\deepseek-pet\config.json），
 * 不放在项目目录里，这样以后打包成 exe 也不会写不进只读目录。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  apiKey: '',
  characterId: '',
  size: 'medium', // small | medium | large
  alwaysOnTop: true,
  clickThrough: true, // 角色以外的透明区域不挡鼠标
  autoLaunch: false,
  bubblePersistent: false, // 气泡常显（不自动消失）
  position: null, // { x, y }
  lastBalance: null // { currency, total, granted, toppedUp, isAvailable, at }
};

let cache = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) cache[key] = parsed[key];
      }
    }
  } catch (err) {
    // 第一次运行没有配置文件，或者文件坏了 —— 都直接用默认值
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  const cfg = load();
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[config] 写入失败：', err);
    return false;
  }
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  save();
}

module.exports = { DEFAULTS, load, save, get, set, configPath };
