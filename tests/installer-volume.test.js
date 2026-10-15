import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const shell=process.platform==='win32'?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'pwsh';
const available=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command','exit 0'],{timeout:10000,windowsHide:true}).status===0;
test('fixed local NTFS gates refuse failed volume queries and every other drive/filesystem type',{skip:!available,timeout:30000},()=>{
 const run=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./support/installer-volume.mock.ps1',import.meta.url))],{encoding:'utf8',timeout:25000,windowsHide:true});
 assert.equal(run.status,0,run.stderr||run.stdout);const result=JSON.parse(run.stdout.trim().replace(/^\uFEFF/,''));assert.equal(result.passed,18);assert.equal(result.total,18);assert.equal(result.nativeCalls,false);
});
