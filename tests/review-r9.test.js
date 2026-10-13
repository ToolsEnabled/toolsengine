import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as installer from '../installer/install.mjs';
test('R9 staging identity and unknown remote or malformed recovery are preserved',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r9-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const name='.incoming-1.0.0-4321';const dir=path.join(root,name);fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'.toolsengine-install-in-progress'),JSON.stringify({what:'ToolsEngine installer staging folder',version:'other-version',folder:name,pid:4321,host:os.hostname(),startedAt:new Date().toISOString()}));
 assert.deepEqual(installer.clearAbandonedCopies(root,{alive:()=>false}),[]);assert.ok(fs.existsSync(dir));
 for(const record of [null,{state:'installing'},{state:'installing',installerPid:4321,installerHost:'remote',startedAt:'2000-01-01T00:00:00Z'}])assert.ok(installer.stillInstalling(record,{alive:()=>true}),'uncertain jobs require explicit recovery');
});
test('R9 a recycled PID does not block recovery and a matching live process does',()=>{
 assert.equal(typeof installer.currentProcessIdentity,'function');const self=installer.currentProcessIdentity();
 const record={state:'installing',installerPid:4321,installerHost:os.hostname(),installerScope:self.scope,installerProcessStart:'old'};
 assert.equal(installer.stillInstalling(record,{alive:()=>true,identity:()=>({scope:self.scope,start:'new'})}),null);
 assert.match(installer.stillInstalling(record,{alive:()=>true,identity:()=>({scope:self.scope,start:'old'})}),/process 4321/);
});
