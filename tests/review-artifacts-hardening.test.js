import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createArtifactBudget,ARTIFACT_LIMITS} from '../src/artifacts.js';
async function fixture(t,limits=ARTIFACT_LIMITS){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'artifact-hardening-'));const budgets=[];
 t.after(async()=>{for(const budget of budgets)await budget.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,async open(){const budget=await createArtifactBudget(root,limits);budgets.push(budget);return budget;}};
}
test('simultaneous budgets reload the saved download count',async t=>{
 const f=await fixture(t,{...ARTIFACT_LIMITS,downloads:1});const one=await f.open(),two=await f.open();
 await one.writeDownload(path.join(one.output,'first'),'one');
 await assert.rejects(two.writeDownload(path.join(two.output,'second'),'two'),/download.*limit/);
 await assert.rejects(fs.stat(path.join(two.output,'second')),/ENOENT/);
});
test('failed index persistence leaves no new completed download',async t=>{
 const f=await fixture(t);const budget=await f.open();
 await fs.writeFile(path.join(f.root,'.toolsengine-runtime','artifact-index.json.'+process.pid+'.new'),'synthetic blocker');
 const file=path.join(budget.output,'failed');
 await assert.rejects(budget.writeDownload(file,'fixture'),/EEXIST/);
 await assert.rejects(fs.stat(file),/ENOENT/);
});
test('long explicit output paths cannot make the index unreadable',{skip:process.platform==='win32'?'POSIX long-path metadata fixture':false},async t=>{
 const f=await fixture(t);const budget=await f.open();
 const directory=path.join(f.root,...Array.from({length:14},(_,i)=>String(i)+'x'.repeat(238)));
 await fs.mkdir(directory,{recursive:true});
 for(let i=0;i<19;i++){const file=path.join(directory,'asset-'+i);budget.addOutput(file);await budget.write(file,'x');}
 const file=path.join(directory,'asset-19');budget.addOutput(file);
 await assert.rejects(budget.write(file,'x'),/index.*limit/);await assert.rejects(fs.stat(file),/ENOENT/);
 assert.ok((await fs.stat(path.join(f.root,'.toolsengine-runtime','artifact-index.json'))).size<=65536);
 await f.open();
});
