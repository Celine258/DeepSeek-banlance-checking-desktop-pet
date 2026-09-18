'use strict';

/**
 * DeepSeek 余额查询。
 *
 * 官方接口：GET https://api.deepseek.com/user/balance
 * 请求头：  Authorization: Bearer <API Key>
 * 返回：    { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 * 注意金额都是字符串。
 *
 * 这个请求放在主进程里发，不走浏览器，所以没有跨域问题。
 */

const { net } = require('electron');

const ENDPOINT = 'https://api.deepseek.com/user/balance';

function safeSlice(text, n) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, n);
}

function timeoutError() {
  const err = new Error('请求超时');
  err.name = 'AbortError';
  return err;
}

/**
 * 用 Electron 的 net 而不是 Node 的全局 fetch —— net 走 Chromium 网络栈，
 * 会读系统的代理设置。用 Node 的 fetch 的话，挂了代理的用户会直接连不上。
 * net 只能在 app ready 之后用，这里是 IPC 回调，满足条件。
 *
 * @returns {Promise<{ok: true, data: object} | {ok: false, code: string, message: string, hint?: string}>}
 */
async function fetchBalance(apiKey, timeoutMs = 15000) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) {
    return {
      ok: false,
      code: 'NO_KEY',
      message: '还没填 API Key',
      hint: '右键角色 → 设置 API Key'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = new Promise((_, reject) => {
    setTimeout(() => reject(timeoutError()), timeoutMs);
  });

  try {
    const res = await Promise.race([
      net.fetch(ENDPOINT, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`
        },
        signal: controller.signal
      }),
      deadline
    ]);

    if (res.status === 401) {
      return { ok: false, code: 'BAD_KEY', message: 'API Key 无效', hint: '检查一下是不是复制少了字符' };
    }
    if (res.status === 403) {
      return { ok: false, code: 'FORBIDDEN', message: '这个 Key 没有查询权限', hint: '' };
    }
    if (res.status === 429) {
      return { ok: false, code: 'RATE_LIMIT', message: '查得太频繁了', hint: '等一下再试' };
    }
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch (err) {
        body = '';
      }
      return {
        ok: false,
        code: `HTTP_${res.status}`,
        message: `接口返回 ${res.status}`,
        hint: safeSlice(body, 120)
      };
    }

    const payload = await res.json();
    const infos = Array.isArray(payload && payload.balance_infos) ? payload.balance_infos : [];
    if (!infos.length) {
      return { ok: false, code: 'NO_DATA', message: '接口没返回余额信息', hint: '' };
    }

    const info = infos.find((item) => item && item.currency === 'CNY') || infos[0];

    return {
      ok: true,
      data: {
        currency: info.currency || 'CNY',
        total: String(info.total_balance ?? '0'),
        granted: String(info.granted_balance ?? '0'),
        toppedUp: String(info.topped_up_balance ?? '0'),
        isAvailable: !!payload.is_available,
        at: Date.now()
      }
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', message: '查询超时', hint: '检查一下网络或者代理' };
    }
    return {
      ok: false,
      code: 'NETWORK',
      message: '连不上 api.deepseek.com',
      hint: safeSlice(err && err.message ? err.message : err, 120)
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchBalance, ENDPOINT };
