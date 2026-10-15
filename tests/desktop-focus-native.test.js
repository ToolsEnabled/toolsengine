// Native focus regression tests extract helper functions by AST and replace every
// UI/Win32 dependency with inert doubles. They never run the desktop helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'pwsh';
const available = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
  { encoding: 'utf8', timeout: 10000, windowsHide: true });
for (const fixture of ['desktop-focus.mock.ps1', 'desktop-diagnostics.mock.ps1']) {
  test(`inert native regression: ${fixture}`, {
    skip: available.status !== 0 ? 'PowerShell is unavailable on this platform; run these tests on Windows' : false,
    timeout: 60000,
  }, () => {
    const run = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL(`./support/${fixture}`, import.meta.url))],
      { encoding: 'utf8', timeout: 55000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.replace(/^\uFEFF/, ''));
    assert.equal(result.uiInvoked, false);
    assert.ok(result.passed > 0);
    assert.equal(result.passed, result.total);
  });
}
