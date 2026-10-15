'use strict';
// Diagnostic only. Every value is rendered with textContent; notification text is never shown here.
const output = document.getElementById('status');
const hubOutput = document.getElementById('hub');
let sequence = 0;
let hubInFlight = false;
function send(op, prefix) {
  if (!window.phoneMonitor) { output.textContent = 'Secure native bridge unavailable. Update Android System WebView.'; return false; }
  window.phoneMonitor.postMessage(JSON.stringify({v: 1, id: `${prefix}-${++sequence}`, op, args: {}}));
  return true;
}
function refresh() { send('app.status', 'diagnostic'); }
function pollHub() {
  if (hubInFlight || document.visibilityState !== 'visible') return;
  hubInFlight = send('hub.snapshot', 'diagnostic-hub');
}
function windowLine(w) {
  const used = typeof w.usedPercent === 'number' ? `${w.usedPercent}%` : 'unknown';
  const reset = typeof w.resetsAtEpochSec === 'number' ? ` resets ${new Date(w.resetsAtEpochSec * 1000).toISOString()}` : '';
  return `  ${String(w.label).slice(0, 80)}: ${used}${reset}`;
}
function hubSummary(reply) {
  if (!reply.ok) return `Bridge error: ${reply.error && reply.error.code}`;
  const link = reply.data;
  const lines = [`Laptop link: ${link.state}${link.stale ? ' (stale)' : ''}`,
    `Error: ${link.errorCode || 'none'}`,
    `Payload age: ${link.ageMs === null ? 'no sample' : `${(link.ageMs / 1000).toFixed(1)} s`}`];
  const data = link.data;
  if (data) {
    lines.push(`Estimated laptop time: ${new Date(data.serverNowEpochMs + link.ageMs).toISOString()}`);
    for (const name of ['claude', 'codex']) {
      const source = data.usage[name];
      lines.push(`${name}: ${source.state}${source.stale ? ' (stale)' : ''}${source.errorCode ? ` ${source.errorCode}` : ''}`);
      source.windows.forEach(w => lines.push(windowLine(w)));
    }
    lines.push(`Notifications: ${data.notifications.state}, ${data.notifications.items.length} item(s)`);
  }
  return lines.join('\n');
}
if (window.phoneMonitor) window.phoneMonitor.onmessage = event => {
  let reply;
  try { reply = JSON.parse(event.data); } catch { output.textContent = 'Invalid native reply.'; return; }
  if (typeof reply.id === 'string' && reply.id.startsWith('diagnostic-hub-')) {
    hubInFlight = false;
    try { hubOutput.textContent = hubSummary(reply); } catch { hubOutput.textContent = 'Invalid laptop link reply.'; }
    return;
  }
  output.textContent = JSON.stringify(reply, null, 2);
};
document.getElementById('check').addEventListener('click', refresh);
document.getElementById('hub-check').addEventListener('click', pollHub);
// Setup opens one native code-entry dialog; completion is read back through app.status.
document.getElementById('pair').addEventListener('click', () => send('app.setupHub', 'diagnostic'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); pollHub(); } });
setInterval(pollHub, 2000);
refresh();
pollHub();
