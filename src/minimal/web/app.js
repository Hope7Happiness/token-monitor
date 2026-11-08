'use strict';

let snapshot;
let period = 'today';
let secret = '';
let timer;
let request;
let rendered = '';
let selectedDay = null;
let requestController;
let generation = 0;
const byId = (id) => document.getElementById(id);
const count = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const statuses = { ok: '已连接', notConfigured: '未登录', unavailable: '暂不可用', unauthorized: '请重新登录', rateLimited: '请求受限', sourceRateLimited: '请求受限', error: '读取失败' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function providerIcon(id) {
  const icon = element('img', undefined, 'provider-icon');
  icon.src = `/icons/${id}.svg`;
  icon.alt = '';
  icon.width = 24; icon.height = 24;
  return icon;
}

function render() {
  if (!snapshot) return;
  byId('status').textContent = snapshot.error ? '采集异常' : snapshot.ready ? '已连接' : '首次采集中';
  showError(snapshot.error || (period === 'week' && !snapshot.periods.week ? '当前采集器尚未支持周统计，请更新服务。' : null));
  const key = JSON.stringify([snapshot, period]);
  if (key === rendered) return;
  rendered = key;
  const current = snapshot.periods[period];
  const available = snapshot.ready && current && current.totalTokens !== null;
  renderHeatmap();
  const partial = period === 'week' && current && !current.complete;
  byId('tokens').textContent = available ? (partial ? '≥ ' : '') + count.format(current.totalTokens) : '—';
  byId('cost').textContent = available ? (partial ? '≥ ' : '') + money.format(current.totalCost) : '—';
  byId('clients').replaceChildren(...(current?.clients || []).map((client) => {
    const row = element('div', undefined, 'client');
    row.dataset.id = client.id;
    const mark = element('span', undefined, 'mark');
    mark.append(providerIcon(client.id));
    row.append(mark, element('span', client.label, 'client-name'));
    const value = element('div', available ? count.format(client.tokens) : '—', 'client-value');
    value.append(element('small', available ? money.format(client.cost) : '等待采集'));
    row.append(value);
    return row;
  }));
  byId('limits').replaceChildren(...snapshot.limits.map((provider) => {
    const card = element('article', undefined, 'quota');
    const heading = element('div', undefined, 'quota-heading');
    const name = element('span', undefined, 'provider-name');
    name.append(providerIcon(provider.provider), element('span', provider.label));
    heading.append(name, element('span', `${provider.connectionHint || statuses[provider.status] || provider.status}${provider.stale ? ' · 上次结果' : ''}`, 'muted'));
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

function renderHeatmap() {
  const daily = snapshot.daily;
  byId('heatmap-range').textContent = daily ? `${daily.start} – ${daily.end}` : '等待日历史';
  const known = (daily?.days || []).filter((day) => day.tokens !== null);
  const positive = known.map((day) => day.tokens).filter(value => value > 0).sort((a,b) => a-b);
  const cuts = [.25,.5,.75].map(q => positive[Math.floor((positive.length-1)*q)] || 0);
  const level = (day) => day.tokens === null ? 'missing' : day.tokens === 0 ? 'zero' : `level-${1 + cuts.filter(cut => day.tokens > cut).length}`;
  const days = daily?.days || [];
  const columns = [];
  const labels = element('div', undefined, 'heatmap-week');
  labels.append(element('span', '', 'month-label'));
  for (const label of ['一','二','三','四','五','六','日']) labels.append(element('span', label, 'day-label'));
  columns.push(labels);
  for (let i = 0; i < days.length; i += 7) {
    const week = element('div', undefined, 'heatmap-week');
    const first = days[i];
    week.append(element('span', i === 0 || first.date.slice(5,7) !== days[Math.max(0,i-7)].date.slice(5,7) ? `${Number(first.date.slice(5,7))}月` : '', 'month-label'));
    for (const day of days.slice(i, i + 7)) {
      const cell = element('button', undefined, `heatmap-cell ${level(day)}`);
      const text = `${day.date} · ${day.tokens === null ? '无数据' : `${day.tokens.toLocaleString('en-US')} tokens · ${money.format(day.cost)}`}`;
      cell.type = 'button'; cell.title = text; cell.setAttribute('aria-label', text);
      cell.setAttribute('aria-pressed', String(day.date === (selectedDay || daily.end)));
      cell.addEventListener('click', () => { selectedDay = day.date; renderHeatmap(); });
      week.append(cell);
    }
    columns.push(week);
  }
  byId('heatmap').replaceChildren(...columns);
  const day = days.find((day) => day.date === selectedDay) || days.at(-1);
  byId('heatmap-detail').textContent = day ? `${day.date} · ${day.tokens === null ? '无数据（未上报）' : `${day.tokens.toLocaleString('en-US')} tokens · ${money.format(day.cost)} · ${day.clients.map((client) => `${client.label} ${count.format(client.tokens)}`).join(' · ')}`}` : '每日历史尚未可用，现有累计统计仍可查看。';
  const gaps = days.length - known.length;
  byId('heatmap-notice').textContent = daily ? `${daily.timeZone} · 周一开始 · 近 12 周${gaps ? ` · ${gaps} 天无数据，不计为零` : ''}${daily.stale ? ' · 历史刷新失败，保留上次记录' : ''}${period === 'week' && !daily.week.complete ? ` · 本周仅 ${daily.week.availableDays}/${daily.week.expectedDays} 天有数据` : ''}` : '请等待采集器首次历史扫描，或更新服务以启用日数据。';
}

function showError(message) {
  byId('error').hidden = !message;
  byId('error').textContent = message || '';
}

async function api(path, method = 'GET', signal) {
  const response = await fetch(path, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  if (response.status === 401) { byId('login').hidden = false; throw new Error('请输入服务器访问密钥。'); }
  if (!response.ok) { const body = await response.json(); throw new Error(body.error || `HTTP ${response.status}`); }
  byId('login').hidden = true;
  return response.json();
}

function load() {
  if (document.hidden) return Promise.resolve();
  if (request) return request;
  clearTimeout(timer);
  const current = ++generation;
  requestController = new AbortController();
  request = api('/api/stats', 'GET', requestController.signal).then((data) => { if (current !== generation) return; snapshot = data; render(); }).catch((error) => {
    if (current !== generation || requestController.signal.aborted) return;
    byId('status').textContent = '连接异常'; showError(error.message);
  }).finally(() => {
    if (current !== generation) return;
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
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (document.hidden) { generation++; requestController?.abort(); request = null; } else load(); });
window.addEventListener('pagehide', () => { generation++; clearTimeout(timer); requestController?.abort(); });
load();
