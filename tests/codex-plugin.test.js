import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {npmCommandArgs} from '../tools/build-release.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await fs.readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
const config=JSON.parse(await fs.readFile(path.resolve(root,manifest.mcpServers),'utf8'));
const entry=Object.values(config.mcpServers)[0];
const args=entry.args;
const forwarded=(values)=>Object.fromEntries((entry.env_vars||[]).filter(k=>values[k]!==undefined).map(k=>[k,values[k]]));

test('Codex package launches no-browser mode and confines actual file calls to session cwd', {timeout:30000},async t=>{
 const market=JSON.parse(await fs.readFile(path.join(root,'.agents/plugins/marketplace.json'),'utf8'));
 assert.equal(market.plugins.find(p=>p.name===manifest.name).policy.installation,'AVAILABLE');
 assert.deepEqual(manifest.hooks,{});
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'engine-codex-'));
 const workspace=path.join(base,'project');await fs.mkdir(workspace);
 await fs.writeFile(path.join(base,'outside.txt'),'outside owned fixture');
 const transport=new StdioClientTransport({command:entry.command,args,cwd:path.resolve(root,entry.cwd),stderr:'pipe',env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:workspace})}});
 let errors='';transport.stderr?.on('data',c=>{errors+=c;});
 const client=new Client({name:'codex-plugin-test',version:'1'});t.after(()=>client.close());
 await client.connect(transport);
 const call=(name,arguments_={})=>client.callTool({name,arguments:arguments_});
 const status=JSON.parse((await call('system.status')).content[0].text);
 assert.equal(status.browserEnabled,false);
 const {tools}=await client.listTools();assert.equal(tools.length,8);
 assert.equal((await call('workspace.write_file',{path:'owned.txt',content:'actual value 42'})).isError,undefined);
 const read=JSON.parse((await call('workspace.read_file',{path:'owned.txt'})).content[0].text);assert.equal(read.content,'actual value 42');
 assert.equal((await call('workspace.read_file',{path:'../outside.txt'})).isError,true);
 assert.equal(await fs.readFile(path.join(base,'outside.txt'),'utf8'),'outside owned fixture');
 assert.equal(errors,'');
});

test('Codex launcher refuses a session inside its own program folder',()=>{
 const result=spawnSync(entry.command,args,{cwd:root,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:root})},encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/must not contain one another/);
});

test('Codex launcher names missing dependency setup and performs no install',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'engine-missing-'));
 await fs.mkdir(path.join(base,'.codex-plugin'));
 await fs.copyFile(path.join(root,'.codex-plugin/start.mjs'),path.join(base,'.codex-plugin/start.mjs'));
 const result=spawnSync(process.execPath,[path.join(base,'.codex-plugin/start.mjs')],{cwd:base,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:base})},encoding:'utf8',timeout:10000});
 assert.equal(result.status,1);assert.match(result.stderr,/setup required/);
 assert.deepEqual((await fs.readdir(base)).sort(),['.codex-plugin']);
});

test('Codex launcher names missing project selection before serving',()=>{const env={...process.env};delete env.TOOLSENGINE_CODEX_WORKSPACE;const r=spawnSync(entry.command,args,{cwd:root,env,encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/TOOLSENGINE_CODEX_WORKSPACE/);});

test('release npm command honors a selected cache for packing as well as dependency setup',()=>{for(const args of [['pack','--json'],['ci','--ignore-scripts']]){const actual=npmCommandArgs(args,'cache with space');assert.deepEqual(actual,['--cache',path.resolve('cache with space'),...args]);assert.deepEqual(npmCommandArgs(args),args);}});
