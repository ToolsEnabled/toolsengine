import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serverBrowserSkipped } from './support/browser-under-test.js';

test('actual stdio MCP resizes real browser desktop/mobile, preserves page state and rejects invalid changes', { timeout: 90000, skip: serverBrowserSkipped }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-resize-live-'));
  const fixture = http.createServer((req,res) => {
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Responsive layout fixture</title>
      <style>body{margin:0}#mode::after{content:'wide'}@media(max-width:600px){#mode::after{content:'narrow'}}</style>
      <h1>Viewport fixture</h1><p id="size"></p><p id="mode"></p><button id="count" onclick="this.textContent='Count '+(++window.count)">Count 0</button>
      <script>window.count=0;function dimensions(){document.querySelector('#size').textContent='Viewport '+innerWidth+' by '+innerHeight;}addEventListener('resize',dimensions);dimensions();</script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const args = [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js',import.meta.url)), '--workspace',workspace,'--headless'];
  if(process.env.TOOLSENGINE_TEST_BROWSER) args.push('--browser-executable',process.env.TOOLSENGINE_TEST_BROWSER);
  // Only for a machine where the browser under test cannot set its sandbox up.
  if(process.env.TOOLSENGINE_TEST_NO_SANDBOX==='1') args.push('--no-browser-sandbox');
  const transport = new StdioClientTransport({command:process.execPath,args,cwd:workspace,stderr:'pipe',env:{...process.env,TEMP:os.tmpdir(),TMP:os.tmpdir()}});
  let errors='';transport.stderr?.on('data',chunk=>{errors+=chunk;});
  const client=new Client({name:'viewport-acceptance',version:'1.0.0'});
  t.after(async()=>{await client.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));await fs.rm(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await client.connect(transport);
  const catalogue=await client.listTools();assert.ok(catalogue.tools.some(t=>t.name==='browser.resize'));
  const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r;};
  const url=`http://127.0.0.1:${fixture.address().port}`;
  await call('browser.navigate',{url});
  await call('browser.click',{target:'#count'});
  for(const [width,height] of [[1440,900],[390,844],[320,240],[3840,2160],[390,844]]){
    await call('browser.resize',{width,height});
    await call('browser.wait_for',{text:`Viewport ${width} by ${height}`});
    const snap=JSON.stringify(await call('browser.snapshot'));
    assert.match(snap,new RegExp(`Viewport ${width} by ${height}`));assert.match(snap,/Count 1/);
    assert.match(snap, width <= 600 ? /narrow/ : /wide/);
    const filename=`viewport-${width}-${height}-${Math.random().toString(16).slice(2)}.png`;
    await call('browser.take_screenshot',{filename,scale:'css'});
    const png=await fs.readFile(path.join(workspace,filename));
    assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),width);assert.equal(png.readUInt32BE(20),height);
  }
  const invalid=await client.callTool({name:'browser.resize',arguments:{width:100000,height:844}});
  assert.equal(invalid.isError,true);assert.match(JSON.stringify(await call('browser.snapshot')),/Viewport 390 by 844/);
  await call('browser.tabs',{action:'new'});
  await call('browser.navigate',{url});
  await call('browser.resize',{width:800,height:600});
  await call('browser.tabs',{action:'select',index:0});
  assert.match(JSON.stringify(await call('browser.snapshot')),/Viewport 390 by 844/);
  assert.equal(errors,'');
});
