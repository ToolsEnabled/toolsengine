import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {npmCommandArgs,testedTree,assertPackedBytes} from '../tools/build-release.js';
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
 const transport=new StdioClientTransport({command:entry.command,args,cwd:path.resolve(root,entry.cwd),stderr:'pipe',env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:workspace,TOOLSENGINE_CODEX_RUNTIME:root})}});
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
 const result=spawnSync(entry.command,args,{cwd:root,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:root,TOOLSENGINE_CODEX_RUNTIME:root})},encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/must not contain one another/);
});

test('Codex launcher names missing dependency setup and performs no install',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'engine-missing-'));
 await fs.mkdir(path.join(base,'.codex-plugin'));
 await fs.copyFile(path.join(root,'.codex-plugin/start.mjs'),path.join(base,'.codex-plugin/start.mjs'));
 const result=spawnSync(process.execPath,[path.join(base,'.codex-plugin/start.mjs')],{cwd:base,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:base,TOOLSENGINE_CODEX_RUNTIME:base})},encoding:'utf8',timeout:10000});
 assert.equal(result.status,1);assert.match(result.stderr,/setup required/);
 assert.deepEqual((await fs.readdir(base)).sort(),['.codex-plugin']);
});

test('Codex launcher names missing project selection before serving',()=>{const env={...process.env};delete env.TOOLSENGINE_CODEX_WORKSPACE;const r=spawnSync(entry.command,args,{cwd:root,env,encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/TOOLSENGINE_CODEX_WORKSPACE/);});

test('release npm command honors a selected cache for packing as well as dependency setup',()=>{for(const args of [['pack','--json'],['ci','--ignore-scripts']]){const actual=npmCommandArgs(args,'cache with space');assert.deepEqual(actual,['--cache',path.resolve('cache with space'),...args]);assert.deepEqual(npmCommandArgs(args),args);}});

test('Codex launcher names missing durable runtime',()=>{const env={...process.env,TOOLSENGINE_CODEX_WORKSPACE:root};delete env.TOOLSENGINE_CODEX_RUNTIME;const r=spawnSync(entry.command,args,{cwd:root,env,encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/TOOLSENGINE_CODEX_RUNTIME/);});

test('new plugin payload files participate in the tested-byte snapshot',async()=>{const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'engine-payload-'));await fs.mkdir(path.join(fixture,'.agents/plugins'),{recursive:true});const relative='.agents/plugins/marketplace.json',file=path.join(fixture,relative);await fs.writeFile(file,'original fixture');const snapshot=testedTree(fixture);assert.doesNotThrow(()=>assertPackedBytes(file,relative,snapshot));await fs.writeFile(file,'changed fixture');assert.throws(()=>assertPackedBytes(file,relative,snapshot),/differs from the tested bytes/);});

async function runtimeFixture(){const base=await fs.mkdtemp(path.join(os.tmpdir(),'engine-runtime-'));for(const file of ['package.json','npm-shrinkwrap.json'])await fs.copyFile(path.join(root,file),path.join(base,file));for(const folder of ['bin','src','native'])await fs.cp(path.join(root,folder),path.join(base,folder),{recursive:true});return base;}
test('a source-mismatched durable runtime refuses before execution',async()=>{const runtime=await runtimeFixture();await fs.appendFile(path.join(runtime,'bin/toolsengine.js'),'\n// changed owned fixture\n');const r=spawnSync(entry.command,args,{cwd:root,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:runtime,TOOLSENGINE_CODEX_RUNTIME:runtime})},encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/runtime does not match/);assert.match(r.stderr,/bin\/toolsengine/);});
test('a matching durable runtime without dependencies names setup and installs nothing',async()=>{const runtime=await runtimeFixture(),workspace=await fs.mkdtemp(path.join(os.tmpdir(),'engine-no-deps-project-'));const r=spawnSync(entry.command,args,{cwd:root,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:workspace,TOOLSENGINE_CODEX_RUNTIME:runtime})},encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/runtime setup required/);assert.match(r.stderr,/npm ci/);assert.equal((await fs.readdir(runtime)).includes('node_modules'),false);});

async function preparedRuntime(){const runtime=await runtimeFixture();await fs.symlink(path.join(root,'node_modules'),path.join(runtime,'node_modules'),process.platform==='win32'?'junction':'dir');return runtime;}
const launchSelected=(workspace,runtime)=>spawnSync(entry.command,args,{cwd:root,env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:workspace,TOOLSENGINE_CODEX_RUNTIME:runtime})},encoding:'utf8',timeout:10000});
test('distinct plugin and durable runtime each refuse workspace root, child and parent',async()=>{
 const runtime=await preparedRuntime();assert.notEqual(await fs.realpath(root),await fs.realpath(runtime));
 const protectedCases=[['plugin root',root],['plugin child',path.join(root,'.codex-plugin')],['plugin parent',path.dirname(root)],['runtime root',runtime],['runtime child',path.join(runtime,'src')],['runtime parent',path.dirname(runtime)]];
 for(const [label,workspace]of protectedCases){const r=launchSelected(workspace,runtime);assert.equal(r.status,1,`${label} was admitted: ${r.stderr}`);assert.match(r.stderr,/must not contain one another/,label);}
});
test('two-root launcher refuses symlink aliases consistently with canonical workspace rules',async()=>{
 const runtime=await preparedRuntime(),base=await fs.mkdtemp(path.join(os.tmpdir(),'engine-root-alias-'));
 for(const [label,target]of [['plugin',root],['runtime',runtime]]){
  const alias=path.join(base,label);await fs.symlink(target,alias,process.platform==='win32'?'junction':'dir');assert.equal((await fs.lstat(alias)).isSymbolicLink(),true);assert.equal(await fs.realpath(alias),await fs.realpath(target));
  const r=launchSelected(alias,runtime);assert.equal(r.status,1,`${label} alias was admitted`);assert.match(r.stderr,/links or junctions|must not contain one another/);
 }
});
test('distinct plugin and durable runtime serve an unrelated workspace with actual file values', {timeout:30000},async t=>{
 const runtime=await preparedRuntime(),workspace=await fs.mkdtemp(path.join(os.tmpdir(),'engine-unrelated-'));
 const original=await fs.readFile(path.join(root,'.codex-plugin/start.mjs'));
 const transport=new StdioClientTransport({command:entry.command,args,cwd:root,stderr:'pipe',env:{...process.env,...forwarded({TOOLSENGINE_CODEX_WORKSPACE:workspace,TOOLSENGINE_CODEX_RUNTIME:runtime})}});
 let stderr='';transport.stderr?.on('data',c=>{stderr+=c;});const client=new Client({name:'two-physical-program-roots',version:'1'});t.after(()=>client.close());await client.connect(transport).catch(error=>{throw new Error(error.message+'; server stderr: '+stderr);});
 const call=(name,arguments_={})=>client.callTool({name,arguments:arguments_});const status=JSON.parse((await call('system.status')).content[0].text);assert.equal(status.workspace,await fs.realpath(workspace));assert.equal(status.browserEnabled,false);
 assert.equal((await call('workspace.write_file',{path:'boundary.txt',content:'two roots protected'})).isError,undefined);assert.equal(JSON.parse((await call('workspace.read_file',{path:'boundary.txt'})).content[0].text).content,'two roots protected');assert.deepEqual(await fs.readFile(path.join(root,'.codex-plugin/start.mjs')),original);assert.equal(stderr,'');
});
