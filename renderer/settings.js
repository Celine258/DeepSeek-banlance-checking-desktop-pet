'use strict';

/** 设置窗口：只管一件事 —— 把 API Key 存好并验证它能不能用。 */

const api = window.settingsAPI;

const input = document.getElementById('api-key');
const revealBtn = document.getElementById('reveal');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');
const statusEl = document.getElementById('status');
const pathEl = document.getElementById('config-path');
const keyLink = document.getElementById('key-link');

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status';
  if (kind === 'ok') statusEl.classList.add('is-ok');
  else if (kind === 'error') statusEl.classList.add('is-error');
}

function money(currency, value) {
  return `${currency === 'USD' ? '$' : '¥'}${value}`;
}

async function init() {
  try {
    const data = await api.load();
    input.value = data.apiKey || '';
    pathEl.textContent = data.configPath || '';
    if (input.value) setStatus('已保存过 Key', 'ok');
  } catch (err) {
    setStatus('读不到配置', 'error');
  }
}

revealBtn.addEventListener('click', () => {
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  revealBtn.textContent = showing ? '显示' : '隐藏';
  input.focus();
});

async function save() {
  saveBtn.disabled = true;
  setStatus('保存中…');
  try {
    const result = await api.save({ apiKey: input.value });
    if (result && result.ok && result.hasKey) setStatus('已保存', 'ok');
    else setStatus('Key 是空的，保存了也查不了余额', 'error');
  } catch (err) {
    setStatus('保存失败', 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

async function test() {
  testBtn.disabled = true;
  setStatus('正在连接…');
  try {
    const result = await api.test(input.value);
    if (result && result.ok) {
      setStatus(`连接成功，余额 ${money(result.data.currency, result.data.total)}`, 'ok');
    } else if (result) {
      setStatus(result.hint ? `${result.message}（${result.hint}）` : result.message, 'error');
    } else {
      setStatus('测试失败', 'error');
    }
  } catch (err) {
    setStatus('测试失败', 'error');
  } finally {
    testBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', save);
testBtn.addEventListener('click', test);

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    save();
  }
});

keyLink.addEventListener('click', (event) => {
  event.preventDefault();
  api.openKeyPage();
});

init();
