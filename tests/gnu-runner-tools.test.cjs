"use strict";
// The GNU tool stand-ins that release workflow tests use off Linux. On Linux,
// the same cases also run against the system tools to show parity.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { TOOLS_DIR } = require("./helpers/gnu-runner-tools.cjs");

const implementations = (name) => [
  ["stand-in", path.join(TOOLS_DIR, name)],
  ...(process.platform === "linux" ? [["system", name]] : []),
];
const run = (command, args) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 20000 });
// The status a shell reports: the exit code, or 128 plus the signal number.
const shellStatus = ({ status, signal }) =>
  status ?? 128 + os.constants.signals[signal];
const node = (code) => [process.execPath, "-e", code];

for (const [label, timeout] of implementations("timeout")) {
  test(`${label} timeout passes the command's exit status through`, () => {
    const result = run(timeout, ["5s", ...node("process.exit(3)")]);
    assert.equal(result.status, 3);
    assert.equal(run(timeout, ["1m", ...node("")]).status, 0);
  });

  test(`${label} timeout exits 124 when the command runs too long`, () => {
    const started = Date.now();
    const result = run(timeout, ["0.3s", ...node("setInterval(() => {}, 1000)")]);
    assert.equal(result.status, 124);
    assert.ok(Date.now() - started < 5000);
  });

  test(`${label} timeout --kill-after sends SIGKILL to a command that ignores SIGTERM`, () => {
    // exec leaves no child of sh to outlive the KILL and hold stdout open.
    const ignoreTerm = ["sh", "-c", "trap '' TERM; exec sleep 30"];
    const started = Date.now();
    const result = run(timeout, ["--kill-after=0.3s", "1s", ...ignoreTerm]);
    assert.equal(shellStatus(result), 137);
    assert.ok(Date.now() - started < 5000);
  });

  test(`${label} timeout exits 127 when the command is missing`, () => {
    assert.equal(run(timeout, ["5s", "adcp-no-such-command"]).status, 127);
  });

  test(`${label} timeout exits 125 on an invalid interval`, () => {
    assert.equal(run(timeout, ["5x", "true"]).status, 125);
  });
}

test("stand-in timeout refuses options it doesn't implement", () => {
  const result = run(path.join(TOOLS_DIR, "timeout"), ["-s", "KILL", "5s", "true"]);
  assert.equal(result.status, 125);
  assert.match(result.stderr, /unsupported option '-s'/);
});

for (const [label, stat] of implementations("stat")) {
  test(`${label} stat -c %a prints octal access rights`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnu-runner-stat-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "body");
    fs.writeFileSync(file, "x");
    fs.chmodSync(file, 0o600);
    assert.equal(run(stat, ["-c", "%a", file]).stdout, "600\n");
    fs.chmodSync(dir, 0o1755);
    assert.equal(run(stat, ["-c", "mode=%a", dir]).stdout, "mode=1755\n");
    const missing = run(stat, ["-c", "%a", path.join(dir, "missing")]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
  });
}

test("stand-in stat refuses forms it doesn't implement", () => {
  const stat = path.join(TOOLS_DIR, "stat");
  assert.equal(run(stat, ["-c", "%s", __filename]).status, 1);
  assert.equal(run(stat, ["-f", "%Lp", __filename]).status, 1);
});
