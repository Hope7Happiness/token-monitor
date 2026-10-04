'use strict';

const { app, BrowserWindow } = require('electron');
const { randomBytes } = require('node:crypto');
const { loadDotEnv } = require('../shared/config');
const { readOptions } = require('./config');
const { createMinimalRuntime } = require('./runtime');
const { createMinimalServer, listen } = require('./server');
const { createOutboundFetch } = require('../shared/outboundFetch');

let runtime;
let server;
let shuttingDown = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) { window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    loadDotEnv();
    const options = { ...readOptions(), host: '127.0.0.1', port: 0, secret: randomBytes(32).toString('base64url') };
    runtime = createMinimalRuntime(options, { fetch: createOutboundFetch(), onError: (error) => console.error(`[minimal] ${error.message}`) });
    server = createMinimalServer(runtime, options);
    const url = await listen(server, options);
    const window = new BrowserWindow({
      title: 'Token Monitor · minimal', width: 560, height: 780, minWidth: 360, minHeight: 500,
      backgroundColor: '#101314', autoHideMenuBar: true,
      show: !app.commandLine.hasSwitch('minimal-smoke-test'),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true }
    });
    // The ephemeral local transport secret stays in main; no credential preload.
    window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${url}/api/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${options.secret}` } });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== url) event.preventDefault();
    });
    await window.loadURL(url);
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    server?.closeAllConnections();
    server?.close();
    Promise.resolve(runtime?.stop()).finally(() => app.quit());
  });
}
