import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../src/browser.js';
import { EventEmitter } from 'node:events';

test('a removed download inode is rechecked without losing replacement safety or pending events', async t => {
 const regular=(nlink=1,size=10)=>({nlink,size,isFile:()=>true,isSymbolicLink:()=>false});
 const symlink=()=>({nlink:1,size:10,isFile:()=>false,isSymbolicLink:()=>true});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 async function probe(values,{during=false,close=false,watchError=false}={}){
  let event,resolveFirst,reads=0;const reasons=[],watcher=new EventEmitter();
  watcher.close=()=>{};
  const observer=browser.observeOwnedDownloadDirectory(path.resolve(os.tmpdir(),'synthetic-download-watch'),1024,
   reason=>reasons.push(reason),{
    watchDirectory:(_root,callback)=>{event=callback;return watcher;},
    statFile:async()=>{
     const index=reads++;
     if(during&&index===0)await new Promise(resolve=>resolveFirst=resolve);
     const value=values[Math.min(index,values.length-1)];
     if(value instanceof Error)throw value;
     return value;
    }
   });
  event('rename','owned-download');
  if(during){event('rename','owned-download');if(close)observer.close();resolveFirst();}
  if(watchError)watcher.emit('error',Object.assign(new Error('watch refused'),{code:'EMFILE'}));
  for(let i=0;i<5;i++)await tick();
  observer.close();return {reasons,reads};
 }
 const cases=[
  ['removed placeholder then bounded replacement',[regular(0,0),regular()],{during:true},[]],
  ['removed placeholder then symlink',[regular(0,0),symlink()],{},['unsafe']],
  ['removed placeholder then multiple links',[regular(0,0),regular(2)],{},['unsafe']],
  ['removed placeholder then oversized replacement',[regular(0,0),regular(1,2048)],{},['size']],
  ['removed placeholder then missing name',[regular(0,0),Object.assign(new Error('missing'),{code:'ENOENT'})],{},[]],
  ['repeated zero-link observations stay bounded',[regular(0,0)],{},['unsafe']],
  ['growth event while a stat is pending',[regular(),regular(1,2048)],{during:true},['size']],
  ['stat access error',[Object.assign(new Error('denied'),{code:'EACCES'})],{},['unsafe']],
  ['watcher failure',[regular()],{watchError:true},['unsafe']],
  ['close while the first stat is pending',[regular(0),symlink()],{during:true,close:true},[]]
 ];
 for(const [label,values,options,expected] of cases)await t.test(label,async()=>{
  const result=await probe(values,options);assert.deepEqual(result.reasons,expected);
  if(label.startsWith('repeated'))assert.equal(result.reads,3);
  if(label.startsWith('close'))assert.equal(result.reads,1);
 });
});
test('owned download file growth reports a size refusal without replacing browser download events',async t=>{
 assert.equal(typeof browser.observeOwnedDownloadDirectory,'function');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'download-watch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let ready;const refusal=new Promise(r=>ready=r);
 const observer=browser.observeOwnedDownloadDirectory(root,1024,ready);t.after(()=>observer.close());
 await fs.writeFile(path.join(root,'fixture.crdownload'),Buffer.alloc(2048));
 const timeout=setTimeout(()=>ready('timeout'),5000);
 try{assert.equal(await refusal,'size');}finally{clearTimeout(timeout);}
});
test('owned download directory observer closes without retaining an OS watcher',async t=>{
 assert.equal(typeof browser.observeOwnedDownloadDirectory,'function');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'download-watch-close-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const observer=browser.observeOwnedDownloadDirectory(root,1024,()=>assert.fail('closed observer invoked'));
 observer.close();await fs.writeFile(path.join(root,'after-close'),Buffer.alloc(2048));
});
