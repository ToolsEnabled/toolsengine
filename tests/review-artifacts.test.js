import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../src/browser.js';
test('P6 artifact number, total bytes and per-file bounds refuse before writing, including append and explicit outputs',async t=>{
 assert.equal(typeof browser.createArtifactBudget,'function');const root=await fs.mkdtemp(path.join(os.tmpdir(),'quota-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const budget=await browser.createArtifactBudget(root,{files:3,bytes:10,fileBytes:8,downloads:1});t.after(()=>budget.close());
 const output=path.join(root,'artifacts','toolsengine');await fs.writeFile(path.join(output,'one'),'123456');
 await assert.rejects(fs.appendFile(path.join(output,'one'),'12345'),/limit/);assert.equal(await fs.readFile(path.join(output,'one'),'utf8'),'123456');
 await assert.rejects(fs.writeFile(path.join(output,'one'),'overwrite'),/exists/);
 const explicit=path.join(root,'explicit.png');budget.addOutput(explicit);await fs.writeFile(explicit,'12');
 await assert.rejects(fs.writeFile(path.join(output,'large'),'123456789'),/limit/);await assert.rejects(fs.stat(path.join(output,'large')),/ENOENT/);
 await fs.writeFile(path.join(output,'last'),'12');await assert.rejects(fs.writeFile(path.join(output,'overflow'),'1'),/limit/);
 await budget.close();const resumed=await browser.createArtifactBudget(root,{files:3,bytes:10,fileBytes:8,downloads:1});t.after(()=>resumed.close());
 const another=path.join(root,'another.png');assert.throws(()=>resumed.addOutput(another),/limit/);
});
test('P6 download reservations bound concurrent bytes and count and oversized saves are rejected',async t=>{
 assert.equal(typeof browser.createArtifactBudget,'function');const root=await fs.mkdtemp(path.join(os.tmpdir(),'downloads-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const budget=await browser.createArtifactBudget(root,{files:3,bytes:10,fileBytes:8,downloads:1});t.after(()=>budget.close());
 const slot=budget.reserveDownload();assert.throws(()=>budget.reserveDownload(),/limit/);slot.release();
 const file=path.join(root,'artifacts','toolsengine','download-fixture');await budget.writeDownload(file,Buffer.from('123'));assert.throws(()=>budget.reserveDownload(),/limit/);
});
