import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const shell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
const available = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
for (const name of ['dialog', 'combobox', 'focus', 'pointer']) {
  test(`native ${name} behavior with inert platform providers`, { skip: !available, timeout: 30000 }, () => {
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'support', `desktop-${name}.mock.ps1`)], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const answer = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
    assert.equal(answer.passed, answer.total);
    assert.ok(answer.total >= 6);
    assert.equal(answer.uiInvoked, false);
  });
}
