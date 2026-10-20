import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFirefoxBrowserBridge } from '../src/firefox.js';

test('hidden Firefox types and clicks on its authenticated private display without importing user credentials', {
  timeout:90000,
  skip:process.platform!=='linux' ? 'Firefox mode requires Linux' : process.env.TOOLSENGINE_FIREFOX_LIVE!=='1' ? 'set TOOLSENGINE_FIREFOX_LIVE=1 on a Linux desktop with Firefox, Xvfb, xauth and AT-SPI' : false,
}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'te-firefox-live-'));
  const home=path.join(root,'home'), workspace=path.join(root,'workspace');
  await fs.mkdir(home);await fs.mkdir(workspace);
  const site=http.createServer((_req,res)=>res.end(`<title>Private Firefox fixture</title><label>Note<input aria-label="Note"></label><button onclick="document.getElementById('result').textContent=document.querySelector('input').value">Apply</button><p id="result"></p>`));
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
  await call('browser.tabs',{action:'new',url:`http://127.0.0.1:${site.address().port}`});
  let snapshot=await call('browser.snapshot',{depth:30});
  const field=/entry "Note"[^\n]*\[ref=([^\]]+)\]/.exec(snapshot)?.[1];assert.ok(field, snapshot);
  await call('browser.type',{ref:field,text:'verified private typing'});
  snapshot=await call('browser.snapshot',{depth:30});assert.match(snapshot,/value="verified private typing"/);
  const button=/push button "Apply"[^\n]*\[ref=([^\]]+)\]/.exec(snapshot)?.[1];assert.ok(button);
  await call('browser.click',{ref:button});
  snapshot=await call('browser.snapshot',{depth:30});
  assert.match(snapshot,/paragraph "" value="verified private typing"/);
  const windows=JSON.parse(await call('browser.windows',{action:'list'}));pid=windows[0].pid;
  receipt=JSON.parse(await fs.readFile(path.join(bridge.agentProfileDir,'.toolsengine-display.json'),'utf8'));
  assert.notEqual(receipt.display,process.env.DISPLAY||':0');
  await assert.rejects(promisify(execFile)('xdotool',['getdisplaygeometry'],{env:{...process.env,DISPLAY:receipt.display,XAUTHORITY:'/dev/null'},timeout:2000}));
  assert.equal(tools.has('browser.transfer_firefox_profile'),true);
  const env=(await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');
  assert(!env.some(value=>value.startsWith('MOZ_DISABLE_CONTENT_SANDBOX=')));
});
