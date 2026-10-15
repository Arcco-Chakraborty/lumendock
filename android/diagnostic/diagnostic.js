'use strict';
const output = document.getElementById('status');
let sequence = 0;
function refresh() {
  if (!window.phoneMonitor) { output.textContent = 'Secure native bridge unavailable. Update Android System WebView.'; return; }
  window.phoneMonitor.postMessage(JSON.stringify({v: 1, id: `diagnostic-${++sequence}`, op: 'app.status', args: {}}));
}
if (window.phoneMonitor) window.phoneMonitor.onmessage = event => {
  try { output.textContent = JSON.stringify(JSON.parse(event.data), null, 2); }
  catch { output.textContent = 'Invalid native status.'; }
};
document.getElementById('check').addEventListener('click', refresh);
refresh();
