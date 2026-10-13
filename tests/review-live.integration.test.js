import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrowserBridge} from '../src/browser.js';
import {serverBrowserSkipped} from './support/browser-under-test.js';
async function bridgeFor(t,extra={}){
 const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'review-live-')));
 const bridge=await createBrowserBridge({workspace,browserExecutable:process.env.TOOLSENGINE_TEST_BROWSER,browserSandbox:true,...extra});
 t.after(async()=>{await bridge.close();await fs.rm(workspace,{recursive:true,force:true});});
 return {workspace,bridge,call:(name,args={},signal)=>bridge.tools.find(t=>t.name===name).handler(args,{signal})};
}
test('P6 live owned browser wait is interrupted by cancellation and can be reopened',{skip:serverBrowserSkipped,timeout:120000},async t=>{
 const {call}=await bridgeFor(t);assert.notEqual((await call('browser.navigate',{url:'about:blank'})).isError,true);
 const controller=new AbortController();const start=Date.now();const waiting=call('browser.wait_for',{time:30},controller.signal);
 setTimeout(()=>controller.abort(),100);await assert.rejects(waiting,/cancelled/);assert.ok(Date.now()-start<3000);
 assert.notEqual((await call('browser.navigate',{url:'about:blank'})).isError,true);
});
test('P6 live oversized screenshot is refused before an output file is written',{skip:serverBrowserSkipped,timeout:120000},async t=>{
 const {workspace,call}=await bridgeFor(t,{artifactLimits:{files:8,bytes:8192,fileBytes:256,downloads:2}});
 const opened=await call('browser.navigate',{url:'about:blank'});assert.notEqual(opened.isError,true,JSON.stringify(opened));
 const result=await call('browser.take_screenshot',{filename:'oversize.png',scale:'css'});assert.equal(result.isError,true);assert.match(JSON.stringify(result),/limit/);
 await assert.rejects(fs.stat(path.join(workspace,'oversize.png')),/ENOENT/);
});
test('P6 live downloads enforce count and per-file bytes without overwriting',{skip:serverBrowserSkipped,timeout:120000},async t=>{
 const site=http.createServer((req,res)=>{if(req.url.startsWith('/file')){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="same.txt"'});res.end(req.url.includes('big')?Buffer.alloc(2048,65):'small fixture');}else{res.end('<title>Quota</title><a href="/file">small</a><a href="/file-big">big</a>');}});
 await new Promise(r=>site.listen(0,'127.0.0.1',r));t.after(()=>{site.closeAllConnections();site.close();});
 const origin=`http://127.0.0.1:${site.address().port}`;
 const {workspace,bridge,call}=await bridgeFor(t,{artifactLimits:{files:20,bytes:16384,fileBytes:1024,downloads:1}});
 await call('browser.navigate',{url:origin});const big=await call('browser.click',{target:'a[href="/file-big"]'});await bridge.waitForDownloads();
 let names=await fs.readdir(path.join(workspace,'artifacts','toolsengine'));assert.equal(names.filter(n=>n.startsWith('download-')).length,0);
 const refusal=await call('browser.snapshot');assert.match(JSON.stringify([big,refusal]),/refused|cancelled/);
 await call('browser.click',{target:'a[href="/file"]'});await bridge.waitForDownloads();
 names=await fs.readdir(path.join(workspace,'artifacts','toolsengine'));const files=names.filter(n=>n.startsWith('download-'));assert.equal(files.length,1);assert.equal(await fs.readFile(path.join(workspace,'artifacts','toolsengine',files[0]),'utf8'),'small fixture');
 await call('browser.click',{target:'a[href="/file"]'});await bridge.waitForDownloads();
 assert.equal((await fs.readdir(path.join(workspace,'artifacts','toolsengine'))).filter(n=>n.startsWith('download-')).length,1);
});
// 0.1.5 reported a click as an error saying "nothing was saved" when only the
// page snapshot written after it could not be saved: the order was placed,
// and the answer invited a second click.
test('P6 live a click whose snapshot file cannot be saved is reported as done, once, not as an error',{skip:serverBrowserSkipped,timeout:120000},async t=>{
 const site=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<title>Orders</title><button id="order">Place order</button><p id="count">orders: 0</p><script>let n=0;document.getElementById("order").onclick=()=>{document.getElementById("count").textContent="orders: "+(++n);};</script>');});
 await new Promise(r=>site.listen(0,'127.0.0.1',r));t.after(()=>{site.closeAllConnections();site.close();});
 const {workspace,call}=await bridgeFor(t,{artifactLimits:{files:1,bytes:65536,fileBytes:65536,downloads:1}});
 const output=path.join(workspace,'artifacts','toolsengine');
 // The saved-output quota is full of the person's own file.
 await fs.writeFile(path.join(output,'mine.txt'),'mine');
 const opened=await call('browser.navigate',{url:`http://127.0.0.1:${site.address().port}/`});
 assert.notEqual(opened.isError,true,JSON.stringify(opened));
 const clicked=await call('browser.click',{target:'#order'});
 assert.notEqual(clicked.isError,true,JSON.stringify(clicked));
 assert.match(JSON.stringify(clicked),/The action was carried out/);
 assert.doesNotMatch(JSON.stringify(clicked),/nothing was saved|\[Snapshot\]\(/);
 assert.match(JSON.stringify(await call('browser.snapshot')),/orders: 1/);
 assert.deepEqual(await fs.readdir(output),['mine.txt']);
 // Another writer's output lock: the click is reported in the same way.
 await fs.unlink(path.join(output,'mine.txt'));
 await fs.writeFile(path.join(workspace,'.toolsengine-runtime','artifact-write.lock'),'');
 const again=await call('browser.click',{target:'#order'});
 assert.notEqual(again.isError,true,JSON.stringify(again));
 assert.match(JSON.stringify(again),/artifact-write\.lock/);
 assert.match(JSON.stringify(await call('browser.snapshot')),/orders: 2/);
});
