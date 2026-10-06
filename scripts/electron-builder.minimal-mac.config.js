'use strict';

// Local macOS app: separate identity from the full widget, no extensions,
// updater or publishing. Reuse the installed Electron framework for offline builds.
const path = require('node:path');

module.exports = {
  appId: 'local.tokenmonitor.minimal',
  productName: 'Token Monitor Minimal',
  electronDist: path.resolve(__dirname, '../node_modules/electron/dist'),
  directories: { output: 'dist/minimal-mac' },
  npmRebuild: false,
  files: [
    'src/minimal/**/*',
    'src/shared/**/*',
    'scripts/vendor/tokscale.json',
    'assets/icon.png',
    'assets/icons/tray-minimalTemplate*.png',
    'package.json'
  ],
  asarUnpack: ['node_modules/@tokscale/**/*', 'node_modules/tokscale/**/*', 'node_modules/koffi/**/*'],
  extraMetadata: { name: 'token-monitor-minimal', productName: 'Token Monitor Minimal', main: 'src/minimal/electron.js' },
  mac: {
    target: ['dir'],
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '12.0',
    icon: 'assets/icon.png',
    identity: '-',
    hardenedRuntime: false,
    forceCodeSigning: false,
    extendInfo: { LSUIElement: true }
  },
  publish: null
};
