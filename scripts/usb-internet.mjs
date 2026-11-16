#!/usr/bin/env node
// Optional foreground relay. Importing the library never starts a relay or probes a device.
try {
  const { runUsbInternetCli } = await import('../desktop/dist/usb-internet-system.js');
  process.exitCode = await runUsbInternetCli(process.argv.slice(2));
} catch {
  console.error('USB tooling unavailable. Build the desktop workspace first; see docs/OFFLOAD.md.');
  process.exitCode = 1;
}
