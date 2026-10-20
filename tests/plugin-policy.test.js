import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolsEngine} from '../src/server.js';
import {parseConfig} from '../src/config.js';
import {restrictPluginTools} from '../src/plugin-policy.js';

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
