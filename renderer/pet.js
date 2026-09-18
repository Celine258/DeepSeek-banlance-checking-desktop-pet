'use strict';

/**
 * 桌宠界面逻辑。
 *
 * 三件事：
 *   1. 把主进程算好的角色轮廓掩码还原成一张位图，判断鼠标有没有压在角色身上；
 *      没压到就把鼠标「放过去」，不让这块透明窗口挡住桌面图标。
 *   2. 左键点角色 → 切到「睁眼邪笑」那张图 + 弹余额气泡（角色本身不动）。
 *   3. 拖动角色 = 拖动窗口。
 */

const api = window.petAPI;

const root = document.documentElement;
const charWrap = document.getElementById('char-wrap');
const imgIdle = document.getElementById('char-idle');
const imgActive = document.getElementById('char-active');
const bubble = document.getElementById('bubble');
const dot = document.getElementById('bubble-dot');
const elTitle = document.getElementById('bubble-title');
const elMain = document.getElementById('bubble-main');
const elSub = document.getElementById('bubble-sub');
const elFoot = document.getElementById('bubble-foot');

const HIDE_DELAY_MS = 6500; // 气泡自动消失的时间
const DRAG_THRESHOLD = 4; // 移动超过这么多像素才算拖拽，否则算点击
const IDLE_RESTORE_MS = 180; // 气泡消失后角色恢复平时表情的延迟

let cfg = { hasKey: false, bubblePersistent: false, clickThrough: true };
let mask = null; // { width, height, bytes: Uint8Array }
let charRect = { left: 0, top: 0, width: 0, height: 0 };

let characterId = null;
let ignoreState = null; // null = 还没同步过
let drag = null;
let hideTimer = null;
let restoreTimer = null;
let bubbleVisible = false;
let queryToken = 0;

/* ------------------------------------------------------------------ *
 * 与主进程同步
 * ------------------------------------------------------------------ */

function decodeMask(payload) {
  if (!payload || !payload.data || !payload.width || !payload.height) return null;
  try {
    const binary = atob(payload.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { width: payload.width, height: payload.height, bytes };
  } catch (err) {
    return null;
  }
}

function applyPayload(payload) {
  if (!payload) return;

  if (payload.config) {
    cfg = Object.assign({}, cfg, payload.config);
    ignoreState = null; // 让穿透开关按新配置重新同步一次
    if (bubbleVisible) scheduleHide();
  }

  if (payload.layout) {
    root.style.setProperty('--pad', `${payload.layout.pad}px`);
    root.style.setProperty('--bubble-w', `${payload.layout.bubbleW}px`);
    root.style.setProperty('--char-w', `${payload.layout.charW}px`);
    root.style.setProperty('--char-h', `${payload.layout.charH}px`);
  }

  if (payload.hitMask) mask = decodeMask(payload.hitMask);
  // 主进程算不出掩码时会给 null，这时候必须把旧角色的掩码清掉，
  // 否则新角色的穿透区域还是按上一个角色的轮廓在算
  else if (payload.hitMask === null) mask = null;

  if (payload.character && payload.character.id !== characterId) {
    characterId = payload.character.id;
    hideBubble({ instant: true });
    imgIdle.src = payload.character.idleUrl;
    imgActive.src = payload.character.activeUrl;
  }

  updateCharRect();
  resyncMousePassThrough();
}

function updateCharRect() {
  const rect = charWrap.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  charRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/* ------------------------------------------------------------------ *
 * 鼠标穿透
 * ------------------------------------------------------------------ */

function isOverCharacter(clientX, clientY) {
  const { left, top, width, height } = charRect;
  if (width <= 0 || height <= 0) return false;

  const u = (clientX - left) / width;
  const v = (clientY - top) / height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (!mask) return true; // 没有掩码数据时，整块角色区都当成可点

  const mx = Math.min(mask.width - 1, Math.floor(u * mask.width));
  const my = Math.min(mask.height - 1, Math.floor(v * mask.height));
  const bit = my * mask.width + mx;
  return ((mask.bytes[bit >> 3] >> (bit & 7)) & 1) === 1;
}

function setIgnore(next) {
  if (ignoreState === next) return;
  ignoreState = next;
  api.setIgnoreMouse(next);
}

function syncMousePassThrough(clientX, clientY) {
  if (drag) {
    setIgnore(false);
    return;
  }
  if (!cfg.clickThrough) {
    setIgnore(false);
    return;
  }
  setIgnore(!isOverCharacter(clientX, clientY));
}

let lastPointer = { x: 0, y: 0 };

document.addEventListener('mousemove', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY };
  syncMousePassThrough(event.clientX, event.clientY);
});

// forward: true 会让 mouseleave 也能收到，鼠标完全离开窗口时恢复穿透
document.addEventListener('mouseleave', () => {
  if (!drag) setIgnore(true);
});

/** 改配置或换角色时鼠标可能一动不动，用最后已知的坐标再同步一次 */
function resyncMousePassThrough() {
  syncMousePassThrough(lastPointer.x, lastPointer.y);
}

/* ------------------------------------------------------------------ *
 * 拖动 / 点击
 * ------------------------------------------------------------------ */

charWrap.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();

  drag = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    lastScreenX: event.screenX,
    lastScreenY: event.screenY,
    windowX: window.screenX,
    windowY: window.screenY,
    distance: 0,
    moved: false
  };

  try {
    charWrap.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 拿不到捕获也无所谓 */
  }

  charWrap.classList.add('is-dragging');
  setIgnore(false);
});

charWrap.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;

  const dx = event.screenX - drag.startScreenX;
  const dy = event.screenY - drag.startScreenY;

  // 鼠标没动就什么都不做。窗口自己在动的时候，系统可能补发一批
  // screenX 不变的事件，之前这些事件会把窗口一直往右下角推。
  if (event.screenX === drag.lastScreenX && event.screenY === drag.lastScreenY) return;
  drag.lastScreenX = event.screenX;
  drag.lastScreenY = event.screenY;

  drag.distance = Math.max(drag.distance, Math.hypot(dx, dy));
  if (!drag.moved && drag.distance > DRAG_THRESHOLD) drag.moved = true;

  if (drag.moved) {
    api.moveWindow(drag.windowX + dx, drag.windowY + dy);
  }
});

function endDrag(event) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;

  const wasDragging = drag.moved;
  drag = null;
  charWrap.classList.remove('is-dragging');

  try {
    charWrap.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* 已经释放过了 */
  }

  if (wasDragging) {
    api.savePosition();
    return;
  }

  // 没怎么动 → 当成一次点击
  if (!event || event.button === 0) onCharacterClick();
}

charWrap.addEventListener('pointerup', endDrag);
charWrap.addEventListener('pointercancel', (event) => {
  if (!drag) return;
  drag = null;
  charWrap.classList.remove('is-dragging');
  if (event && event.pointerId !== undefined) {
    try {
      charWrap.releasePointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
  }
});

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!isOverCharacter(event.clientX, event.clientY)) return;
  api.openContextMenu();
});

/* ------------------------------------------------------------------ *
 * 点击 → 睁眼邪笑 + 余额气泡
 * ------------------------------------------------------------------ */

function setActive(active) {
  charWrap.classList.toggle('is-active', !!active);
}

function onCharacterClick() {
  setActive(true);
  showBubble();
  queryBalance();
}

function showBubble() {
  clearTimeout(hideTimer);
  clearTimeout(restoreTimer);
  bubbleVisible = true;
  bubble.classList.add('is-visible');
  bubble.setAttribute('aria-hidden', 'false');
  scheduleHide();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (cfg.bubblePersistent) return;
  hideTimer = setTimeout(() => hideBubble(), HIDE_DELAY_MS);
}

function hideBubble(options) {
  const instant = !!(options && options.instant);
  clearTimeout(hideTimer);
  clearTimeout(restoreTimer);

  const wasVisible = bubbleVisible;
  bubbleVisible = false;
  bubble.classList.remove('is-visible');
  bubble.setAttribute('aria-hidden', 'true');

  if (instant) {
    setActive(false);
    return;
  }
  if (wasVisible) {
    restoreTimer = setTimeout(() => {
      if (!bubbleVisible) setActive(false);
    }, IDLE_RESTORE_MS);
  }
}

/* ------------------------------------------------------------------ *
 * 气泡内容
 * ------------------------------------------------------------------ */

function setDot(kind) {
  dot.className = 'dot';
  if (kind === 'warn') dot.classList.add('is-warn');
  else if (kind === 'ok') dot.classList.add('is-ok');
}

function setMainPlain(text, { error = false } = {}) {
  elMain.className = `bubble-main is-plain${error ? ' is-error' : ''}`;
  elMain.textContent = text;
}

function setMainAmount(symbol, amount) {
  elMain.className = 'bubble-main';
  elMain.textContent = '';
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = symbol;
  const value = document.createTextNode(amount);
  elMain.appendChild(unit);
  elMain.appendChild(value);
}

function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTime(timestamp) {
  const d = new Date(Number(timestamp) || Date.now());
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderLoading() {
  setDot('ok');
  elTitle.textContent = 'DeepSeek 余额';
  setMainPlain('正在查询…');
  elSub.textContent = '';
  elFoot.textContent = '';
}

function renderBalance(data) {
  const symbol = data.currency === 'USD' ? '$' : '¥';
  const total = Number(data.total);
  const low = Number.isFinite(total) && total <= 1;

  setDot(data.isAvailable && !low ? 'ok' : 'warn');
  elTitle.textContent = 'DeepSeek 余额';

  setMainAmount(symbol, formatAmount(data.total));

  const parts = [];
  if (Number(data.granted) > 0) parts.push(`赠金 ${symbol}${formatAmount(data.granted)}`);
  if (Number(data.toppedUp) > 0) parts.push(`充值 ${symbol}${formatAmount(data.toppedUp)}`);
  if (!data.isAvailable) parts.push('余额不足，接口调用会被拒绝');
  elSub.textContent = parts.join(' · ');

  elFoot.textContent = `更新于 ${formatTime(data.at)}`;
}

/** 查不到余额时统一用这个：主文案说清楚发生了什么，副文案说怎么解决 */
function renderNotice(message, { sub = '', error = false } = {}) {
  setDot('warn');
  elTitle.textContent = 'DeepSeek 余额';
  setMainPlain(message, { error });
  elSub.textContent = sub;
  elFoot.textContent = '';
}

async function queryBalance() {
  const token = ++queryToken;

  if (!cfg.hasKey) {
    renderNotice('还没填 API Key', { sub: '右键角色 → 设置 API Key' });
    scheduleHide();
    return;
  }

  // 查询期间先别自动收起 —— 网络慢的时候请求可能要十几秒，
  // 气泡要是中途收了，结果回来就只是往一个已经藏起来的框里写字，等于什么都看不到
  clearTimeout(hideTimer);
  renderLoading();

  let result = null;
  try {
    result = await api.queryBalance();
  } catch (err) {
    result = null;
  }
  if (token !== queryToken) return;

  // 兜底：万一中间被收起来了（比如查询期间切了角色），把气泡重新亮出来
  if (!bubbleVisible) {
    bubbleVisible = true;
    bubble.classList.add('is-visible');
    bubble.setAttribute('aria-hidden', 'false');
    setActive(true);
  }

  if (!result) {
    renderNotice('主进程没有响应', { error: true, sub: '再点一次试试' });
  } else if (result.ok) {
    renderBalance(result.data);
  } else {
    renderNotice(result.message || '查询失败', { error: true, sub: result.hint || '' });
  }

  scheduleHide();
}

/* ------------------------------------------------------------------ *
 * 主进程推来的消息
 * ------------------------------------------------------------------ */

api.on('pet:character', applyPayload);

api.on('pet:config', (payload) => {
  if (!payload) return;
  cfg = Object.assign({}, cfg, payload);
  ignoreState = null;
  if (bubbleVisible) scheduleHide();
  resyncMousePassThrough();
});

api.on('pet:bubble-refresh', () => {
  setActive(true);
  showBubble();
  queryBalance();
});

window.addEventListener('resize', updateCharRect);

function boot() {
  updateCharRect();
  api.ready();
}

if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);
