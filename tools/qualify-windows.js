// Run in an interactive native Windows account before publishing its archive.
// The receipt binds the extracted release, source tests and installed runtime.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareWithRelease } from '../installer/install.mjs';
import { PACKAGE_FILES } from './package-files.js';

export function judgeDesktopRun({ status, output }) {
  const text = String(output);
  const count = name => Number(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm').exec(text)?.[1] ?? NaN);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, count(name)]));
  const ok = status === 0 && counts.tests === 8 && counts.pass === 8
    && ['fail', 'cancelled', 'skipped', 'todo'].every(name => counts[name] === 0)
    && !/^\s*not ok \d+ - /m.test(text);
  return { ok, counts };
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function qualifyWindows({ releaseFolder, outputFolder }) {
  assert.equal(process.platform, 'win32', 'Qualification requires native Windows.');
  assert.equal(process.arch, 'x64');
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const session = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::WriteLine((@{interactive=[Environment]::UserInteractive;sessionId=(Get-Process -Id $PID).SessionId}|ConvertTo-Json -Compress))'],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(session.status, 0, session.stderr);
  const desktop = JSON.parse(session.stdout);
  assert.equal(desktop.interactive, true, 'Run from the signed-in interactive desktop.');
  assert.ok(desktop.sessionId > 0, 'Session zero cannot qualify desktop tools.');
  const releaseFile = path.join(releaseFolder, 'release.json');
  const releaseBytes = fs.readFileSync(releaseFile);
  const release = JSON.parse(releaseBytes);
  assert.equal(release.target, 'windows-x64');
  assert.deepEqual(compareWithRelease(release, releaseFolder), []);
  // The tests must describe these exact runtime bytes, not another checkout.
  for (const name of PACKAGE_FILES) {
    assert.deepEqual(fs.readFileSync(path.join(source, name)),
      fs.readFileSync(path.join(releaseFolder, 'app', name)), `Source differs: ${name}`);
  }
  const testFiles = ['tests/desktop-live.windows.test.js', 'tests/support/desktop-fixture.cs'];
  const tests = testFiles.map(name => ({ path: name, sha256: sha(fs.readFileSync(path.join(source, name))) }));
  fs.mkdirSync(outputFolder, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.userInfo().homedir, 'toolsengine-native-install-'));
  const installed = path.join(home, 'ToolsEngine', release.version);
  const run = (args, env = process.env) => spawnSync(process.execPath, args, {
    cwd: source, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  let removed = false;
  try {
    const setup = run([path.join(releaseFolder, 'install.mjs'), '--home', home, '--browser', 'none', '--desktop']);
    fs.writeFileSync(path.join(outputFolder, 'install.txt'), setup.stdout + setup.stderr);
    assert.equal(setup.status, 0, 'Native installer failed; inspect install.txt.');
    assert.deepEqual(compareWithRelease(release, installed), []);
    const record = JSON.parse(fs.readFileSync(path.join(installed, 'installation.json')));
    assert.equal(record.node, process.execPath);
    assert.equal(record.entry, path.join(installed, 'app', 'bin', 'toolsengine.js'));
    const result = run(['--test', '--test-reporter=tap', ...testFiles.slice(0, 1)], {
      ...process.env, TOOLSENGINE_DESKTOP_LIVE: '1', TOOLSENGINE_TEST_ENTRY: record.entry,
    });
    fs.writeFileSync(path.join(outputFolder, 'desktop.tap'), result.stdout + result.stderr);
    const verdict = judgeDesktopRun({ status: result.status, output: result.stdout });
    assert.ok(verdict.ok, 'Native desktop qualification failed; inspect desktop.tap.');
    assert.deepEqual(compareWithRelease(release, installed), []);
    const uninstall = run([path.join(installed, 'install.mjs'), 'uninstall']);
    fs.writeFileSync(path.join(outputFolder, 'uninstall.txt'), uninstall.stdout + uninstall.stderr);
    assert.equal(uninstall.status, 0, 'Native uninstall failed; inspect uninstall.txt.');
    assert.equal(fs.existsSync(installed), false);
    removed = true;
    assert.deepEqual(compareWithRelease(release, releaseFolder), []);
    assert.deepEqual(fs.readFileSync(releaseFile), releaseBytes);
    for (const entry of tests) assert.equal(sha(fs.readFileSync(path.join(source, entry.path))), entry.sha256);
    const receipt = {
      schemaVersion: 1, target: 'windows-x64', commit: release.commit, version: release.version,
      releaseJsonSha256: sha(releaseBytes), node: process.version, desktop, tests,
      desktopTests: verdict.counts, install: 'passed', uninstall: 'passed', qualifiedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outputFolder, 'windows-qualification.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } finally {
    // Keep an unsuccessful installation and its evidence for diagnosis.
    if (removed) fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseFolder, outputFolder, ...extra] = process.argv.slice(2);
  assert.ok(releaseFolder && outputFolder && !extra.length,
    'Usage: node tools/qualify-windows.js EXTRACTED_RELEASE NEW_EVIDENCE_FOLDER');
  console.log(JSON.stringify(qualifyWindows({ releaseFolder: path.resolve(releaseFolder), outputFolder: path.resolve(outputFolder) })));
}
