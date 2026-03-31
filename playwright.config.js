const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:3999',
    headless: true,
  },
  webServer: {
    command: 'npx serve -l 3999 --no-clipboard .',
    port: 3999,
    reuseExistingServer: !process.env.CI,
  },
});
