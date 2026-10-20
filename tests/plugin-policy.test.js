import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolsEngine} from '../src/server.js';
import {parseConfig} from '../src/config.js';
import {restrictPluginTools} from '../src/plugin-policy.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('plugin policy refuses wider configurations before browser startup', async () => {
 for (const patch of [{browser:true},{desktopProfileRoot:'/unused'}, {allowLocalNetwork:true},
   {firefoxDesktop:true},{desktopAllowSignIn:true},{pluginProfile:'unknown'}]) {
   let started=false;
   await assert.rejects(createToolsEngine({browser:false,pluginProfile:'openai',...patch},
     {makeBrowserBridge:()=>{started=true;throw Error('must not start');}}), /plugin profile/);
   assert.equal(started,false);
 }
});
test('plugin command line cannot combine its profile with private-network access',async()=>{
 await assert.rejects(parseConfig(['--plugin-profile','openai','--no-browser','--allow-local-network']), /private-network/);
});
test('future standalone capabilities never become plugin capabilities implicitly',()=>{
 const tools=[{name:'workspace.list'},{name:'future.external.execute'}];
 assert.deepEqual(restrictPluginTools(tools,'openai'),[tools[0]]);
 assert.equal(restrictPluginTools(tools,undefined),tools);
});

test('OpenAI file tools refuse protected paths and omit them from listing and search', async t => {
 const workspace=await fs.mkdtemp(path.join(process.platform==='win32'?os.userInfo().homedir:os.tmpdir(),'plugin-files-'));
 t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
 const hidden=['.env','.codex/auth.json','.claude/projects/sample/history.jsonl','.git/config',
   '.codex/config.toml','AGENTS.md','private.key','nested/secrets.json','nested/.env.local'];
 for(const name of [...hidden,'notes.txt']){
   await fs.mkdir(path.dirname(path.join(workspace,name)),{recursive:true});
   await fs.writeFile(path.join(workspace,name),'synthetic match text');
 }
 const engine=await createToolsEngine({workspace,browser:false,pluginProfile:'openai'});
 t.after(()=>engine.close());
 for(const name of hidden){
   assert.equal((await engine.call('workspace.read_file',{path:name})).isError,true,name);
   assert.equal((await engine.call('workspace.write_file',{path:name,content:'changed'})).isError,true,name);
   assert.equal(await fs.readFile(path.join(workspace,name),'utf8'),'synthetic match text');
 }
 const listed=JSON.stringify(await engine.call('workspace.list',{path:'.'}));
 assert.match(listed,/notes\.txt/);
 assert.doesNotMatch(listed,/\.env|\.codex|\.claude|\.git|AGENTS\.md|private\.key/);
 const searched=JSON.stringify(await engine.call('workspace.search',{query:'synthetic match'}));
 assert.match(searched,/notes\.txt/);
 assert.doesNotMatch(searched,/secrets\.json|\.env|AGENTS\.md|private\.key/);
 const ordinary=await engine.call('workspace.read_file',{path:'notes.txt'});
 assert.notEqual(ordinary.isError,true);
 const standalone=await createToolsEngine({workspace,browser:false});
 t.after(()=>standalone.close());
 assert.notEqual((await standalone.call('workspace.read_file',{path:'.env'})).isError,true);
});
