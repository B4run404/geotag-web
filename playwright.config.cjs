const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/browser",
  timeout: 45000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chrome", use: { browserName: "chromium", channel: "chrome", viewport: { width: 1440, height: 1100 } } },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } }
  ],
  webServer: { command: "node dev-server.cjs", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI, timeout: 15000 }
});
