import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFirefoxBrowserBridge } from '../src/firefox.js';

test('opaque credential capture and password delivery exclude values from all tool observations', {
  timeout:90000,
  skip:process.platform!=='linux' ? 'Firefox mode requires Linux' : process.env.TOOLSENGINE_FIREFOX_LIVE!=='1' ? 'set TOOLSENGINE_FIREFOX_LIVE=1 on a Linux desktop with Firefox, Xvfb, xauth and AT-SPI' : false,
}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'te-firefox-live-'));
  const home=path.join(root,'home'), workspace=path.join(root,'workspace');
  await fs.mkdir(home);await fs.mkdir(workspace);
  const secret='Fixture-'+crypto.randomUUID()+'-only';
  let accepted=0;
  const site=http.createServer((req,res)=>{
    if(req.method==='POST'){
      let body='';req.on('data',c=>body+=c);req.on('end',()=>{
        const ok=new URLSearchParams(body).get('password')===secret;
        if(ok)accepted++;
        res.end('<title>Credential result</title><p>'+(ok?'Credential accepted':'Credential failed')+'</p>');
      });return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url==='/source')res.end('<title>Credential source fixture</title><button onclick="document.getElementById(\'source\').hidden=false">Show source</button><section id="source" hidden><p>Your temporary password is: “<strong>'+secret+'</strong>”.</p><p>To change your password: Use the passwd command.</p></section>');
    else res.end('<title>Credential target fixture</title><form method="POST" action="/verify"><label>Password<input name="password" type="password" autocomplete="off"></label><button type="submit">Sign In Fixture</button></form>');
  });
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  let bridge,pid,receipt;
  t.after(async()=>{
    if(bridge){
      receipt ??= await fs.readFile(path.join(bridge.agentProfileDir,'.toolsengine-display.json'),'utf8').then(JSON.parse).catch(()=>null);
      if(!pid){
        for(const entry of await fs.readdir('/proc')){
          if(!/^\d+$/.test(entry))continue;
          const args=(await fs.readFile(`/proc/${entry}/cmdline`).catch(()=>Buffer.from(''))).toString().split('\0');
          if(args.some((value,index)=>value==='--profile'&&args[index+1]===bridge.agentProfileDir)){pid=Number(entry);break;}
        }
      }
    }
    await bridge?.close();await new Promise(resolve=>site.close(resolve));
    // Retire only the browser and display bearing this fixture's unique profile.
    if(pid){const args=(await fs.readFile(`/proc/${pid}/cmdline`).catch(()=>Buffer.from(''))).toString().split('\0');if(args.some((value,index)=>value==='--profile'&&args[index+1]===bridge.agentProfileDir))process.kill(pid,'SIGTERM');}
    if(receipt){const args=(await fs.readFile(`/proc/${receipt.pid}/cmdline`).catch(()=>Buffer.from(''))).toString().split('\0');if(args.includes(receipt.display)&&args.includes(path.join(bridge.agentProfileDir,receipt.auth)))process.kill(receipt.pid,'SIGTERM');}
  });
  bridge=await createFirefoxBrowserBridge({home,workspace,visibleDisplay:process.env.DISPLAY||':0'});
  const tools=new Map(bridge.tools.map(tool=>[tool.name,tool]));
  const call=async(name,args={})=>(await tools.get(name).handler(args)).content[0].text;
  const origin=`http://127.0.0.1:${site.address().port}`;
  await call('browser.tabs',{action:'new',url:origin+'/source'});
  // A fresh Firefox profile may select its first-run privacy tab during startup.
  // Navigate the selected fixture window explicitly, then wait for its document.
  await call('browser.navigate',{url:origin+'/source'});
  await new Promise(r=>setTimeout(r,500));
  const control=JSON.parse(await call('browser.find_control',{origin,name:'Show source',role:'push button'}));
  assert.deepEqual(Object.keys(control).sort(),['found','ref']);
  await call('browser.click',{ref:control.ref}).catch(error=>{throw new Error('Private source action failed: '+error.message)});
  await assert.rejects(call('browser.capture_credential',{sourceOrigin:origin,destinationOrigin:origin,label:'Password'}),/exactly one/);
  const captured=await call('browser.capture_credential',{sourceOrigin:origin,destinationOrigin:origin,label:'Temporary password'});
  assert(!captured.includes(secret));
  const handle=JSON.parse(captured).handle;
  const withheld=await call('browser.snapshot');
  assert.match(withheld,/content is withheld/);assert(!withheld.includes(secret));
  await assert.rejects(call('browser.take_screenshot'),/Screenshots are unavailable/);
  await call('browser.navigate',{url:origin+'/target'});
  await new Promise(r=>setTimeout(r,300));
  const result=await call('browser.fill_credential',{handle,destinationOrigin:origin});
  assert.equal(JSON.parse(result).entered,true);assert(!result.includes(secret));
  let snapshot=await call('browser.snapshot');
  assert.match(snapshot,/password field \[value omitted\]/);assert(!snapshot.includes(secret));
  const button=/push button "Sign In Fixture"[^\n]*\[ref=([^\]]+)\]/.exec(snapshot)?.[1];assert.ok(button,snapshot);
  await call('browser.click',{ref:button});
  snapshot=await call('browser.snapshot');
  assert.match(snapshot,/Credential accepted/);assert.equal(accepted,1);assert(!snapshot.includes(secret));
  await assert.rejects(call('browser.fill_credential',{handle,destinationOrigin:origin}),/absent, expired, consumed/);
  const windows=JSON.parse(await call('browser.windows',{action:'list'}));pid=windows[0].pid;
  receipt=JSON.parse(await fs.readFile(path.join(bridge.agentProfileDir,'.toolsengine-display.json'),'utf8'));
  assert.notEqual(receipt.display,process.env.DISPLAY||':0');
  await assert.rejects(promisify(execFile)('xdotool',['getdisplaygeometry'],{env:{...process.env,DISPLAY:receipt.display,XAUTHORITY:'/dev/null'},timeout:2000}));
  assert.equal(tools.has('browser.transfer_firefox_profile'),true);
  const env=(await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');
  assert(!env.some(value=>value.startsWith('MOZ_DISABLE_CONTENT_SANDBOX=')));
});
