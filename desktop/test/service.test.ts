import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHubService, uninstallHubService, renderUnit, SERVICE_NAME, type SystemctlRunner } from '../src/service.js';

// Tests never contact a real systemd user manager: systemctl is always a recording fake.
const fakeSystemctl = (fail: string[] = []) => {
  const calls: string[][] = [];
  const run: SystemctlRunner = async args => { calls.push([...args]); return fail.includes(args[0]!) ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' }; };
  return { calls, run };
};
const setup = (name = "phone monitor ' $x %h \"q\"") => {
  const base = mkdtempSync(join(tmpdir(), 'pm-service-'));
  const hubPath = join(base, name, 'dist', 'main.js');
  mkdirSync(join(base, name, 'dist'), { recursive: true });
  writeFileSync(hubPath, 'console.log("synthetic hub")');
  const configDir = join(base, 'xdg config', 'phone-monitor');
  const unitDir = join(base, 'units', 'systemd', 'user');
  return { base, hubPath, configDir, unitDir, nodePath: process.execPath, pathEnv: '/usr/bin:/bin' };
};
const unitPathOf = (o: { unitDir: string }) => join(o.unitDir, SERVICE_NAME);

describe('renderUnit', () => {
  it('embeds absolute node/hub/config paths with systemd quoting', () => {
    const o = setup();
    const unit = renderUnit(o);
    expect(unit).toContain(`Environment="XDG_CONFIG_HOME=${join(o.base, 'xdg config')}"`);
    expect(unit).toMatch(/^ExecStart="\/[^"]*node[^"]*" "\/.*main\.js"$/m);
    // specifiers and variable expansion are neutralized in ExecStart
    expect(unit).toContain('%%h');
    expect(unit).toContain('$$x');
    expect(unit).toContain('\\"q\\"');
  });
  it('rejects relative paths, control characters and an unsupported config directory name', () => {
    const o = setup();
    expect(() => renderUnit({ ...o, nodePath: 'node' })).toThrow('ABSOLUTE_PATH_REQUIRED');
    expect(() => renderUnit({ ...o, hubPath: '/tmp/a\nExecStart=/bin/evil' })).toThrow('UNSAFE_PATH');
    expect(() => renderUnit({ ...o, configDir: '/tmp/x\u0000/phone-monitor' })).toThrow('UNSAFE_PATH');
    expect(() => renderUnit({ ...o, configDir: '/tmp/elsewhere' })).toThrow('CONFIG_DIRECTORY_NAME_UNSUPPORTED');
  });
  it('never enables or starts anything by itself', () => {
    expect(renderUnit(setup())).not.toMatch(/systemctl|enable|--now/);
  });
});

describe('installHubService', () => {
  it('installs a 0644 unit and a private 0600 ownership record, reloads but neither enables nor starts', async () => {
    const o = setup(); const sc = fakeSystemctl();
    const result = await installHubService({ ...o, systemctl: sc.run });
    expect(result).toMatchObject({ changed: true, enabled: false, unitPath: unitPathOf(o) });
    expect(statSync(unitPathOf(o)).mode & 0o777).toBe(0o644);
    expect(statSync(join(o.configDir, 'hub-service.json')).mode & 0o777).toBe(0o600);
    expect(statSync(o.configDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(unitPathOf(o), 'utf8')).toBe(renderUnit(o));
    expect(sc.calls).toEqual([['daemon-reload']]);
    expect(readdirSync(o.unitDir)).toEqual([SERVICE_NAME]);
  });
  it('is idempotent and enables only on explicit request', async () => {
    const o = setup(); const sc = fakeSystemctl();
    await installHubService({ ...o, systemctl: sc.run });
    const again = await installHubService({ ...o, systemctl: sc.run });
    expect(again.changed).toBe(false);
    expect(sc.calls).toEqual([['daemon-reload']]);
    const enabled = await installHubService({ ...o, systemctl: sc.run, enable: true });
    expect(enabled.enabled).toBe(true);
    expect(sc.calls.at(-1)).toEqual(['enable', '--now', SERVICE_NAME]);
    expect(JSON.parse(readFileSync(join(o.configDir, 'hub-service.json'), 'utf8'))).toMatchObject({ phase: 'installed', enabled: true });
  });
  it('updates an unmodified owned unit when paths change', async () => {
    const o = setup(); const sc = fakeSystemctl();
    await installHubService({ ...o, systemctl: sc.run });
    const hub2 = join(o.base, 'hub2.js'); writeFileSync(hub2, '');
    const result = await installHubService({ ...o, hubPath: hub2, systemctl: sc.run });
    expect(result.changed).toBe(true);
    expect(readFileSync(unitPathOf(o), 'utf8')).toContain(hub2);
  });
  it('refuses to overwrite a unit it does not own or one the user modified', async () => {
    const o = setup(); const sc = fakeSystemctl();
    mkdirSync(o.unitDir, { recursive: true });
    writeFileSync(unitPathOf(o), '[Service]\nExecStart=/bin/true\n');
    await expect(installHubService({ ...o, systemctl: sc.run })).rejects.toThrow('UNIT_EXISTS_NOT_OWNED');
    expect(readFileSync(unitPathOf(o), 'utf8')).toBe('[Service]\nExecStart=/bin/true\n');
    const p = setup();
    await installHubService({ ...p, systemctl: sc.run });
    const edited = `${readFileSync(unitPathOf(p), 'utf8')}Environment=USER_EDIT=1\n`;
    writeFileSync(unitPathOf(p), edited);
    await expect(installHubService({ ...p, systemctl: sc.run })).rejects.toThrow('UNIT_MODIFIED');
    expect(readFileSync(unitPathOf(p), 'utf8')).toBe(edited);
  });
  it('refuses a symlinked unit path and a missing hub build', async () => {
    const o = setup(); const sc = fakeSystemctl();
    mkdirSync(o.unitDir, { recursive: true });
    const target = join(o.base, 'target.service'); writeFileSync(target, 'x');
    symlinkSync(target, unitPathOf(o));
    await expect(installHubService({ ...o, systemctl: sc.run })).rejects.toThrow('UNIT_UNSAFE');
    expect(readFileSync(target, 'utf8')).toBe('x');
    await expect(installHubService({ ...setup(), hubPath: join(o.base, 'missing.js'), systemctl: sc.run })).rejects.toThrow('HUB_BUILD_MISSING');
  });
  it('reports daemon-reload failures as warnings and enable failures as errors', async () => {
    const o = setup();
    const warn = await installHubService({ ...o, systemctl: fakeSystemctl(['daemon-reload']).run });
    expect(warn.warnings.join(' ')).toMatch(/daemon-reload/);
    const p = setup();
    await expect(installHubService({ ...p, enable: true, systemctl: fakeSystemctl(['enable']).run })).rejects.toThrow('SERVICE_ENABLE_FAILED');
    expect(existsSync(unitPathOf(p))).toBe(true);
  });
  it('recovers from an interrupted install (pending record, unit not yet written)', async () => {
    const o = setup(); const sc = fakeSystemctl();
    await installHubService({ ...o, systemctl: sc.run });
    const record = join(o.configDir, 'hub-service.json');
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), phase: 'install_pending' }));
    expect((await installHubService({ ...o, systemctl: sc.run })).changed).toBe(true);
    expect(JSON.parse(readFileSync(record, 'utf8')).phase).toBe('installed');
  });
});

describe('uninstallHubService', () => {
  it('removes only the owned unit and record, leaving other files and the token directory', async () => {
    const o = setup(); const sc = fakeSystemctl(['is-enabled']);
    mkdirSync(o.unitDir, { recursive: true }); writeFileSync(join(o.unitDir, 'other.service'), 'keep');
    mkdirSync(o.configDir, { recursive: true }); writeFileSync(join(o.configDir, 'phone-token'), 'synthetic-token-placeholder');
    await installHubService({ ...o, systemctl: sc.run });
    const result = await uninstallHubService({ ...o, systemctl: sc.run });
    expect(result.changed).toBe(true);
    expect(existsSync(unitPathOf(o))).toBe(false);
    expect(existsSync(join(o.configDir, 'hub-service.json'))).toBe(false);
    expect(readFileSync(join(o.unitDir, 'other.service'), 'utf8')).toBe('keep');
    expect(existsSync(join(o.configDir, 'phone-token'))).toBe(true);
    expect(sc.calls.some(c => c[0] === 'disable')).toBe(false); // never enabled by us
    expect(sc.calls.at(-1)).toEqual(['daemon-reload']);
  });
  it('also disables a service the user enabled by hand after install', async () => {
    const o = setup(); const sc = fakeSystemctl();
    await installHubService({ ...o, systemctl: sc.run });
    const result = await uninstallHubService({ ...o, systemctl: sc.run });
    expect(result.changed).toBe(true);
    expect(sc.calls).toContainEqual(['disable', '--now', 'phone-monitor-hub.service']);
    expect(existsSync(unitPathOf(o))).toBe(false);
  });
  it('disables a service it enabled before removing the unit', async () => {
    const o = setup(); const sc = fakeSystemctl();
    await installHubService({ ...o, enable: true, systemctl: sc.run });
    await uninstallHubService({ ...o, systemctl: sc.run });
    const names = sc.calls.map(c => c[0]);
    expect(names.indexOf('disable')).toBeGreaterThan(-1);
    expect(sc.calls.find(c => c[0] === 'disable')).toEqual(['disable', '--now', SERVICE_NAME]);
    expect(names.indexOf('disable')).toBeLessThan(names.lastIndexOf('daemon-reload'));
  });
  it('preserves a user-modified unit and touches nothing, including systemd state', async () => {
    const o = setup(); const sc = fakeSystemctl();
    await installHubService({ ...o, enable: true, systemctl: sc.run });
    const edited = `${readFileSync(unitPathOf(o), 'utf8')}# user tweak\n`;
    writeFileSync(unitPathOf(o), edited);
    const before = sc.calls.length;
    await expect(uninstallHubService({ ...o, systemctl: sc.run })).rejects.toThrow('UNIT_MODIFIED');
    expect(readFileSync(unitPathOf(o), 'utf8')).toBe(edited);
    expect(existsSync(join(o.configDir, 'hub-service.json'))).toBe(true);
    expect(sc.calls).toHaveLength(before);
  });
  it('does nothing without an ownership record and never deletes an unowned unit', async () => {
    const o = setup(); const sc = fakeSystemctl();
    mkdirSync(o.unitDir, { recursive: true }); writeFileSync(unitPathOf(o), 'user unit');
    expect((await uninstallHubService({ ...o, systemctl: sc.run })).changed).toBe(false);
    expect(readFileSync(unitPathOf(o), 'utf8')).toBe('user unit');
    expect(sc.calls).toHaveLength(0);
  });
  it('keeps a retryable record when disable fails, and tolerates an already-missing unit', async () => {
    const o = setup();
    await installHubService({ ...o, enable: true, systemctl: fakeSystemctl().run });
    await expect(uninstallHubService({ ...o, systemctl: fakeSystemctl(['disable']).run })).rejects.toThrow('SERVICE_DISABLE_FAILED');
    expect(existsSync(unitPathOf(o))).toBe(true);
    expect(existsSync(join(o.configDir, 'hub-service.json'))).toBe(true);
    await uninstallHubService({ ...o, systemctl: fakeSystemctl().run });
    expect(existsSync(unitPathOf(o))).toBe(false);
    const p = setup(); const sc = fakeSystemctl();
    await installHubService({ ...p, systemctl: sc.run });
    (await import('node:fs')).unlinkSync(unitPathOf(p));
    expect((await uninstallHubService({ ...p, systemctl: sc.run })).changed).toBe(true);
    expect(existsSync(join(p.configDir, 'hub-service.json'))).toBe(false);
  });
});
