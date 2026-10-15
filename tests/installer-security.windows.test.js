import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { windowsDirectorySecurity, Stop } from '../installer/install.mjs';

const native = process.platform === 'win32';
const options = { skip: native ? false : 'native Windows DACL test', timeout: 60000 };
const shell = () => path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

test('native installer creates private DACLs and refuses existing broadly writable roots without modifying them', options, t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolsengine-acl-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'private root', 'program');
  const created = windowsDirectorySecurity(directory, { create: true });
  assert.equal(created.private, true);
  assert.equal(created.fileSystem, 'NTFS');
  assert.equal(created.fixedDrive, true);
  assert.equal(created.writeRestricted, true);
  assert.equal(created.ownedByUser, true);
  assert.equal(created.protected, true);
  assert.equal(windowsDirectorySecurity(directory).private, true);
  fs.writeFileSync(path.join(directory, 'sentinel.txt'), 'preserve me');
  const widen = String.raw`$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $a=[IO.Directory]::GetAccessControl($p); $s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object Security.AccessControl.FileSystemAccessRule($s,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow); $null=$a.AddAccessRule($r); [IO.Directory]::SetAccessControl($p,$a); [Console]::WriteLine($a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))`;
  const changed = spawnSync(shell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(widen, 'utf16le').toString('base64')], { input: directory, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(changed.status, 0, changed.stderr);
  assert.throws(() => windowsDirectorySecurity(directory), Stop, 'an outside account can change the existing directory itself');
  assert.throws(() => windowsDirectorySecurity(directory, { create: true }), Stop);
  const readAcl = String.raw`$p=[Console]::In.ReadToEnd(); [Console]::WriteLine([IO.Directory]::GetAccessControl($p).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))`;
  const unchanged = spawnSync(shell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(readAcl, 'utf16le').toString('base64')], { input: directory, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.stdout.trim(), changed.stdout.trim(), 'refusal changed the existing ACL');
  assert.equal(fs.readFileSync(path.join(directory, 'sentinel.txt'), 'utf8'), 'preserve me');
  assert.throws(() => windowsDirectorySecurity(path.join(directory, 'child'), { create: true }), Stop);
  assert.equal(fs.existsSync(path.join(directory, 'child')), false);
});

test('native installer refuses junction ancestors and nonlocal namespace paths before creating a folder', options, t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolsengine-acl-path-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const junction = path.join(base, 'junction');
  fs.symlinkSync(outside, junction, 'junction');
  assert.throws(() => windowsDirectorySecurity(path.join(junction, 'child'), { create: true }), Stop);
  assert.equal(fs.readdirSync(outside).length, 0);
  for (const directory of ['C:relative', '\\root-relative', '\\\\server\\share\\child', '\\\\?\\C:\\child', `${outside}:stream`])
    assert.throws(() => windowsDirectorySecurity(directory, { create: true }), Stop, directory);
});
