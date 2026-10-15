import { defineConfig } from "vite";
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
