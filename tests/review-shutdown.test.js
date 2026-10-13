import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../src/browser.js';
test('socket cleanup completes before waiting for slow browser shutdown',async t=>{
 assert.equal(typeof browser.closeBrowserResources,'function');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'slow-close-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sockets=path.join(root,'sockets');await fs.mkdir(sockets);
 let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
 const closing=browser.closeBrowserResources({removeTemp:()=>fs.rm(sockets,{recursive:true}),waitForOpening:async()=>{enter();await waiting;},resources:()=>[]});
 try{await entered;await assert.rejects(fs.stat(sockets),/ENOENT/);}finally{release();await closing;}
});
test('cleanup errors do not skip closing other owned resources',async()=>{
 assert.equal(typeof browser.closeBrowserResources,'function');
 const calls=[];
 await assert.rejects(browser.closeBrowserResources({removeTemp:async()=>{calls.push('temp');throw new Error('synthetic failure');},resources:()=>[{close:async()=>calls.push('context')},{close:async()=>calls.push('browser')}]}),/cleanup/);
 assert.deepEqual(calls,['temp','context','browser']);
});
