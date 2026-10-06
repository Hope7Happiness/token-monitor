'use strict';

const path = require('node:path');
const { CLIENTS, LABELS } = require('./config');

function panelBounds(trayBounds, workArea, size = { width: 420, height: 720 }) {
  const width = Math.min(size.width, workArea.width - 16);
  const height = Math.min(size.height, workArea.height - 16);
  return {
    width, height,
    x: Math.round(Math.max(workArea.x + 8, Math.min(
      trayBounds.x + trayBounds.width / 2 - width / 2, workArea.x + workArea.width - width - 8
    ))),
    y: Math.round(Math.max(workArea.y + 4, Math.min(
      trayBounds.y + trayBounds.height + 6, workArea.y + workArea.height - height - 8
    )))
  };
}

function createMenuBar({ app, BrowserWindow, Tray, Menu, nativeImage, screen, runtime, url, secret }) {
  // Matching 18pt and @2x assets keep the template sharp on Retina displays.
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/icons/tray-minimalTemplate.png'));
  if (icon.isEmpty()) throw new Error('Menu bar icon could not be loaded');
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  let panel = null;
  let opening = null;
  let disposed = false;
  let refreshing = false;
  let tooltip = '';
  const numbers = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 0 });

  function updateTooltip(record = runtime.getSnapshot()) {
    const next = ['Token Monitor Minimal · 点击查看用量，右键打开菜单',
      record ? `今天 ${numbers.format(record.today?.totalTokens || 0)} tokens` : '正在采集用量…',
      ...CLIENTS.map((id) => `${LABELS[id]}: ${numbers.format(record?.today?.clients?.[id] || 0)}`)
    ].join('\n');
    if (next !== tooltip) { tooltip = next; tray.setToolTip(next); }
  }
  updateTooltip();
  const unsubscribe = runtime.subscribe(updateTooltip);

  function closePanel() {
    // Destroy the renderer when dismissed; idle monitoring keeps no hidden Chromium page.
    panel?.close();
  }

  async function showPanel({ focus = true } = {}) {
    if (disposed) return;
    if (opening) return opening;
    if (panel && !panel.isDestroyed()) {
      if (focus) { panel.show(); panel.focus(); }
      return panel;
    }
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const bounds = panelBounds(trayBounds, display.workArea);
    const window = new BrowserWindow({
      ...bounds, title: 'Token Monitor Minimal', type: 'panel',
      frame: false, resizable: false, movable: false, show: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#101314',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true }
    });
    panel = window;
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${url}/api/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${secret}` } });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== url) event.preventDefault();
    });
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape') { event.preventDefault(); closePanel(); }
      if (input.meta && input.key.toLowerCase() === 'q') { event.preventDefault(); app.quit(); }
    });
    window.on('blur', () => { if (window.isVisible()) window.close(); });
    window.on('closed', () => { if (panel === window) panel = null; });
    opening = window.loadURL(url).then(() => {
      if (!disposed && !window.isDestroyed() && focus) { window.show(); window.focus(); }
      return window;
    }).catch((error) => {
      if (!window.isDestroyed()) window.close();
      if (!disposed && error.code !== 'ERR_ABORTED') console.error(`[menu-bar] ${error.message}`);
      return null;
    }).finally(() => { opening = null; });
    return opening;
  }

  function toggle() {
    if (panel && !panel.isDestroyed()) closePanel();
    else void showPanel();
  }

  function contextMenu() {
    return Menu.buildFromTemplate([
      { label: '查看用量', click: () => { void showPanel(); } },
      { label: '刷新用量', enabled: !refreshing, click: async () => {
        refreshing = true;
        try { await runtime.refreshUsage(); } catch (error) { console.error(`[menu-bar] ${error.message}`); }
        finally { refreshing = false; }
      } },
      { type: 'separator' },
      { label: '登录时启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        enabled: app.isPackaged,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { label: '退出 Token Monitor', click: () => app.quit() }
    ]);
  }
  tray.on('click', toggle);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu()));

  return {
    showPanel, closePanel, toggle,
    getWindow: () => panel,
    getTray: () => tray,
    dispose() {
      disposed = true;
      unsubscribe();
      closePanel();
      tray.destroy();
    }
  };
}

module.exports = { createMenuBar, panelBounds };
