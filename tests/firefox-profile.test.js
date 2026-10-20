import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureAgentFirefoxProfile } from '../src/firefox-profile.js';

test('dedicated Firefox setup refuses an existing personal profile without changing its bytes or mode', {skip:process.platform!=='linux'}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-firefox-personal-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.writeFile(path.join(root,'cookies.sqlite'), 'personal-cookie-fixture');
  const before = (await fs.stat(root)).mode;
  await assert.rejects(ensureAgentFirefoxProfile(root), /nonempty Firefox profile/);
  assert.equal(await fs.readFile(path.join(root,'cookies.sqlite'),'utf8'), 'personal-cookie-fixture');
  assert.equal((await fs.stat(root)).mode, before);
  assert.deepEqual(await fs.readdir(root), ['cookies.sqlite']);
});

test('a profile symlink cannot redirect setup into another browser profile', {skip:process.platform!=='linux'}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-firefox-link-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const personal=path.join(root,'personal'); await fs.mkdir(personal);
  await fs.writeFile(path.join(personal,'user.js'),'original settings');
  const alias=path.join(root,'agent'); await fs.symlink(personal,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(ensureAgentFirefoxProfile(alias),/plain directories/);
  assert.equal(await fs.readFile(path.join(personal,'user.js'),'utf8'),'original settings');
});

test('a new dedicated profile stays private and does not turn off the browser sandbox', async t => {
  if(process.platform!=='linux') return t.skip('Firefox mode requires Linux');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'te-firefox-private-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const agent=path.join(root,'agent');await ensureAgentFirefoxProfile(agent);
  assert.equal((await fs.stat(agent)).mode&0o777,0o700);
  const prefs=await fs.readFile(path.join(agent,'user.js'),'utf8');
  assert.doesNotMatch(prefs,/sandbox\.content\.level/);
  await fs.appendFile(path.join(agent,'user.js'),'user_pref("security.sandbox.content.level", 0);\n');
  await assert.rejects(ensureAgentFirefoxProfile(agent),/disables its content sandbox/);
});
