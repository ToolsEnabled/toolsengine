import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {serverInstructions} from '../src/server.js';
import {desktopToolDescriptors} from '../src/desktop.js';
import {createBrowserBridge} from '../src/browser.js';
test('P3 sign-in and credential limits are accurately disclosed',()=>{
 const text=serverInstructions({browser:'attached',desktop:true});
 assert.doesNotMatch(text,/does not sign in.*expose credentials.*grant permissions/);
 assert.match(text,/can sign in|sign-ins.*can/);assert.match(text,/credentials.*not.*redact|does not.*redact/i);
});

test('P4 desktop UI input does not promise prevention of command execution',()=>{
 const text=desktopToolDescriptors().find(t=>t.name==='desktop.act').description;
 assert.doesNotMatch(text,/No shell, script or process control/);assert.match(text,/terminal.*commands|command.*terminal/i);
});

test('P5 screenshot freshness describes identity and geometry, not pixel stability',()=>{
 const text=desktopToolDescriptors().find(t=>t.name==='desktop.pointer').description;
 assert.doesNotMatch(text,/covered or changed is refused/);assert.match(text,/does not.*pixels|does not.*content/i);
});

test('P8 attached tab titles advertise only offered actions',async t=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'p8-'));t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
 const bridge=await createBrowserBridge({workspace,cdpEndpoint:'http://127.0.0.1:9'});t.after(()=>bridge.close());
 const tool=bridge.tools.find(t=>t.name==='browser.tabs');assert.equal(tool.title,'List, open or select tabs');assert.equal(tool.annotations.title,tool.title);
 assert.deepEqual(tool.inputSchema.properties.action.enum,['list','new','select']);
});
