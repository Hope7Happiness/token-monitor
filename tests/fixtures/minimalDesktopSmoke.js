'use strict';

// Run with electron tests/fixtures/minimalDesktopSmoke.js --minimal-smoke-test.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-minimal-desktop-'));
app.setPath('userData', temp);
process.env.TOKEN_MONITOR_CLIENTS = 'codex';
process.env.TOKEN_MONITOR_LIMITS_ENABLED = '0';
process.env.CODEX_HOME = path.join(temp, '.codex');
process.env.TOKSCALE_CONFIG_DIR = path.join(temp, 'tokscale');
process.env.TOKSCALE_PRICING_CACHE_ONLY = '1';
process.env.TOKEN_MONITOR_SHARED_DIR = path.join(temp, 'data');
fs.mkdirSync(path.join(temp, 'tokscale', 'cache'), { recursive: true });
for (const source of ['litellm', 'openrouter', 'models-dev']) {
  fs.writeFileSync(path.join(temp, 'tokscale', 'cache', `pricing-${source}.json`), JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {} }));
}
let failed = false;
const timeout = setTimeout(() => { failed = true; console.error('Desktop smoke timed out'); app.quit(); }, 30000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const stats = await fetch('/api/stats').then(r => r.json());
        document.querySelector('[data-period="month"]').click();
        return {
          authenticated: Boolean(stats.periods), selected: document.querySelector('[aria-pressed="true"]').textContent,
          nodeDisabled: typeof require === 'undefined', windows: document.querySelectorAll('nav button').length
        };
      })()`);
      assert.equal(result.authenticated, true);
      assert.equal(result.selected, '本月');
      assert.equal(result.nodeDisabled, true);
      assert.equal(result.windows, 3);
      console.log(`minimal-desktop-smoke: ${JSON.stringify(result)}`);
    } catch (error) { failed = true; console.error(error); }
    clearTimeout(timeout);
    window.close();
  });
});
app.once('will-quit', () => {
  clearTimeout(timeout);
  fs.rmSync(temp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
});
require('../../src/minimal/electron');
