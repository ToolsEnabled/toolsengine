import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browser from '../src/browser.js';
import * as desktop from '../src/desktop.js';
import {createToolsEngine} from '../src/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
test('P6 abort stops browser operation and waits for cleanup before releasing authority',async()=>{
 assert.equal(typeof browser.runBrowserOperation,'function');const controller=new AbortController();let stopped=false,release;
 const pending=browser.runBrowserOperation(()=>new Promise(r=>release=r),{signal:controller.signal,stop:async()=>{stopped=true;release('delivered');}});
 controller.abort();await assert.rejects(pending,/cancelled.*may.*applied/i);assert.equal(stopped,true);
});
test('P6 desktop operation receives the client abort and the next operation gets a fresh controller',async()=>{
 assert.equal(typeof desktop.runDesktopOperation,'function');const mode={scope:'desktop',controller:new AbortController()};const controller=new AbortController();
 let received;const pending=desktop.runDesktopOperation(mode,controller.signal,()=>new Promise((r,j)=>{received=mode.controller.signal;received.addEventListener('abort',()=>j(new Error('desktop stopped')),{once:true});}));
 controller.abort();await assert.rejects(pending,/stopped/);assert.equal(received.aborted,true);
 await desktop.runDesktopOperation(mode,undefined,async()=>assert.equal(mode.controller.signal.aborted,false));
});
test('P6 MCP cancellation reaches running handler and queued cancellation never starts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cancel-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let started,stopped;const active=new Promise(r=>started=r),ended=new Promise(r=>stopped=r);
 const engine=await createToolsEngine({workspace:root},{makeBrowserBridge:async()=>({tools:[{name:'browser.wait_for',inputSchema:{type:'object',properties:{},additionalProperties:false},handler:async(args,{signal})=>{started();return new Promise(r=>signal.addEventListener('abort',()=>{stopped();r({});},{once:true}));}}],close:async()=>{}})});
 const client=new Client({name:'cancel-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await engine.server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await engine.close();});
 const controller=new AbortController();const pending=client.callTool({name:'browser.wait_for',arguments:{}},undefined,{signal:controller.signal});await active;
 const queued=new AbortController();const later=engine.call('workspace.write_file',{path:'should-not-exist',content:'x'},{signal:queued.signal});queued.abort();assert.equal((await later).isError,true);
 controller.abort();await assert.rejects(pending);await ended;await assert.rejects(fs.stat(path.join(root,'should-not-exist')),/ENOENT/);
});
