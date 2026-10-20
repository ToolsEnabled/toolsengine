import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {transferUserFirefoxProfile,locateUserFirefoxProfile,fleetProfileTransferAllowed,FLEET_PROFILE_TRANSFER_SETTING} from '../src/firefox-profile-transfer.js';
import {ensureAgentFirefoxProfile} from '../src/firefox-profile.js';
const linux={skip:process.platform!=='linux'?'Firefox mode requires Linux':false};
const py=(script,...args)=>execFileSync('/usr/bin/python3',['-B','-c',script,...args],{encoding:'utf8'});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'te-profile-transfer-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),target=path.join(root,'agent');await fs.mkdir(source);await ensureAgentFirefoxProfile(target);
 await fs.writeFile(path.join(source,'logins.json'),JSON.stringify({logins:[{encryptedPassword:'synthetic-encrypted-fixture'}]}));
 py('import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table keys(value text)"); c.commit(); c.close()',path.join(source,'key4.db'));
 return {root,source,target};
}
async function holding(t,script,...args){
 const child=spawn('/usr/bin/python3',['-B','-u','-c',script,...args],{stdio:['pipe','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.stdin.end();await once(child,'exit');}});
 const [ready]=await once(child.stdout,'data');assert.match(ready.toString(),/ready/);return child;
}

test('disabled transfer refuses before touching either source or destination',linux,async t=>{
 const {root}=await fixture(t),missing=path.join(root,'not-created');
 assert.equal(fleetProfileTransferAllowed({}),true);
 assert.equal(fleetProfileTransferAllowed({values:{[FLEET_PROFILE_TRANSFER_SETTING]:false}}),false);
 await assert.rejects(transferUserFirefoxProfile({fleetSettings:{[FLEET_PROFILE_TRANSFER_SETTING]:false},userProfileDir:'/missing-source',agentProfileDir:missing}),/disable/);
 await assert.rejects(fs.access(missing));
});

test('live exclusive-lock WAL state is transferred without changing any source bytes or emitting credentials',linux,async t=>{
 const {source,target}=await fixture(t),cookies=path.join(source,'cookies.sqlite');
 await holding(t,'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("pragma journal_mode=wal"); c.execute("pragma locking_mode=exclusive"); c.execute("create table cookies(value text)"); c.execute("insert into cookies values (\'synthetic-cookie-fixture\')"); c.commit(); print("ready",flush=True); sys.stdin.read(); c.close()',cookies);
 const names=await fs.readdir(source),before=await Promise.all(names.map(name=>fs.readFile(path.join(source,name))));
 await fs.writeFile(path.join(target,'.parentlock'),''); // a closed browser leaves this file behind
 const result=await transferUserFirefoxProfile({userProfileDir:source,agentProfileDir:target});
 assert.deepEqual(result.copied,['logins.json','key4.db','cookies.sqlite']);
 assert.equal(result.sourceUnchanged,true);assert.doesNotMatch(JSON.stringify(result),/synthetic/);
 assert.equal(py('import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("select value from cookies").fetchone()[0])',path.join(target,'cookies.sqlite')).trim(),'synthetic-cookie-fixture');
 assert.deepEqual(await fs.readdir(source),names);
 for(let i=0;i<names.length;i++)assert.deepEqual(await fs.readFile(path.join(source,names[i])),before[i]);
 for(const name of result.copied)assert.equal((await fs.stat(path.join(target,name))).mode&0o777,0o600);
});

test('a live destination lock refuses replacement and preserves existing login state',linux,async t=>{
 const {source,target}=await fixture(t);await fs.writeFile(path.join(target,'logins.json'),'previous-owned-state');
 await holding(t,'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.lockf(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',path.join(target,'.parentlock'));
 await assert.rejects(transferUserFirefoxProfile({userProfileDir:source,agentProfileDir:target}),/Close the dedicated Firefox/);
 assert.equal(await fs.readFile(path.join(target,'logins.json'),'utf8'),'previous-owned-state');
});

test('linked source or destination files cannot redirect credential copying',linux,async t=>{
 const {root,source,target}=await fixture(t),outside=path.join(root,'outside');await fs.writeFile(outside,'untouched');
 await fs.symlink(outside,path.join(target,'logins.json'));
 await assert.rejects(transferUserFirefoxProfile({userProfileDir:source,agentProfileDir:target}),/plain files/);
 assert.equal(await fs.readFile(outside,'utf8'),'untouched');
 await fs.unlink(path.join(target,'logins.json'));await fs.unlink(path.join(source,'logins.json'));await fs.symlink(outside,path.join(source,'logins.json'));
 await assert.rejects(transferUserFirefoxProfile({userProfileDir:source,agentProfileDir:target}),/plain files/);
 assert.equal(await fs.readFile(outside,'utf8'),'untouched');
});

test('profile discovery honors the default and refuses ambiguous inventories',linux,async t=>{
 const {root}=await fixture(t),inventory=path.join(root,'.mozilla','firefox');await fs.mkdir(inventory,{recursive:true});
 await fs.writeFile(path.join(inventory,'profiles.ini'),'[Profile0]\nPath=one\nIsRelative=1\n[Profile1]\nPath=two\nIsRelative=1\nDefault=1\n');
 assert.equal(await locateUserFirefoxProfile(root),path.join(inventory,'two'));
 await fs.writeFile(path.join(inventory,'profiles.ini'),'[Profile0]\nPath=one\n[Profile1]\nPath=two\n');
 await assert.rejects(locateUserFirefoxProfile(root),/several profiles/);
});
