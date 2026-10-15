import { defineConfig } from 'vitest/config';
export default defineConfig({resolve:{alias:{'@phone-monitor/protocol':new URL('../packages/protocol/src/index.ts',import.meta.url).pathname}}});
