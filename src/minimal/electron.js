'use strict';

const electron = require('electron');
const { app } = electron;
const { randomBytes } = require('node:crypto');
const { loadDotEnv } = require('../shared/config');
const { readOptions } = require('./config');
const { createMinimalRuntime } = require('./runtime');
const { createMinimalServer, listen } = require('./server');
const { createOutboundFetch } = require('../shared/outboundFetch');
const { createMenuBar } = require('./menuBar');

let runtime;
let server;
let desktop;
let shuttingDown = false;
let desktopReady = Promise.resolve(null);
if (process.platform !== 'darwin') {
  console.error('The minimal desktop supports macOS. Use npm run headless on this platform.');
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void desktop?.showPanel(); });
  app.on('activate', () => { void desktop?.showPanel(); });
  desktopReady = app.whenReady().then(async () => {
    app.setActivationPolicy('accessory');
    electron.Menu.setApplicationMenu(null);
    loadDotEnv();
    const options = { ...readOptions(), webEnabled: true, host: '127.0.0.1', port: 0, secret: randomBytes(32).toString('base64url') };
    runtime = createMinimalRuntime(options, { fetch: createOutboundFetch(), onError: (error) => console.error(`[minimal] ${error.message}`) });
    server = createMinimalServer(runtime, options);
    const url = await listen(server, options);
    desktop = createMenuBar({ ...electron, runtime, url, secret: options.secret });
    return desktop;
  });
  desktopReady.catch((error) => { console.error(error); app.quit(); });
  // Closing the panel retains the menu bar collector. Quit is explicit in its menu.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    desktop?.dispose();
    server?.closeAllConnections();
    server?.close();
    Promise.resolve(runtime?.stop()).finally(() => app.quit());
  });
}

module.exports = { desktopReady };
