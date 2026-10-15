'use strict';
// Diagnostic only. Every value is rendered with textContent; notification text is never shown here.
const output = document.getElementById('status');
const hubOutput = document.getElementById('hub');
const espOutput = document.getElementById('esp');
const commandOutput = document.getElementById('esp-command');
let sequence = 0;
let hubInFlight = false;
let espInFlight = false;
let setInFlight = false;
// Native-owned generation floor (AppStatus.nextCommandGeneration); null until app.status has been read.
let nextGeneration = null;
let lastMode = 0;
let history = null;
function send(op, prefix, args = {}) {
  if (!window.phoneMonitor) { output.textContent = 'Secure native bridge unavailable. Update Android System WebView.'; return false; }
  window.phoneMonitor.postMessage(JSON.stringify({v: 1, id: `${prefix}-${++sequence}`, op, args}));
  return true;
}
function refresh() { send('app.status', 'diagnostic'); }
function pollHub() {
  if (hubInFlight || document.visibilityState !== 'visible') return;
  hubInFlight = send('hub.snapshot', 'diagnostic-hub');
}
function pollEsp() {
  if (espInFlight || document.visibilityState !== 'visible') return;
  espInFlight = send('esp.state', 'diagnostic-esp');
}
function setLight(patch) {
  if (setInFlight) { commandOutput.textContent = 'A light command is still being answered.'; return; }
  if (nextGeneration === null) { commandOutput.textContent = 'Reading native command generation first…'; refresh(); return; }
  const generation = nextGeneration++;
  setInFlight = send('esp.set', 'diagnostic-esp-set', {patch, generation});
}
function commandLine(name, c) {
  if (!c) return `${name} command: none`;
  return `${name} command #${c.generation}: ${c.outcome}${c.errorCode ? ` (${c.errorCode})` : ''}`;
}
function espSummary(reply) {
  if (!reply.ok) return `Bridge error: ${reply.error && reply.error.code}`;
  const link = reply.data;
  const lines = [`Controller link: ${link.state}${link.stale ? ' (stale)' : ''}`,
    `Error: ${link.errorCode || 'none'}`,
    `Reading age: ${link.ageMs === null ? 'no sample' : `${(link.ageMs / 1000).toFixed(1)} s`}`];
  const d = link.data;
  if (d) {
    lastMode = d.mode;
    lines.push(`Light: ${d.power ? 'on' : 'off'} ${d.hex} brightness ${d.bright} mode ${d.mode} speed ${d.speed} timer ${d.timerSeconds} s`);
    lines.push(`Sensor: ${d.sensorOk ? 'ok' : 'unavailable'}; ${d.temperatureC === null ? '—' : `${d.temperatureC} °C`}; ${d.humidityPercent === null ? '—' : `${d.humidityPercent} %`}`);
    lines.push(`Controller uptime: ${d.uptimeSeconds} s`);
  }
  lines.push(commandLine('Light', link.commands.state), commandLine('Timer', link.commands.timer));
  if (history) lines.push(history);
  return lines.join('\n');
}
function historySummary(reply) {
  if (!reply.ok) return `History: bridge error ${reply.error && reply.error.code}`;
  const h = reply.data.data;
  if (!h) return `History: ${reply.data.state}${reply.data.errorCode ? ` ${reply.data.errorCode}` : ''}, no samples`;
  const gaps = h.temperatureC.filter(v => v === null).length;
  return `History: ${h.temperatureC.length} samples every ${h.intervalSeconds} s (${gaps} gaps), age ${(reply.data.ageMs / 1000).toFixed(1)} s`;
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
  const id = typeof reply.id === 'string' ? reply.id : '';
  if (id.startsWith('diagnostic-hub-')) {
    hubInFlight = false;
    try { hubOutput.textContent = hubSummary(reply); } catch { hubOutput.textContent = 'Invalid laptop link reply.'; }
    return;
  }
  if (id.startsWith('diagnostic-esp-set-')) {
    setInFlight = false;
    if (!reply.ok && reply.error && reply.error.code === 'BAD_GENERATION') { nextGeneration = null; refresh(); }
    commandOutput.textContent = reply.ok ? commandLine(reply.data.kind === 'timer' ? 'Timer' : 'Light', reply.data) : `Light command error: ${reply.error && reply.error.code}`;
    return;
  }
  if (id.startsWith('diagnostic-esp-history-')) {
    try { history = historySummary(reply); } catch { history = 'Invalid history reply.'; }
    return;
  }
  if (id.startsWith('diagnostic-esp-')) {
    espInFlight = false;
    try { espOutput.textContent = espSummary(reply); } catch { espOutput.textContent = 'Invalid controller reply.'; }
    return;
  }
  if (reply.ok && reply.data && typeof reply.data.nextCommandGeneration === 'number') {
    nextGeneration = Math.max(nextGeneration || 1, reply.data.nextCommandGeneration);
  }
  output.textContent = JSON.stringify(reply, null, 2);
};
document.getElementById('check').addEventListener('click', refresh);
document.getElementById('hub-check').addEventListener('click', pollHub);
// Setup opens one native code-entry dialog; completion is read back through app.status.
document.getElementById('pair').addEventListener('click', () => send('app.setupHub', 'diagnostic'));
// Controller setup opens one native Wi-Fi dialog; credentials never pass through this page.
document.getElementById('esp-connect').addEventListener('click', () => send('app.connectEsp', 'diagnostic'));
document.getElementById('esp-settings').addEventListener('click', () => send('app.openWifiSettings', 'diagnostic'));
document.getElementById('esp-history').addEventListener('click', () => send('esp.history', 'diagnostic-esp-history'));
document.getElementById('light-on').addEventListener('click', () => setLight({power: true}));
document.getElementById('light-off').addEventListener('click', () => setLight({power: false}));
document.getElementById('light-dim').addEventListener('click', () => setLight({bright: 20}));
document.getElementById('light-full').addEventListener('click', () => setLight({bright: 100}));
document.getElementById('light-mode').addEventListener('click', () => setLight({mode: (lastMode + 1) % 9}));
document.getElementById('light-timer').addEventListener('click', () => setLight({timerMinutes: 1}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); pollHub(); pollEsp(); } });
setInterval(pollHub, 2000);
setInterval(pollEsp, 3000);
refresh();
pollHub();
pollEsp();
