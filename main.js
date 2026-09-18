'use strict';

/**
 * DeepSeek 余额桌宠 —— 主进程
 *
 * 干了这些事：
 *   1. 创建一个透明、无边框、可置顶的窗口，里面站着角色；
 *   2. 角色以外的透明区域让鼠标「穿过去」，不挡桌面图标；
 *   3. 左键点角色 → 通知界面换成「睁眼邪笑」那一帧 + 弹余额气泡；
 *   4. 右键点角色 → 原生菜单：换角色 / 换大小 / 设置 API Key / 退出；
 *   5. 余额请求在主进程发起（不受跨域限制），Key 只存在本地配置文件里。
 */

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');

const config = require('./lib/config');
const characters = require('./lib/characters');
const { fetchBalance } = require('./lib/deepseek');
const { buildHitMask } = require('./lib/hitmask');
const { makeTrayIcon, makePlaceholderCharacter } = require('./lib/png');

/** 版面常量：窗口 = [气泡区 | 间隙 | 角色区] 横向排列，角色贴着右下角 */
const LAYOUT = {
  pad: 16, // 四周留白
  gap: 44, // 气泡和角色之间的横向间隙
  bubbleWidth: 352, // 气泡最大宽度
  baseCharHeight: 460 // 中等尺寸下角色的显示高度
};

const SCALES = { small: 0.72, medium: 1, large: 1.34 };
const VALID_SIZES = ['small', 'medium', 'large'];

let petWindow = null;
let settingsWindow = null;
let tray = null;
let placeholderCharacter = null;
let currentCharacter = null;
let currentLayout = null;

/* ------------------------------------------------------------------ *
 * 尺寸计算
 * ------------------------------------------------------------------ */

function currentScale() {
  const size = config.get('size');
  return SCALES[VALID_SIZES.includes(size) ? size : 'medium'];
}

function computeLayout(naturalWidth, naturalHeight, scale) {
  const charH = Math.max(80, Math.round(LAYOUT.baseCharHeight * scale));
  const ratio = naturalHeight > 0 ? naturalWidth / naturalHeight : 2 / 3;
  const charW = Math.max(40, Math.round(charH * ratio));
  return {
    charH,
    charW,
    bubbleW: LAYOUT.bubbleWidth,
    gap: LAYOUT.gap,
    pad: LAYOUT.pad,
    winW: LAYOUT.pad * 2 + LAYOUT.bubbleWidth + LAYOUT.gap + charW,
    winH: LAYOUT.pad * 2 + charH
  };
}

/** 把窗口位置挪到「角色完整可见」的范围里 */
function clampToDisplays(x, y, layout) {
  const point = { x: Math.round(x + layout.winW / 2), y: Math.round(y + layout.winH / 2) };
  const area = screen.getDisplayNearestPoint(point).workArea;

  const charRight = x + layout.winW - LAYOUT.pad;
  const charLeft = charRight - layout.charW;
  const charBottom = y + layout.winH - LAYOUT.pad;
  const charTop = charBottom - layout.charH;

  if (charRight > area.x + area.width) x -= charRight - (area.x + area.width);
  if (charLeft < area.x) x += area.x - charLeft;
  if (charBottom > area.y + area.height) y -= charBottom - (area.y + area.height);
  if (charTop < area.y) y += area.y - charTop;

  return { x: Math.round(x), y: Math.round(y) };
}

/* ------------------------------------------------------------------ *
 * 角色
 * ------------------------------------------------------------------ */

/** 一份也没有素材时用的占位角色（闭眼 / 睁眼邪笑两帧，方便你先看到效果） */
function getPlaceholderCharacter() {
  if (placeholderCharacter) return placeholderCharacter;

  const idle = makePlaceholderCharacter(400, 600, { eyes: 'closed' });
  const active = makePlaceholderCharacter(400, 600, { eyes: 'open' });
  const idleImage = nativeImage.createFromBuffer(idle.buffer);
  const activeImage = nativeImage.createFromBuffer(active.buffer);

  placeholderCharacter = {
    id: '__placeholder__',
    name: '占位图（把素材放进 assets/characters 就自动替换）',
    idleUrl: idleImage.toDataURL(),
    activeUrl: activeImage.toDataURL(),
    idleImage,
    activeImage,
    width: idle.width,
    height: idle.height,
    icon: null
  };
  return placeholderCharacter;
}

function hasRealCharacters() {
  return characters.list().length > 0;
}

function availableCharacters() {
  const found = characters.list();
  return found.length ? found : [getPlaceholderCharacter()];
}

function resolveCharacter(id) {
  const all = availableCharacters();
  return all.find((item) => item.id === id) || all[0];
}

function publicConfig() {
  const cfg = config.load();
  return {
    hasKey: !!cfg.apiKey,
    bubblePersistent: !!cfg.bubblePersistent,
    clickThrough: !!cfg.clickThrough,
    size: cfg.size,
    alwaysOnTop: !!cfg.alwaysOnTop,
    autoLaunch: !!cfg.autoLaunch,
    lastBalance: cfg.lastBalance || null
  };
}

/** 角色轮廓掩码只算一次，之后直接复用 */
const maskCache = new WeakMap();

function ensureHitMask(character) {
  if (!character) return null;
  if (maskCache.has(character)) return maskCache.get(character);
  let mask = null;
  try {
    mask = buildHitMask([character.idleImage, character.activeImage]);
  } catch (err) {
    console.error('[hitmask] 生成失败：', err);
    mask = null;
  }
  maskCache.set(character, mask);
  return mask;
}

function sendCharacter() {
  if (!petWindow || petWindow.isDestroyed() || !currentCharacter) return;
  petWindow.webContents.send('pet:character', {
    character: {
      id: currentCharacter.id,
      name: currentCharacter.name,
      idleUrl: currentCharacter.idleUrl,
      activeUrl: currentCharacter.activeUrl
    },
    layout: currentLayout,
    hitMask: ensureHitMask(currentCharacter),
    config: publicConfig()
  });
}

function sendConfig() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send('pet:config', publicConfig());
}

/** 角色变了或者尺寸变了，重新算窗口大小（保持角色右下角不动） */
function applyLayout() {
  const layout = computeLayout(currentCharacter.width, currentCharacter.height, currentScale());
  currentLayout = layout;
  if (!petWindow || petWindow.isDestroyed()) return;

  const bounds = petWindow.getBounds();
  const pos = clampToDisplays(
    bounds.x + (bounds.width - layout.winW),
    bounds.y + (bounds.height - layout.winH),
    layout
  );

  // 窗口是可 resizable 的（见 createPetWindow 里的说明），所以 setBounds 直接生效，
  // 不需要再临时切来切去 —— 那个操作本身还会引入新问题
  petWindow.setBounds({ x: pos.x, y: pos.y, width: layout.winW, height: layout.winH });
}

function setCharacter(id, { persist = true } = {}) {
  const next = resolveCharacter(id);
  if (!next) return;
  currentCharacter = next;
  if (persist) config.set('characterId', next.id);
  applyLayout();
  sendCharacter();
}

function setSize(size) {
  if (!VALID_SIZES.includes(size)) return;
  config.set('size', size);
  applyLayout();
  sendCharacter();
}

/* ------------------------------------------------------------------ *
 * 主窗口
 * ------------------------------------------------------------------ */

function createPetWindow() {
  currentCharacter = resolveCharacter(config.get('characterId'));
  currentLayout = computeLayout(currentCharacter.width, currentCharacter.height, currentScale());

  const workArea = screen.getPrimaryDisplay().workArea;
  const saved = config.get('position');
  let x = workArea.x + workArea.width - currentLayout.winW - 40;
  let y = workArea.y + workArea.height - currentLayout.winH - 24;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    x = saved.x;
    y = saved.y;
  }
  const pos = clampToDisplays(x, y, currentLayout);

  petWindow = new BrowserWindow({
    width: currentLayout.winW,
    height: currentLayout.winH,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 这里必须是 true。Windows 上 resizable:false 的窗口在移动时尺寸会被系统
    // 悄悄改掉（electron#13043），而角色是贴着窗口右下角站的 —— 窗口一大，
    // 角色就会自己往右下角滑。thickFrame:false 保证用户依然拖不动窗口边框。
    resizable: true,
    thickFrame: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: !!config.get('alwaysOnTop'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  petWindow.setMenuBarVisibility(false);
  petWindow.setMenu(null); // 连 Ctrl+W / Ctrl+R 这些默认快捷键一起干掉，否则角色会被关掉
  petWindow.setAlwaysOnTop(!!config.get('alwaysOnTop'));

  // 只允许「退出」真正关窗口，其余情况一律收起来 —— 否则托盘就叫不回来了
  petWindow.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    petWindow.hide();
  });

  petWindow.on('closed', () => {
    petWindow = null;
  });

  petWindow.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  petWindow.once('ready-to-show', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.show();
  });

  return petWindow;
}

/** 把角色叫回屏幕。窗口被关掉了就重新建一个 —— 托盘和快捷键都走这里 */
function showPet() {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
    return;
  }
  petWindow.show();
  petWindow.focus();
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

function buildContextMenu() {
  const cfg = config.load();
  const all = availableCharacters();
  const currentId = currentCharacter ? currentCharacter.id : '';
  const real = hasRealCharacters();

  const characterItems = all.map((item) => ({
    label: item.name,
    type: 'radio',
    checked: item.id === currentId,
    icon: item.icon || undefined,
    click: () => setCharacter(item.id)
  }));

  if (!real) {
    characterItems.push(
      { type: 'separator' },
      { label: '还没有角色素材，点这里打开素材文件夹', click: () => shell.openPath(characters.charactersDir()) }
    );
  }

  return Menu.buildFromTemplate([
    { label: currentCharacter ? `当前角色：${currentCharacter.name}` : 'DeepSeek 余额桌宠', enabled: false },
    { type: 'separator' },
    ...characterItems,
    { type: 'separator' },
    {
      label: cfg.apiKey ? '刷新余额' : '设置 API Key 后就能显示余额',
      click: () => {
        if (!cfg.apiKey) {
          openSettings();
          return;
        }
        if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:bubble-refresh');
      }
    },
    {
      label: '气泡常显（不自动消失）',
      type: 'checkbox',
      checked: !!cfg.bubblePersistent,
      click: (item) => {
        config.set('bubblePersistent', item.checked);
        sendConfig();
      }
    },
    { type: 'separator' },
    {
      label: '大小',
      submenu: [
        { label: '小', type: 'radio', checked: cfg.size === 'small', click: () => setSize('small') },
        { label: '中', type: 'radio', checked: cfg.size === 'medium', click: () => setSize('medium') },
        { label: '大', type: 'radio', checked: cfg.size === 'large', click: () => setSize('large') }
      ]
    },
    {
      label: '总是显示在最前面',
      type: 'checkbox',
      checked: !!cfg.alwaysOnTop,
      click: (item) => {
        config.set('alwaysOnTop', item.checked);
        if (petWindow && !petWindow.isDestroyed()) petWindow.setAlwaysOnTop(item.checked);
      }
    },
    {
      label: '透明区域不挡鼠标',
      type: 'checkbox',
      checked: !!cfg.clickThrough,
      click: (item) => {
        config.set('clickThrough', item.checked);
        if (!item.checked && petWindow && !petWindow.isDestroyed()) petWindow.setIgnoreMouseEvents(false);
        sendConfig();
      }
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!cfg.autoLaunch,
      click: (item) => setAutoLaunch(item.checked)
    },
    { type: 'separator' },
    { label: '设置 API Key…', click: () => openSettings() },
    { label: '打开素材文件夹', click: () => shell.openPath(characters.charactersDir()) },
    { label: '打开配置文件', click: () => shell.showItemInFolder(config.configPath()) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function popupContextMenu() {
  const menu = buildContextMenu();
  menu.popup({ window: petWindow && !petWindow.isDestroyed() ? petWindow : undefined });
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function createTray() {
  let icon;
  try {
    // 32×32 的位图配 scaleFactor 2，等于 16 逻辑像素 —— Windows 托盘的标准尺寸，
    // 高分屏上也能保持清晰
    icon = nativeImage.createFromBuffer(makeTrayIcon(32), { width: 32, height: 32, scaleFactor: 2 });
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch (err) {
    console.error('[tray] 生成图标失败：', err);
    icon = nativeImage.createEmpty();
  }

  try {
    tray = new Tray(icon);
  } catch (err) {
    console.error('[tray] 创建托盘失败：', err);
    tray = null;
    return;
  }

  tray.setToolTip('DeepSeek 余额桌宠');
  tray.on('click', () => showPet());

  const menu = Menu.buildFromTemplate([
    { label: '显示桌宠', click: () => showPet() },
    {
      label: '刷新余额',
      click: () => {
        if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:bubble-refresh');
      }
    },
    { label: '设置 API Key…', click: () => openSettings() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

/* ------------------------------------------------------------------ *
 * 设置窗口
 * ------------------------------------------------------------------ */

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 420,
    title: 'DeepSeek 桌宠 · 设置',
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true, // 桌宠本身是置顶的，设置窗得压在它上面
    backgroundColor: '#F5F6FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
    }
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

/* ------------------------------------------------------------------ *
 * 开机自启
 * ------------------------------------------------------------------ */

function setAutoLaunch(enabled) {
  config.set('autoLaunch', enabled);
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()]
    });
  } catch (err) {
    console.error('[autoLaunch] 设置失败：', err);
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.on('pet:ready', () => {
    sendCharacter();
    if (config.get('clickThrough') && petWindow && !petWindow.isDestroyed()) {
      petWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // 只管照着界面说的做，不在这里自作主张改状态 —— 否则两边各记一份状态，迟早对不上。
  // forward 只在 ignore=true 时有意义，false 时 Electron 会忽略它。
  ipcMain.on('pet:set-ignore-mouse', (_event, ignore) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    petWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.on('pet:move-window', (_event, payload) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const x = Math.round(Number(payload && payload.x));
    const y = Math.round(Number(payload && payload.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    petWindow.setPosition(x, y, false);

    // 保险：万一系统在移动时把窗口尺寸改了，角色会自己漂走（角色贴的是右下角），
    // 发现尺寸不对立刻还原。正常情况下这里永远不会触发。
    if (currentLayout) {
      const bounds = petWindow.getBounds();
      if (bounds.width !== currentLayout.winW || bounds.height !== currentLayout.winH) {
        petWindow.setBounds({ x, y, width: currentLayout.winW, height: currentLayout.winH });
      }
    }
  });

  ipcMain.on('pet:save-position', () => {
    if (!petWindow || petWindow.isDestroyed() || !currentLayout) return;
    const bounds = petWindow.getBounds();
    // 存之前先夹一下，免得角色被拖到屏幕外面、下次启动找不着
    const pos = clampToDisplays(bounds.x, bounds.y, currentLayout);
    if (pos.x !== bounds.x || pos.y !== bounds.y) petWindow.setPosition(pos.x, pos.y, false);
    config.set('position', pos);
  });

  ipcMain.on('pet:context-menu', () => popupContextMenu());

  ipcMain.on('pet:select-character', (_event, id) => setCharacter(id));

  ipcMain.on('pet:open-settings', () => openSettings());

  ipcMain.on('pet:quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.handle('pet:query-balance', async () => {
    const result = await fetchBalance(config.get('apiKey'));
    if (result.ok) config.set('lastBalance', result.data);
    return result;
  });

  /* ---- 设置窗口 ---- */

  ipcMain.handle('settings:load', (event) => {
    const configPath = config.configPath();
    // API Key 只发给设置窗口自己。桌宠那个页面虽然挂着同一份 preload，
    // 但拿不到 Key —— 万一界面被注入了也偷不走。
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents) {
      return { apiKey: '', configPath };
    }
    return { apiKey: config.get('apiKey') || '', configPath };
  });

  ipcMain.handle('settings:save', (_event, payload) => {
    const key = String((payload && payload.apiKey) || '').trim();
    config.set('apiKey', key);
    sendConfig();
    if (key && petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:bubble-refresh');
    }
    return { ok: true, hasKey: !!key };
  });

  ipcMain.handle('settings:test', async (_event, apiKey) => {
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : config.get('apiKey');
    return fetchBalance(key);
  });

  ipcMain.on('settings:open-key-page', () => {
    shell.openExternal('https://platform.deepseek.com/api_keys');
  });

  ipcMain.on('settings:close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function onReady() {
  app.setAppUserModelId('com.celine.deepseekpet');
  config.load();

  // 以系统里记录的真实状态为准，避免配置文件和实际不一致
  try {
    config.set('autoLaunch', !!app.getLoginItemSettings().openAtLogin);
  } catch (err) {
    /* 读不到就算了 */
  }

  registerIpc();
  createTray();
  createPetWindow();

  app.on('activate', () => {
    if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPet();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  // 关了窗口也不退出 —— 托盘还要常驻
  app.on('window-all-closed', () => {});

  app.whenReady().then(onReady);
}
