'use strict';

let snapshot;
let period = 'today';
let secret = '';
let timer;
let request;
let rendered = '';
const byId = (id) => document.getElementById(id);
const count = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const statuses = { ok: '已连接', notConfigured: '未登录', unavailable: '暂不可用', unauthorized: '请重新登录', rateLimited: '请求受限', sourceRateLimited: '请求受限', error: '读取失败' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render() {
  if (!snapshot) return;
  byId('status').textContent = snapshot.error ? '采集异常' : snapshot.ready ? '已连接' : '首次采集中';
  showError(snapshot.error);
  const key = JSON.stringify([snapshot, period]);
  if (key === rendered) return;
  rendered = key;
  const current = snapshot.periods[period];
  byId('tokens').textContent = snapshot.ready ? count.format(current.totalTokens) : '—';
  byId('cost').textContent = snapshot.ready ? money.format(current.totalCost) : '—';
  byId('clients').replaceChildren(...current.clients.map((client) => {
    const row = element('div', undefined, 'client');
    row.dataset.id = client.id;
    row.append(element('span', client.id === 'antigravity' ? 'AG' : client.label.slice(0, 2), 'mark'), element('span', client.label, 'client-name'));
    const value = element('div', snapshot.ready ? count.format(client.tokens) : '—', 'client-value');
    value.append(element('small', snapshot.ready ? money.format(client.cost) : '等待采集'));
    row.append(value);
    return row;
  }));
  byId('limits').replaceChildren(...snapshot.limits.map((provider) => {
    const card = element('article', undefined, 'quota');
    const heading = element('div', undefined, 'quota-heading');
    heading.append(element('span', provider.label), element('span', `${statuses[provider.status] || provider.status}${provider.stale ? ' · 上次结果' : ''}`, 'muted'));
    card.append(heading);
    for (const window of provider.windows) {
      const row = element('div', undefined, 'window');
      const label = element('div', undefined, 'window-label');
      const percent = window.usedPercent;
      const value = window.metric === 'credits' ? `${window.currency || 'USD'} ${window.remaining ?? '—'}` : Number.isFinite(percent) ? `${Math.round(percent)}% 已使用` : '—';
      label.append(element('span', window.label), element('span', value));
      row.append(label);
      if (window.metric !== 'credits' && Number.isFinite(percent)) {
        const meter = element('meter');
        meter.min = 0; meter.max = 100; meter.value = percent;
        meter.setAttribute('aria-label', `${provider.label} ${window.label}`);
        row.append(meter);
      }
      if (window.resetsAt) row.append(element('small', `重置于 ${new Date(window.resetsAt).toLocaleString()}`));
      card.append(row);
    }
    return card;
  }));
  if (!snapshot.limits.length) byId('limits').append(element('p', '额度采集已关闭，或正在等待首次读取。', 'muted'));
  byId('updated').textContent = snapshot.updatedAt ? `更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : '等待首次采集';
  byId('cadence').textContent = `用量 ${snapshot.intervalMs / 1000}s · 额度 ${snapshot.limitsRefreshMs / 1000}s${snapshot.watchEnabled ? ' · 实时监听' : ' · 低功耗'}`;
}

function showError(message) {
  byId('error').hidden = !message;
  byId('error').textContent = message || '';
}

async function api(path, method = 'GET') {
  const response = await fetch(path, { method, signal: AbortSignal.timeout(15000), headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  if (response.status === 401) { byId('login').hidden = false; throw new Error('请输入服务器访问密钥。'); }
  if (!response.ok) { const body = await response.json(); throw new Error(body.error || `HTTP ${response.status}`); }
  byId('login').hidden = true;
  return response.json();
}

function load() {
  if (document.hidden) return Promise.resolve();
  if (request) return request;
  clearTimeout(timer);
  request = api('/api/stats').then((data) => { snapshot = data; render(); }).catch((error) => {
    byId('status').textContent = '连接异常'; showError(error.message);
  }).finally(() => {
    request = null;
    if (!document.hidden && byId('login').hidden) timer = setTimeout(load, snapshot?.ready ? 15000 : 2000);
  });
  return request;
}

document.querySelectorAll('[data-period]').forEach((button) => button.addEventListener('click', () => {
  period = button.dataset.period;
  document.querySelectorAll('[data-period]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
  render();
}));
byId('login').addEventListener('submit', (event) => {
  event.preventDefault(); secret = byId('secret').value; byId('secret').value = ''; load();
});
byId('refresh').addEventListener('click', async () => {
  byId('refresh').disabled = true;
  try { await api('/api/refresh', 'POST'); await load(); } catch (error) { showError(error.message); }
  finally { byId('refresh').disabled = false; }
});
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) load(); });
load();
