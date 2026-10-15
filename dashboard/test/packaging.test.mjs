// Packaging logic (scripts/lib/*, scripts/package.mjs) tested against synthetic trees only.
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { run } from "../../scripts/lib/run.mjs";
import { createTar, createTarGz } from "../../scripts/lib/archive.mjs";
import { PackageError, inspectFrontend } from "../../scripts/lib/frontend.mjs";
import { assertSafeInputs, classify, contentProblems } from "../../scripts/lib/rules.mjs";
import { APK_BUDGET_BYTES, packageProject } from "../../scripts/lib/package-build.mjs";

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-monitor-pkg-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const put = (root, path, data = "x") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
};
const INDEX = '<!doctype html><html><head><link rel="stylesheet" href="./assets/a.css"><script type="module" src="./assets/a.js"></script></head><body></body></html>';
function frontend(root, { js = "console.log(1)", css = "body{}" } = {}) {
  put(root, "dashboard/dist/index.html", INDEX);
  put(root, "dashboard/dist/assets/a.js", js);
  put(root, "dashboard/dist/assets/a.css", css);
}
function project(root, { withApk } = {}) {
  frontend(root);
  put(root, "package.json", '{"name":"x","private":true}');
  put(root, "package-lock.json", "{}");
  put(root, ".nvmrc", "24.22.0\n");
  put(root, "desktop/package.json", '{"name":"@phone-monitor/desktop","version":"1.2.3"}');
  put(root, "packages/protocol/package.json", "{}");
  put(root, "dashboard/package.json", "{}");
  put(root, "desktop/dist/main.js", "export {};");
  put(root, "desktop/dist/main.d.ts", "export {};");
  put(root, "packages/protocol/dist/index.js", "export {};");
  put(root, "docs/SETUP.md", "# setup");
  put(root, "docs/TESTING.md", "# testing");
  for (const name of ["workspace", "doctor", "connect", "install-hub", "uninstall-hub", "claude-install", "claude-uninstall"]) put(root, `scripts/${name}.mjs`, "");
  put(root, "scripts/lib/dist.mjs", "");
  if (withApk) put(root, `artifacts/${withApk.name}`, Buffer.alloc(withApk.size, 1));
}
const message = (fn) => {
  try { fn(); } catch (error) { return error instanceof PackageError ? error.problems.join("\n") : String(error); }
  return "";
};
const sha = (data) => createHash("sha256").update(data).digest("hex");

describe("run helper", () => {
  it("runs a structured command and returns on success", () => {
    expect(() => run(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })).not.toThrow();
  });
  it("propagates a nonzero exit as an error carrying the status", () => {
    try {
      run(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error.status).toBe(7);
    }
  });
  it("never interprets arguments through a shell", () => {
    const marker = join(temp(), "created-by-shell");
    run(process.execPath, ["-e", "process.exit(process.argv[1] === process.argv[2] ? 0 : 9)", `;touch ${marker}`, `;touch ${marker}`], { stdio: "ignore" });
    expect(existsSync(marker)).toBe(false);
  });
  it("rejects a single command string and non-string arguments", () => {
    expect(() => run("node -e 1", "")).toThrow(TypeError);
    expect(() => run(process.execPath, [1])).toThrow(TypeError);
    expect(() => run("", [])).toThrow(TypeError);
  });
  it("reports a missing executable", () => {
    expect(() => run("/nonexistent/phone-monitor-tool", [], { stdio: "ignore" })).toThrow();
  });
});

describe("deterministic archive", () => {
  const entries = [
    { path: "top/b.txt", data: Buffer.from("beta") },
    { path: "top/a.txt", data: Buffer.from("alpha") },
  ];
  it("is byte-identical regardless of input order and has zeroed metadata", () => {
    const one = createTarGz(entries), two = createTarGz([...entries].reverse());
    expect(sha(one)).toBe(sha(two));
    const tar = createTar(entries);
    expect(tar.subarray(0, 100).toString().replace(/\0+$/, "")).toBe("top/a.txt");
    expect(tar.subarray(136, 148).toString()).toBe("00000000000\0"); // mtime 0
    expect(tar.subarray(108, 116).toString()).toBe("0000000\0"); // uid 0
    expect(gunzipSync(one).length % 512).toBe(0);
  });
  it("refuses unsafe or duplicate member names", () => {
    for (const path of ["/abs", "a/../b", "x\0y"]) expect(() => createTar([{ path, data: "" }])).toThrow(/Unsafe/);
    expect(() => createTar([entries[0], entries[0]])).toThrow(/Duplicate/);
  });
});

describe("frontend verification", () => {
  it("rejects an absent production bundle", () => {
    expect(message(() => inspectFrontend(join(temp(), "dist")))).toMatch(/missing/);
  });
  it("rejects a dist without index.html or without script/style references", () => {
    const root = temp();
    put(root, "dist/assets/a.js", "1");
    expect(message(() => inspectFrontend(join(root, "dist")))).toMatch(/index\.html/);
    put(root, "dist/index.html", "<html></html>");
    expect(message(() => inspectFrontend(join(root, "dist")))).toMatch(/no script bundle[\s\S]*no stylesheet/);
  });
  it("rejects a referenced asset that is absent or escapes dist", () => {
    const root = temp();
    put(root, "dist/index.html", INDEX.replace("a.js", "../../x.js"));
    put(root, "dist/assets/a.css", "a{}");
    expect(message(() => inspectFrontend(join(root, "dist")))).toMatch(/missing asset/);
  });
  it.each([
    ["mock adapter", "export const createMockAdapter=1"],
    ["mock module path", 'import("./mocks/device.js")'],
    ["synthetic data", 'const n="Synthetic app"'],
    ["demo switch", 'if(new URLSearchParams(location.search).has("demo")){}'],
    ["diagnostic UI", "const d='Diagnostic UI'"],
  ])("rejects %s in the bundle", (_, js) => {
    const root = temp();
    frontend(root, { js });
    expect(message(() => inspectFrontend(join(root, "dashboard/dist")))).toMatch(/a\.js contains/);
  });
  it("rejects remote URLs but allows non-fetched XML/schema identifiers", () => {
    const root = temp();
    frontend(root, { js: 'fetch("https://example.invalid/x")' });
    expect(message(() => inspectFrontend(join(root, "dashboard/dist")))).toMatch(/remote URL https:\/\/example\.invalid/);
    const ok = temp();
    frontend(ok, { js: 'const s="http://www.w3.org/2000/svg",j="https://json-schema.org/draft/2020-12/schema",r="https://react.dev/errors/"' });
    expect(inspectFrontend(join(ok, "dashboard/dist")).jsCssBytes).toBeGreaterThan(0);
  });
  it("rejects remote stylesheet imports and protocol-relative CSS urls", () => {
    const root = temp();
    frontend(root, { css: '@import url("//cdn.invalid/a.css");' });
    expect(message(() => inspectFrontend(join(root, "dashboard/dist")))).toMatch(/protocol-relative/);
  });
  it("rejects source maps and symbolic links", () => {
    const root = temp();
    frontend(root);
    put(root, "dashboard/dist/assets/a.js.map", "{}");
    expect(message(() => inspectFrontend(join(root, "dashboard/dist")))).toMatch(/Source map/);
    const linked = temp();
    frontend(linked);
    symlinkSync("/etc/hostname", join(linked, "dashboard/dist/assets/link.txt"));
    expect(message(() => inspectFrontend(join(linked, "dashboard/dist")))).toMatch(/Symbolic link/);
  });
  it("enforces the JS+CSS budget exactly", () => {
    const root = temp();
    frontend(root, { js: "a".repeat(1000), css: "" });
    const dist = join(root, "dashboard/dist");
    expect(inspectFrontend(dist, { budgetBytes: 1000 }).jsCssBytes).toBe(1000);
    expect(message(() => inspectFrontend(dist, { budgetBytes: 999 }))).toMatch(/1000 bytes; budget is 999/);
  });
});

describe("exclusion rules", () => {
  it.each([
    ".env", ".env.local", "desktop/dist/.config/x.json", "node_modules/a/index.js", ".git/config",
    "desktop/dist/id_rsa", "desktop/dist/server.pem", "desktop/dist/phone-token", "desktop/dist/token.js",
    "desktop/dist/auth.json", "tools/node", "toolchains/node-v24/bin/node", ".superpowers/toolchain.json",
    "local.properties", "release.jks", "../outside.js", "/abs.js", "a\\b.js",
  ])("forbids %s", (path) => expect(classify(path)).toBe("forbidden"));
  it.each(["desktop/dist/main.d.ts", "desktop/dist/main.test.js", "tsconfig.tsbuildinfo"])("skips %s", (path) => expect(classify(path)).toBe("skip"));
  it.each(["desktop/dist/main.js", "docs/SETUP.md", "package-lock.json", "scripts/lib/dist.mjs"])("includes %s", (path) => expect(classify(path)).toBe("include"));
  it("rejects absolute home paths and private keys in shipped content", () => {
    expect(contentProblems("a.js", "const p='/home/someone/.config/x/'")).toHaveLength(1);
    expect(contentProblems("a.json", "-----BEGIN OPENSSH PRIVATE KEY-----")).toHaveLength(1);
    expect(contentProblems("a.png", "/home/someone/")).toHaveLength(0);
    expect(message(() => assertSafeInputs([{ path: "x/.env", data: "A=1" }]))).toMatch(/forbidden path/);
  });
});

describe("packageProject", () => {
  it("writes a verifiable tarball, manifest and SHA256SUMS and tolerates a missing APK", () => {
    const root = temp();
    project(root);
    const result = packageProject({ root });
    const out = join(root, "artifacts");
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums).toHaveLength(2);
    for (const line of sums) {
      const [hash, file] = line.split(/  /);
      expect(sha(readFileSync(join(out, file)))).toBe(hash);
    }
    const manifest = JSON.parse(readFileSync(join(out, "phone-monitor-manifest.json"), "utf8"));
    expect(manifest.apk.present).toBe(false);
    expect(manifest.apk.note).toMatch(/No artifacts/);
    expect(manifest.tarball.sha256).toBe(sha(readFileSync(join(out, result.tarballName))));
    expect(manifest.frontend.jsCssBytes).toBeGreaterThan(0);
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain("phone-monitor-desktop-1.2.3/desktop/dist/main.js");
    expect(paths).toContain("phone-monitor-desktop-1.2.3/INSTALL.txt");
    expect(paths.some((path) => path.endsWith(".d.ts"))).toBe(false);
    expect(paths.some((path) => path.includes("dashboard/dist"))).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/\d{4}-\d\d-\d\dT/); // no timestamps
    const tar = gunzipSync(readFileSync(join(out, result.tarballName))).toString("latin1");
    expect(tar).toContain("npm ci --omit=dev --workspace @phone-monitor/desktop");
  });
  it("is reproducible: two builds give identical bytes and checksums", () => {
    const first = temp(), second = temp();
    project(first); project(second);
    packageProject({ root: first }); packageProject({ root: second });
    for (const file of ["SHA256SUMS", "phone-monitor-manifest.json", "phone-monitor-desktop-1.2.3.tar.gz"])
      expect(readFileSync(join(first, "artifacts", file)).equals(readFileSync(join(second, "artifacts", file)))).toBe(true);
    packageProject({ root: first }); // idempotent over its own output directory
    expect(readFileSync(join(first, "artifacts/SHA256SUMS"), "utf8")).toBe(readFileSync(join(second, "artifacts/SHA256SUMS"), "utf8"));
  });
  it("includes an APK within budget in the checksums", () => {
    const root = temp();
    project(root, { withApk: { name: "phone-monitor-debug.apk", size: 2048 } });
    packageProject({ root });
    const sums = readFileSync(join(root, "artifacts/SHA256SUMS"), "utf8");
    expect(sums).toContain("phone-monitor-debug.apk");
    expect(JSON.parse(readFileSync(join(root, "artifacts/phone-monitor-manifest.json"), "utf8")).apk.files[0].size).toBe(2048);
  });
  it("refuses an APK over 20 MiB, a diagnostic APK, and writes nothing", () => {
    const big = temp();
    project(big, { withApk: { name: "phone-monitor-release.apk", size: APK_BUDGET_BYTES + 1 } });
    expect(message(() => packageProject({ root: big }))).toMatch(/budget is 20971520/);
    expect(existsSync(join(big, "artifacts/SHA256SUMS"))).toBe(false);
    const diagnostic = temp();
    project(diagnostic, { withApk: { name: "phone-monitor-diagnostic.apk", size: 10 } });
    expect(message(() => packageProject({ root: diagnostic }))).toMatch(/Diagnostic APK/);
  });
  it("refuses absent or diagnostic frontend assets", () => {
    const absent = temp();
    project(absent);
    rmSync(join(absent, "dashboard/dist"), { recursive: true });
    expect(message(() => packageProject({ root: absent }))).toMatch(/dashboard bundle is missing/);
    const demo = temp();
    project(demo);
    put(demo, "dashboard/dist/assets/a.js", "createMockAdapter()");
    expect(message(() => packageProject({ root: demo }))).toMatch(/mock device adapter/);
    expect(existsSync(join(demo, "artifacts"))).toBe(false);
  });
  it("refuses unbuilt desktop output", () => {
    const root = temp();
    project(root);
    rmSync(join(root, "desktop/dist/main.js"));
    expect(message(() => packageProject({ root }))).toMatch(/main\.js is missing/);
  });
  it.each([
    ["desktop/dist/.env", "TOKEN=1"],
    ["desktop/dist/phone-token", "abc"],
    ["desktop/dist/.config/phone-monitor/x.json", "{}"],
    ["desktop/dist/node", "binary"],
    ["desktop/dist/server.pem", "k"],
  ])("fails closed when %s is among the inputs", (path, data) => {
    const root = temp();
    project(root);
    put(root, path, data);
    expect(message(() => packageProject({ root }))).toMatch(/forbidden path/);
    expect(existsSync(join(root, "artifacts/SHA256SUMS"))).toBe(false);
  });
  it("fails when shipped code embeds a home-directory path", () => {
    const root = temp();
    project(root);
    put(root, "desktop/dist/main.js", "const p='/home/someone/.config/phone-monitor/'");
    expect(message(() => packageProject({ root }))).toMatch(/home-directory path/);
  });
});
