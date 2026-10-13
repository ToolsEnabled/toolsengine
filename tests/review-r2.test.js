import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as browser from '../src/browser.js';
test('R2 runtime is physically protected in temporary mode, including alias uploads and outputs', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const runtime=path.join(root,'.toolsengine-runtime');await fs.mkdir(runtime);await fs.writeFile(path.join(runtime,'fixture'),'synthetic');
 const folders=typeof browser.browserProtectedFolders==='function'?await browser.browserProtectedFolders(root):[];
 assert.deepEqual(folders,[runtime]);
 const alias=path.join(root,'TOOLS~1');const stat=fs.lstat,real=fs.realpath;
 fs.lstat=(p,...args)=>stat(String(p).replace(alias,runtime),...args);
 fs.realpath=(p,...args)=>real(String(p).replace(alias,runtime),...args);
 try {
  await assert.rejects(browser.browserFile(root,'TOOLS~1/fixture',{input:true,protectedFolders:folders}),/profile|Hidden/);
  await assert.rejects(browser.browserFile(root,'TOOLS~1/new.png',{protectedFolders:folders}),/profile|Hidden/);
 } finally {fs.lstat=stat;fs.realpath=real;}
});
test('R2 actual Windows runtime short alias is refused when available',{skip:process.platform!=='win32'?'NTFS short aliases require Windows':false},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'r2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const runtime=path.join(root,'.toolsengine-runtime');await fs.mkdir(runtime);await fs.writeFile(path.join(runtime,'fixture'),'synthetic');
 const result=spawnSync('cmd.exe',['/d','/c',`for %I in ("${runtime}") do @echo %~sI`],{encoding:'utf8',windowsHide:true});
 const alias=result.stdout?.trim();
 if(result.status!==0||!alias||alias.toLowerCase()===runtime.toLowerCase())return t.skip('8.3 alias unavailable on this volume');
 const protectedFolders=await browser.browserProtectedFolders(root);
 await assert.rejects(browser.browserFile(root,path.join(alias,'fixture'),{input:true,protectedFolders}));
 await assert.rejects(browser.browserFile(root,path.join(alias,'new.png'),{protectedFolders}));
});
