'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMenuBar, panelBounds } = require('../../src/minimal/menuBar');

test('popover stays within the menu bar display including negative monitor coordinates', () => {
  for (const workArea of [{ x: 0, y: 25, width: 1440, height: 800 }, { x: -1280, y: 25, width: 1280, height: 700 }]) {
    for (const x of [workArea.x, workArea.x + workArea.width - 10]) {
      const bounds = panelBounds({ x, y: 0, width: 20, height: 25 }, workArea);
      assert.ok(bounds.x >= workArea.x);
      assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
      assert.ok(bounds.y >= workArea.y);
      assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
    }
  }
});

test('menu bar creates no renderer until clicked and releases it on dismissal while retaining collection', async () => {
  const windows = [];
  let stopped = false;
  let unsubscribed = false;
  let requestHandler;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.closed = false; this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.session = { webRequest: { onBeforeSendHeaders: (_filter, handler) => { requestHandler = handler; } } };
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    setVisibleOnAllWorkspaces() {}
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.closed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    focus() {}
    close() { this.closed = true; this.emit('closed'); }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    getBounds() { return { x: 900, y: 0, width: 20, height: 25 }; }
    destroy() { this.destroyed = true; }
  }
  const icon = { resize() { return this; }, isEmpty: () => false, setTemplateImage() {} };
  const runtime = {
    getSnapshot: () => null, subscribe: () => () => { unsubscribed = true; }, stop() { stopped = true; }
  };
  const menu = createMenuBar({
    app: {}, BrowserWindow: Window, Tray, Menu: {}, nativeImage: { createFromPath: () => icon },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 800 } }) },
    runtime, url: 'http://127.0.0.1:1234', secret: 'private-local-secret'
  });
  assert.equal(windows.length, 0);
  await menu.showPanel();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.skipTaskbar, true);
  let headers;
  requestHandler({ requestHeaders: {} }, (result) => { headers = result.requestHeaders; });
  assert.equal(headers.Authorization, 'Bearer private-local-secret');
  windows[0].emit('blur');
  assert.equal(windows[0].closed, true);
  assert.equal(menu.getWindow(), null);
  assert.equal(stopped, false);
  assert.equal(menu.getTray().destroyed, undefined);
  await menu.showPanel();
  assert.equal(windows.length, 2);
  menu.dispose();
  assert.equal(windows[1].closed, true);
  assert.equal(menu.getTray().destroyed, true);
  assert.equal(unsubscribed, true);
});
