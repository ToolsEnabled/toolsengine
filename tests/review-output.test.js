import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseConfig} from '../src/config.js';
import {createBrowserBridge} from '../src/browser.js';
test('R1-output profiles cannot overlap implicit artifacts or runtime in either direction',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'out-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const rel of ['artifacts','artifacts/toolsengine','artifacts/toolsengine/profile','.toolsengine-runtime','.toolsengine-runtime/profile']){
  await assert.rejects(parseConfig(['--workspace',root,'--profile-dir',path.join(root,rel)]),/profile.*overlap/i);
  // The refusal comes before the folder is made: nothing is left in the workspace.
  assert.deepEqual(await fs.readdir(root),[],`a refused --profile-dir ${rel} created its folders`);
 }
 // Through a link to the workspace, the refusal also comes before anything is created.
 const linked=path.join(os.tmpdir(),`out-link-${process.pid}`);await fs.symlink(root,linked,'dir');t.after(()=>fs.rm(linked,{force:true}));
 await assert.rejects(parseConfig(['--workspace',root,'--profile-dir',path.join(linked,'artifacts','toolsengine','profile')]),/profile.*overlap|links or junctions/i);
 assert.deepEqual(await fs.readdir(root),[]);
 const engine=await createBrowserBridge({workspace:root,profileDir:path.join(root,'artifacts','toolsengine')}).then(b=>{b.close();return b;},e=>e);
 assert.ok(engine instanceof Error);assert.match(engine.message,/profile.*overlap/i);
});
