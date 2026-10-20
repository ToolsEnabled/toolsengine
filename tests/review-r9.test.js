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
test(process.platform==='win32'?'R9 unknown Windows process identity refuses recovery before liveness callbacks'
 :'R9 a recycled PID does not block recovery and a matching live process does',()=>{
 assert.equal(typeof installer.currentProcessIdentity,'function');const self=installer.currentProcessIdentity();
 const record={state:'installing',installerPid:4321,installerHost:os.hostname(),installerScope:self.scope,installerProcessStart:'old'};
 if(process.platform==='win32'){
  assert.deepEqual(self,{scope:null,start:null});
  for(const start of ['new','old'])for(const scope of [self.scope,'invented-local-scope']){
   const candidate={...record,installerScope:scope};const before=JSON.stringify(candidate);const calls=[];
   const refused=installer.stillInstalling(candidate,{alive:()=>{calls.push('alive');return true;},identity:()=>{calls.push('identity');return {scope,start};}});
   assert.match(refused,scope===null?/identity cannot be established; explicit recovery is required/:/another machine.*process namespace; explicit recovery is required/);
   assert.deepEqual(calls,[],'unproved ownership refuses before process liveness or identity callbacks');
   assert.equal(JSON.stringify(candidate),before,'refusal does not change the saved installer record');
  }
  return;
 }
 assert.equal(installer.stillInstalling(record,{alive:()=>true,identity:()=>({scope:self.scope,start:'new'})}),null);
 assert.match(installer.stillInstalling(record,{alive:()=>true,identity:()=>({scope:self.scope,start:'old'})}),/process 4321/);
});
