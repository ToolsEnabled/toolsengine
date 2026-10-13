import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../src/browser.js';
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
