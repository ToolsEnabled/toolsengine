import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { assertDesktopTextAllowed, createAccessibilityDesktopAdapter } from '../native/accessibility-desktop.cjs';
import { createDesktopTools } from '../src/desktop.js';
import { userInfo } from 'node:os';

test('desktop text accepts ordinary HTTPS URLs but still refuses filesystem forms', () => {
  for (const text of [
    'https://learn.example.edu/courses/239400/assignments/1114737',
    'Open https://example.com/path?q=value in the current tab',
  ]) assert.equal(assertDesktopTextAllowed(text), text);
  for (const text of [
    'C:\\fixture\\file.txt',
    'copy C:/fixture/file.txt',
    'https://example.com/?next=C:/fixture/file.txt',
    '\\\\server\\share\\file.txt',
    'file:///C:/Windows/System32',
    '%USERPROFILE%\\Desktop',
  ]) assert.throws(() => assertDesktopTextAllowed(text), /Filesystem paths/);
});

test('native key construction survives null-to-empty PowerShell marshalling and refuses key zero', { skip: process.platform !== 'win32' }, async () => {
  const nativeSource = await fs.readFile(new URL('../native/accessibility-desktop.ps1', import.meta.url), 'utf8');
  const classBody = nativeSource.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(classBody, 'native AccessibilityNative class must be extractable for the isolated test');
  const assertions = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${classBody[1]}\n'@\n`
    + `if ([AccessibilityNative]::BuildInputs($false, $null, 13).Length -ne 2) { throw 'Null-marshalled Enter did not produce down/up input.' }\n`
    + `if ([AccessibilityNative]::BuildInputs($false, '', 13).Length -ne 2) { throw 'Empty-marshalled Enter did not produce down/up input.' }\n`
    + `$zeroRefused = $false\ntry { $null = [AccessibilityNative]::BuildInputs($false, $null, 0) } catch { $zeroRefused = $true }\n`
    + `if (!$zeroRefused) { throw 'Zero key was falsely accepted.' }\n`
    + `if ([AccessibilityNative]::UnsupportedText('https://learn.example.edu/courses/239400/assignments/1114737')) { throw 'HTTPS URL was falsely rejected.' }\n`
    + `foreach ($value in @('C:\\fixture\\file.txt', 'https://example.com/?next=C:/fixture/file.txt', '\\\\server\\share', 'file:///C:/Windows/System32', '%USERPROFILE%\\Desktop')) { if (![AccessibilityNative]::UnsupportedText($value)) { throw ('Unsafe text was accepted: ' + $value) } }\n`
    + `[Console]::WriteLine('native-key-marshalling-ok')\n`;
  const encoded = Buffer.from(assertions, 'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /native-key-marshalling-ok/);
});

test('desktop is opt-in and never offered implicitly on either platform', () => {
  assert.deepEqual(createDesktopTools({}), []);
  if (process.platform !== 'win32') assert.throws(() => createDesktopTools({ desktopProfileRoot: '/tmp' }), /requires Windows/);
});

test('background desktop actions do not reposition windows; foreground fallback does', { skip: process.platform !== 'win32' }, async () => {
  const events=[];
  const adapter={ inspect: async()=>({windowActions:['close'],controls:[]}),
    plan: args=>({foregroundRequired:args.kind==='focus',execute:async()=>events.push('execute')}),
    positionForAction:async()=>events.push('position') };
  const tools=createDesktopTools({desktopProfileRoot:userInfo().homedir,desktopLeftHalf:true},()=>adapter);
  assert.equal(tools.length,4);
  assert.equal(Object.hasOwn(await tools.find(t=>t.name==='desktop.inspect').handler({}),'windowActions'),false);
  const act=tools.find(t=>t.name==='desktop.act');
  await act.handler({kind:'click'});assert.deepEqual(events,['execute']);events.length=0;
  await act.handler({kind:'focus'});assert.deepEqual(events,['position','execute']);
});

test('uncertain helper exit quarantines subsequent desktop calls', { skip: process.platform !== 'win32' }, async () => {
  let child, spawns=0;
  const spawnProcess=()=>{
    spawns++; child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(b,e,done){done()}});child.kill=()=>true;return child;
  };
  const adapter=createAccessibilityDesktopAdapter({profileRoot:userInfo().homedir,spawnProcess});
  const controller=new AbortController();
  const pending=adapter.inspect({},{scope:'desktop',controller});controller.abort();
  await assert.rejects(pending,/stopped/);
  await assert.rejects(adapter.inspect({},{scope:'desktop',controller:new AbortController()}),/has not exited/);
  assert.equal(spawns,1);child.emit('close',1);
});

test('desktop target and capture fences reject stale, moved-authority and uncertain retries', { skip: process.platform !== 'win32' }, async () => {
  let clock=1000, failCapture=false, calls=[];
  const spawnProcess=(command,args,options)=>{
    assert.equal(options.windowsHide,true);
    assert.deepEqual(Object.keys(options.env).sort(),['SystemRoot','TEMP','TMP','USERPROFILE','WINDIR'].sort());
    const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.kill=()=>{};
    child.stdin=new Writable({ write(bytes,encoding,done) {
      const req=JSON.parse(bytes); calls.push(req); let result;
      if(req.command==='windows')result=[{handle:'fixture',pid:1,start:'1',name:'fixture',title:'Fixture'}];
      else if(req.command==='capture')result={png:'fixture',width:100,height:80,geometry:{left:10,top:20,right:110,bottom:100}};
      else result={status:'completed'};
      const failed=req.command==='capture'&&failCapture;
      child.stdout.end(JSON.stringify(failed?{ok:false,error:'fixture capture failed'}:{ok:true,result}));
      queueMicrotask(()=>{child.emit('exit',failed?1:0);child.emit('close',failed?1:0)});done();
    }});return child;
  };
  const adapter=createAccessibilityDesktopAdapter({profileRoot:process.cwd(),spawnProcess,now:()=>clock});
  const mode={scope:'desktop',controller:new AbortController()};
  const {windows}=await adapter.inspect({},mode);const windowId=windows[0].id;
  await assert.rejects(adapter.pointer({windowId,kind:'click',x:10,y:10},mode),/Capture/);
  await adapter.capture({windowId},mode);
  await assert.rejects(adapter.pointer({windowId,kind:'click',x:100,y:10},mode),/inside/);
  await adapter.pointer({windowId,kind:'click',x:10,y:10},mode);
  await assert.rejects(adapter.pointer({windowId,kind:'click',x:10,y:10},mode),/Capture/);
  await adapter.capture({windowId},mode); clock+=30001;
  await assert.rejects(adapter.pointer({windowId,kind:'click',x:10,y:10},mode),/Capture/);
  await adapter.capture({windowId},mode);failCapture=true;
  await assert.rejects(adapter.capture({windowId},mode),/fixture capture failed/);
  await assert.rejects(adapter.pointer({windowId,kind:'click',x:10,y:10},mode),/Capture/);
  failCapture=false;await adapter.capture({windowId},mode);
  adapter.plan({kind:'focus',windowId},mode);
  await assert.rejects(adapter.pointer({windowId,kind:'click',x:10,y:10},mode),/Capture/);
  clock+=90001;await assert.rejects(adapter.capture({windowId},mode),/Inspect/);
  assert.equal(calls.filter(c=>c.command==='pointer').length,1);
});
