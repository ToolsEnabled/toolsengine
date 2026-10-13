import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('no-browser startup fences debug output before importing the browser library',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'no-browser-fence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const debug=path.join(root,'inherited-debug.txt');
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/toolsengine.js',import.meta.url)),'--workspace',root,'--no-browser'],{cwd:root,input:'',encoding:'utf8',timeout:120000,env:{...process.env,DEBUG:'pw:*',DEBUG_FILE:debug}});
 assert.equal(result.status,0,String(result.stderr).slice(0,300));
 assert.equal(fs.existsSync(debug),false,'inherited debug path must never be opened in no-browser mode');
});
