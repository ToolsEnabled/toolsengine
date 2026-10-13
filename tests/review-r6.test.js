import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCandidates} from '../installer/install.mjs';
import * as config from '../src/config.js';
test('R6 installer records the selected executable and ignores inherited Windows locations',()=>{
 const profile='C:\\Users\\ToolsEnabled-Dev';const safe='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';const probed=[];
 const result=browserCandidates({platform:'win32',profile,env:{ProgramFiles:'Z:\\inherited',LOCALAPPDATA:'Z:\\inherited',PLAYWRIGHT_BROWSERS_PATH:'Z:\\inherited'},exists:p=>{probed.push(p);return p===safe;},chromiumRevision:'1247'});
 assert.deepEqual(result[0].args,['--browser-executable',safe]);assert.ok(probed.every(p=>!p.startsWith('Z:')));
});
test('R6 runtime fences browser lookup and debug variables before library import',()=>{
 assert.equal(typeof config.configureBrowserEnvironment,'function');
 const env={LOCALAPPDATA:'Z:\\inherited',PROGRAMFILES:'Z:\\inherited',PLAYWRIGHT_BROWSERS_PATH:'Z:\\inherited',npm_config_playwright_browsers_path:'Z:\\inherited',PWDEBUG:'1',DEBUG_FILE:'Z:\\log'};
 config.configureBrowserEnvironment({env,platform:'win32',profile:'C:\\Users\\ToolsEnabled-Dev'});
 assert.equal(env.LOCALAPPDATA,'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local');
 assert.equal(env.PLAYWRIGHT_BROWSERS_PATH,'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\ms-playwright');
 assert.equal(env.npm_config_playwright_browsers_path,undefined);assert.equal(env.PWDEBUG,undefined);assert.equal(env.DEBUG_FILE,undefined);
});
