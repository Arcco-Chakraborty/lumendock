import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    {
      name: "development-csp",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replace(
          /\s*<meta\s+http-equiv="Content-Security-Policy"[^>]+>/,
          "",
        ),
    },
  ],
  // Playwright specs (e2e/) run through `npm run test:e2e`, never through vitest.
  test: { exclude: ["e2e/**", "node_modules/**", "dist/**", "test-results/**"] },
  base: "./",
  build: { target: "es2018", outDir: "dist" },
  resolve: {
    alias: {
      "@phone-monitor/protocol": new URL(
        "../packages/protocol/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
