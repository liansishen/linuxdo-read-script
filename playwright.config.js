const fs = require('node:fs');
const { defineConfig, chromium } = require('@playwright/test');

const hasBundledChromium = (() => {
  try { return fs.existsSync(chromium.executablePath()); }
  catch { return false; }
})();

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  use: {
    ...(hasBundledChromium ? {} : { channel: 'msedge' }),
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
