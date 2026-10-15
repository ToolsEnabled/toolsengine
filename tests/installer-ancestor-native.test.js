import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const native = process.platform === 'win32';
const shell = native ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
const available = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-Command','exit 0'], {timeout:10000,windowsHide:true}).status === 0;
test('installer refuses untrusted ancestor owners and replacement rights; raw DACL grants are interpreted conservatively', {skip:!available,timeout:30000}, () => {
  const run = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./support/installer-ancestor.mock.ps1',import.meta.url)),...(native ? ['-RawDescriptors'] : [])], {encoding:'utf8',timeout:25000,windowsHide:true});
  assert.equal(run.status,0,run.stderr || run.stdout);
  const result=JSON.parse(run.stdout.trim().replace(/^\uFEFF/,''));
  assert.equal(result.uiInvoked,false);
  assert.equal(result.passed,result.total);
  assert.ok(result.passed >= (native ? 37 : 13));
  assert.equal(result.rawDescriptors,native);
});
