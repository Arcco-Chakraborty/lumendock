import { defineConfig } from "@playwright/test";

// The suite always drives the PRODUCTION bundle (`vite build` output served by
// `vite preview`) in the installed Google Chrome. No browser binary is downloaded.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    headless: true,
    trace: "off",
  },
  webServer: {
    command: "vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/index.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
