import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../src/browser.js';
test('review temp: short Linux browser sockets stay in their workspace',{skip:process.platform!=='linux'},async t=>{
 assert.equal(typeof browser.workspaceSocketTemp,'function');const root=await fs.mkdtemp(path.join(os.tmpdir(),'socket-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const temp=await browser.workspaceSocketTemp(root);try{assert.ok(temp.envPath.length<58);assert.equal(await fs.realpath(temp.envPath),temp.directory);assert.ok(temp.directory.startsWith(root+path.sep));await fs.writeFile(path.join(temp.envPath,'fixture'),'x');assert.equal(await fs.readFile(path.join(temp.directory,'fixture'),'utf8'),'x');}finally{await temp.close();}
 await assert.rejects(fs.stat(temp.directory),/ENOENT/);
});
