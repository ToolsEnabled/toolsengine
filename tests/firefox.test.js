import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { browserCapabilityStatus, serverInstructions } from '../src/server.js';
import { createFirefoxBrowserBridge, requestTimeout, uploadFile } from '../src/firefox.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fixtureHelper(answer = r => ({result:r.op==='tabs'?[{id:'tab1',title:'Fixture',window:'1:0'}]:'fixture snapshot'})) {
  const helper=new EventEmitter();helper.stdin=new PassThrough();helper.stdout=new PassThrough();helper.stderr=new PassThrough();helper.kill=()=>{};
  const calls=[];let buffer='';
  helper.stdin.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')) {
      const i=buffer.indexOf('\n'),r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);calls.push(r);
      const reply=answer(r);
      if(reply)helper.stdout.write(JSON.stringify({id:r.id,...reply})+'\n');
    }
  });
  return {helper,calls};
}

test('Firefox mode is explicit and cannot import profiles or mix browser attachment modes', async t => {
  if(process.platform !== 'linux')return t.skip();
  const env={DISPLAY:process.env.DISPLAY,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS};
  process.env.DISPLAY=':0';process.env.DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/test-bus';
  t.after(()=>{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'toolsengine-firefox-config-'));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  const args=['--workspace',workspace,'--firefox-desktop'];
  assert.equal((await parseConfig(args)).firefoxDesktop,true);
  for(const extra of [['--no-browser'],['--cdp-endpoint','http://127.0.0.1:9222'],['--profile-dir','/tmp/profile'],['--browser-executable','/usr/bin/firefox']])
    await assert.rejects(parseConfig([...args,...extra]),/cannot be combined/);
  delete process.env.DISPLAY;
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  const withoutDisplay = await parseConfig(args);
  assert.equal(withoutDisplay.firefoxDesktop, true);
  const status=browserCapabilityStatus({firefoxDesktop:true, visibleDisplay:':0', visibleWindow:'owner-firefox'},true);
  assert.equal(status.browserSession,'hidden-window');
  assert.equal(status.browserLaunchState,'not-probed');
  assert.equal(status.browserWindowVisibility,'hidden');
  assert.equal(status.browserAuthSharing,'dedicated-profile-only');
  assert.equal(status.browserUsesVisibleScreen,false);
  assert.equal(status.browserRejectedVisibleDisplay,':0');
  assert.equal(status.browserRejectedVisibleWindow,'owner-firefox');
  assert.equal(status.browserConnectionVerified,false);
  assert.equal(status.browserAuthenticationVerified,false);
});

test('Firefox adapter exposes bounded UI operations, validates URLs, and does not retry an uncertain action',async t=>{
  if(process.platform!=='linux')return t.skip();
  const helper=new EventEmitter();helper.stdin=new PassThrough();helper.stdout=new PassThrough();helper.stderr=new PassThrough();helper.kill=()=>{};
  let calls=[];let buffer='';
  helper.stdin.on('data',chunk=>{
    buffer+=chunk;
    while(buffer.includes('\n')) {
      const i=buffer.indexOf('\n'),r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);calls.push(r);
      helper.stdout.write(JSON.stringify({id:r.id,...(r.op==='click'?{error:'Action outcome uncertain'}:{result:r.op==='tabs'?[{id:'tab1',title:'Fixture',window:'1:0'}]:'fixture snapshot'})})+'\n');
    }
  });
  const bridge=await createFirefoxBrowserBridge({}, {spawnHelper:()=>helper});
  t.after(()=>bridge.close());
  const byName=new Map(bridge.tools.map(x=>[x.name,x]));
  assert(!byName.has('browser.close'));
  assert(![...byName.keys()].some(x=>/cookie|storage|evaluate|credential|shell/.test(x)));
  await assert.rejects(byName.get('browser.navigate').handler({url:'javascript:alert(1)'}),/HTTP/);
  assert.equal(calls.length,0);
  await assert.rejects(byName.get('browser.click').handler({ref:'fixture'}),/uncertain/);
  assert.equal(calls.length,1);
  await byName.get('browser.tabs').handler({action:'list'});
  await byName.get('browser.tabs').handler({action:'select',index:0});
  assert.equal(calls.at(-1).op,'select_tab');
  assert.equal(calls.at(-1).target,'tab1');
  assert.equal(calls.at(-1).id,3);
  await assert.rejects(byName.get('browser.navigate').handler({url:'about:logins'}),/HTTP/);
  await assert.rejects(byName.get('browser.navigate').handler({url:'about:profiles'}),/HTTP/);
  await assert.rejects(byName.get('browser.windows').handler({action:'select',index:0}),/List windows/);
});

test('Firefox tools drive a hidden window and do not take the visible screen; the dedicated profile says it is not signed in',async t=>{
  if(process.platform!=='linux')return t.skip();
  const {helper}=fixtureHelper();
  const bridge=await createFirefoxBrowserBridge({visibleDisplay:':0', visibleWindow:'owner-firefox'}, {spawnHelper:()=>helper});
  t.after(()=>bridge.close());
  for(const item of bridge.tools){
    assert.match(item.description,/hidden Firefox window/);
    assert.doesNotMatch(item.description,/owner's own signed-in Firefox/);
    assert.doesNotMatch(item.description,/A VM is used|about:profiles is also allowed/);
    assert.equal(item.sessionTarget,'hidden-window');
    assert.equal(item.usesVisibleScreen,false);
  }
  const text = serverInstructions({browser:'firefox',desktop:false});
  assert.match(text,/private hidden display/);
  assert.match(text,/no password or cookie import tool/);
  assert.match(text,/sandbox stays enabled/);
  assert(!bridge.tools.some(tool=>tool.name==='browser.transfer_firefox_profile'));
  for(const tool of bridge.tools) assert.equal(tool.annotations.readOnlyHint,false);

});

test('Firefox select_option and file_upload forward bounded requests; typing waits in proportion to its length',async t=>{
  if(process.platform!=='linux')return t.skip();
  const {helper,calls}=fixtureHelper(r=>({result:'ok'}));
  const bridge=await createFirefoxBrowserBridge({}, {spawnHelper:()=>helper});
  t.after(()=>bridge.close());
  const byName=new Map(bridge.tools.map(x=>[x.name,x]));
  assert.deepEqual(byName.get('browser.select_option').inputSchema.required,['ref','option']);
  await byName.get('browser.select_option').handler({ref:'f1',option:'Male'});
  assert.deepEqual({op:calls.at(-1).op,ref:calls.at(-1).ref,option:calls.at(-1).option},{op:'select_option',ref:'f1',option:'Male'});
  await byName.get('browser.file_upload').handler({});
  assert.equal(calls.at(-1).op,'upload');
  assert.equal(calls.at(-1).path,undefined);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'toolsengine-upload-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'resume.pdf');
  await fs.writeFile(file,'fixture');
  await byName.get('browser.file_upload').handler({paths:[file]});
  assert.equal(calls.at(-1).path,file);
  const count=calls.length;
  await fs.mkdir(path.join(root,'.hidden'));await fs.writeFile(path.join(root,'.hidden','key'),'secret');
  await fs.symlink(file,path.join(root,'link.pdf'));
  for(const bad of ['resume.pdf',path.join(root,'.hidden','key'),path.join(root,'link.pdf'),root,root+'/x/../resume.pdf',file+'\n',path.join(root,'absent.pdf')])
    await assert.rejects(byName.get('browser.file_upload').handler({paths:[bad]}));
  assert.equal(calls.length,count,'refused paths never reach the desktop helper');
  assert.equal(await uploadFile(file),file);
  assert.equal(requestTimeout({op:'snapshot'}),60000);
  assert.ok(requestTimeout({op:'type',text:'x'.repeat(3000)})>requestTimeout({op:'type',text:'x'})+60000);
});

test('A new tab with a URL is handed to Firefox without typing; a blank one uses Control+t',async t=>{
  if(process.platform!=='linux')return t.skip();
  const {helper,calls}=fixtureHelper(r=>({result:r.op==='open_tab'?'Opened the URL in a new tab':'ok'}));
  const bridge=await createFirefoxBrowserBridge({}, {spawnHelper:()=>helper});
  t.after(()=>bridge.close());
  const tabs=bridge.tools.find(x=>x.name==='browser.tabs');
  const url='https://docs.google.com/forms/d/e/x/viewform?'+'entry.1=2014-15%20%28Berkeley%29&'.repeat(60);
  assert.match((await tabs.handler({action:'new',url})).content[0].text,/Opened the URL/);
  assert.deepEqual(calls.map(c=>[c.op,c.url]),[['open_tab',url]]);
  await tabs.handler({action:'new'});
  assert.deepEqual([calls.at(-1).op,calls.at(-1).key],['key','Control+t']);
  await bridge.tools.find(x=>x.name==='browser.type').handler({ref:'f1',text:'Hi',slowly:true});
  assert.equal(calls.at(-1).slowly,true);
});

test('When the helper never answers, a click reports an unknown outcome rather than an error; reads still fail',async t=>{
  if(process.platform!=='linux')return t.skip();
  const {helper}=fixtureHelper(()=>null);
  let killed=0;helper.kill=()=>{killed++;};
  const bridge=await createFirefoxBrowserBridge({}, {spawnHelper:()=>helper,timeout:()=>30});
  t.after(()=>bridge.close());
  const byName=new Map(bridge.tools.map(x=>[x.name,x]));
  const clicked=await byName.get('browser.click').handler({ref:'f1'});
  assert.match(clicked.content[0].text,/^Outcome unknown: The Firefox accessibility helper did not answer .* may have been performed; do not repeat it/);
  for(const [name,args] of [['browser.press_key',{key:'Enter'}],['browser.navigate',{url:'https://example.com'}],['browser.file_upload',{}]])
    assert.match((await byName.get(name).handler(args)).content[0].text,/^Outcome unknown/,name);
  await assert.rejects(byName.get('browser.snapshot').handler({}),/^Error: browser.snapshot: The Firefox accessibility helper did not answer .*No action was retried/);
  await assert.rejects(byName.get('browser.type').handler({ref:'f1',text:'x'}),/browser.type: .*Some keys may have been sent/);
  assert.match((await byName.get('browser.type').handler({ref:'f1',text:'x',submit:true})).content[0].text,/^Outcome unknown/,'Enter may have been pressed');
  assert.ok(killed>=1);
});

test('A helper that exits during a click leaves an unknown outcome; errors name the tool that failed',async t=>{
  if(process.platform!=='linux')return t.skip();
  const {helper}=fixtureHelper(r=>r.op==='click'?(setImmediate(()=>helper.emit('exit')),null):{error:'Stale or protected control; request a fresh snapshot.'});
  const bridge=await createFirefoxBrowserBridge({}, {spawnHelper:()=>helper});
  t.after(()=>bridge.close());
  const byName=new Map(bridge.tools.map(x=>[x.name,x]));
  await assert.rejects(byName.get('browser.select_option').handler({ref:'f1',option:'Male'}),/^Error: browser.select_option: Stale or protected control/);
  assert.match((await byName.get('browser.click').handler({ref:'f1'})).content[0].text,/^Outcome unknown: Firefox accessibility helper exited/);
});

test('Typing and navigation timeouts cover the helper\'s chunked bounds for the full text',()=>{
  // native/firefox-desktop.py with every bound reached: about 65 s, plus 55 s and
  // 170 ms a character per 150-character chunk of a line (one slow retry included),
  // plus 11.5 s per line break.
  const helperBound=text=>{
    const lines=text.split('\n'),chunks=lines.reduce((n,line)=>n+Math.ceil(line.length/150),0);
    return (65+chunks*55+(lines.length-1)*11.5)*1000+text.length*170;
  };
  for(const text of ['x','x'.repeat(195),'x'.repeat(736),'x'.repeat(1500),'x'.repeat(20000),'line\n'.repeat(400),('y'.repeat(149)+'\n').repeat(20)]){
    assert.ok(requestTimeout({op:'type',text})>=helperBound(text),`type ${text.length}`);
    assert.ok(requestTimeout({op:'navigate',url:text})>=helperBound(text),`navigate ${text.length}`);
  }
});

test('browser.type passes the line-break key and offers only Enter or Shift+Enter',async t=>{
  if(process.platform!=='linux')return t.skip();
  const {helper,calls}=fixtureHelper(()=>({result:'ok'}));
  const bridge=await createFirefoxBrowserBridge({}, {spawnHelper:()=>helper});
  t.after(()=>bridge.close());
  const type=bridge.tools.find(x=>x.name==='browser.type');
  await type.handler({ref:'f1',text:'Hi\nthere',newline:'Shift+Enter'});
  assert.equal(calls.at(-1).newline,'Shift+Enter');
  assert.deepEqual(type.inputSchema.properties.newline.enum,['Enter','Shift+Enter']);
});
