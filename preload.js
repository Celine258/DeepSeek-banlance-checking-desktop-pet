'use strict';

/**
 * 渲染进程 ↔ 主进程的唯一通道。
 * contextIsolation 开着，渲染进程只能看到这里白名单里的方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  /** 渲染进程准备好接收角色数据了 */
  ready: () => ipcRenderer.send('pet:ready'),

  /** 切换角色（右键菜单选的） */
  selectCharacter: (id) => ipcRenderer.send('pet:select-character', id),

  /** 查询余额，返回 { ok, data } 或 { ok:false, code, message, hint } */
  queryBalance: () => ipcRenderer.invoke('pet:query-balance'),

  /** 鼠标穿透开关：true = 不拦截鼠标事件 */
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', !!ignore),

  /** 拖动窗口到屏幕坐标 */
  moveWindow: (x, y) => ipcRenderer.send('pet:move-window', { x, y }),

  /** 拖动结束，记一下位置 */
  savePosition: () => ipcRenderer.send('pet:save-position'),

  /** 弹出右键菜单 */
  openContextMenu: () => ipcRenderer.send('pet:context-menu'),

  /** 打开设置窗口 */
  openSettings: () => ipcRenderer.send('pet:open-settings'),

  /** 退出程序 */
  quit: () => ipcRenderer.send('pet:quit'),

  /** 订阅主进程推来的消息 */
  on: (channel, handler) => {
    const allowed = ['pet:character', 'pet:config', 'pet:bubble-refresh'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});

/* ---------- 设置窗口专用的通道 ---------- */

contextBridge.exposeInMainWorld('settingsAPI', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (payload) => ipcRenderer.invoke('settings:save', payload),
  test: (apiKey) => ipcRenderer.invoke('settings:test', apiKey),
  openKeyPage: () => ipcRenderer.send('settings:open-key-page'),
  close: () => ipcRenderer.send('settings:close')
});
