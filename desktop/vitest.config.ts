import { defineConfig } from 'vitest/config';
// systemd units, POSIX process groups and the /bin/sh status-line chain exist only on Linux.
const linuxOnly = process.platform === 'win32' ? ['test/service.test.ts','test/wrapper.test.ts','test/installer.test.ts'] : [];
export default defineConfig({resolve:{alias:{'@phone-monitor/protocol':new URL('../packages/protocol/src/index.ts',import.meta.url).pathname}},test:{exclude:['**/node_modules/**',...linuxOnly]}});
