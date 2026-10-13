import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {foldersOverlap,folderContains} from '../src/config.js';
import {foldersOverlap as installerOverlap} from '../installer/install.mjs';
import {browserFile} from '../src/browser.js';
test('R5 unavailable and ambiguous filesystem identities cannot prove separation',async()=>{
 const one=path.resolve('/model/one'),two=path.resolve('/other/two');
 await assert.rejects(foldersOverlap(one,two,{identify:async()=>null}),/identity|separation/i);
 assert.throws(()=>installerOverlap(one,two,{identify:()=>null}),/identity|separation/i);
 await assert.rejects(foldersOverlap(one,two,{identify:async()=> 'reused'}),/identity|separation/i);
 assert.throws(()=>installerOverlap(one,two,{identify:()=> 'reused'}),/identity|separation/i);
});
test('R5 missing descendants are compared through their existing parents',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r5-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'one'));await fs.mkdir(path.join(root,'two'));
 assert.equal(await foldersOverlap(path.join(root,'one','new'),path.join(root,'two','new')),false);
 assert.equal(installerOverlap(path.join(root,'one','new'),path.join(root,'two','new')),false);
 assert.equal(await folderContains(path.join(root,'one'),path.join(root,'one','new')),true);
});
