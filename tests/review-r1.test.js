import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseConfig} from '../src/config.js';
import {profileInsideWorkspace, browserFile} from '../src/browser.js';
test('R1 profile equal to or containing workspace is refused; all profile spellings are protected', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r1-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await assert.rejects(parseConfig(['--workspace',root,'--profile-dir',root]),/profile.*contain|contain.*profile/i);
 await fs.writeFile(path.join(root,'.toolsengine-profile'),'ToolsEngine dedicated profile v1\n');
 const child=path.join(root,'Default');await fs.mkdir(child);
 await assert.rejects(parseConfig(['--workspace',child,'--profile-dir',root]),/profile.*contain|contain.*profile/i);
 assert.deepEqual(await profileInsideWorkspace(child,root),[root]);
 await assert.rejects(browserFile(child,'new.png',{protectedFolders:[root]}),/profile folder/);
 const outside=path.join(root,'outside');await fs.mkdir(outside);
 assert.deepEqual(await profileInsideWorkspace(child,outside),[outside]);
});
